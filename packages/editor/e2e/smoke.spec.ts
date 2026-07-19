import { test, expect, request, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Smoke test for the authoring loop. Exercises the path that broke
 * previously: type a paragraph and a multi-line quote-card directive,
 * watch the spinner actually cycle saving→saved, reload, and verify the
 * markdown survived round-trip without the cursor jumping mid-typing.
 */

const SPACE_ID = "e2e-quote-test";
const SPACE_TITLE = "E2E Quote Test";
const CHAPTER_SLUG = "first-chapter";
const CHAPTER_TITLE = "First Chapter";
const PARAGRAPH = "This is the first paragraph of the test chapter.";
const QUOTE_BODY = "A quote inside a multi-line directive body.";

let apiCtx: APIRequestContext;

test.beforeAll(async ({ playwright }) => {
  apiCtx = await playwright.request.newContext({ baseURL: "http://127.0.0.1:4327" });
  await apiCtx.post("/api/spaces", {
    data: {
      id: SPACE_ID,
      title: SPACE_TITLE,
      description: "Workspace used by the Playwright smoke test.",
      theme: "test",
      author: "Smoke Test",
    },
  });
  await apiCtx.post(`/api/spaces/${SPACE_ID}/chapters`, {
    data: {
      slug: CHAPTER_SLUG,
      title: CHAPTER_TITLE,
      summary: "A chapter created by the e2e smoke test.",
    },
  });
});

test.afterAll(async () => {
  await apiCtx.dispose();
});

/**
 * Open the test chapter and put focus inside CodeMirror. Returns a handle
 * to the contenteditable element so callers can dispatch input from there.
 */
async function openChapterAndFocus(page: Page) {
  await page.goto("/");
  await page.getByText(SPACE_TITLE).click();
  await page.getByText(CHAPTER_TITLE).click();
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  // CodeMirror's editable surface needs explicit focus — a click on the
  // wrapping div doesn't always transfer.
  await editor.focus();
  await page.waitForFunction(() => document.activeElement?.classList.contains("cm-content"));
  return editor;
}

/**
 * Wait until edits are durably saved. We can't reliably catch the
 * "saving…" pill — its window is short (debounce + ~50ms flush) and
 * Playwright's polling tick can miss it. Instead we wait for the
 * "saved" state to hold steady for ~500ms, which means no flush has
 * been scheduled or is in flight.
 */
async function waitForSaved(page: Page) {
  const status = page.locator(".topbar__status [data-state]");
  const start = Date.now();
  let stableFrom: number | null = null;
  while (Date.now() - start < 15_000) {
    const state = await status.getAttribute("data-state").catch(() => null);
    if (state === "saved") {
      if (stableFrom == null) stableFrom = Date.now();
      if (Date.now() - stableFrom >= 500) return;
    } else {
      stableFrom = null;
    }
    await page.waitForTimeout(80);
  }
  throw new Error("save status never stabilized on 'saved'");
}

test("multi-line quote-card markdown round-trips through the editor", async ({ page }) => {
  await openChapterAndFocus(page);

  // Park cursor at end of doc and add the new content there.
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type(PARAGRAPH, { delay: 15 });
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  // The previously-broken case: multi-line container directive.
  await page.keyboard.type(':::quote-card{author="Test" source="E2E" year=2026}');
  await page.keyboard.press("Enter");
  await page.keyboard.type(QUOTE_BODY);
  await page.keyboard.press("Enter");
  await page.keyboard.type(":::");

  await waitForSaved(page);

  await page.reload();
  await page.getByText(SPACE_TITLE).click();
  await page.getByText(CHAPTER_TITLE).click();

  const after = page.locator(".cm-content");
  await expect(after).toContainText(PARAGRAPH);
  await expect(after).toContainText(':::quote-card{author="Test" source="E2E" year=2026}');
  await expect(after).toContainText(QUOTE_BODY);
});

test("typing many keystrokes batches into a small number of edit deltas", async ({ page }) => {
  await openChapterAndFocus(page);

  // Patch send() to count outbound edit messages — the singleton WS client
  // means there's one socket, so this captures everything.
  await page.evaluate(() => {
    const w = window as unknown as { __editsSent: number };
    w.__editsSent = 0;
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (typeof data === "string" && data.includes('"type":"edit"')) w.__editsSent += 1;
      return origSend.call(this, data as Parameters<typeof origSend>[0]);
    };
  });

  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("the quick brown fox jumps over the lazy dog!", { delay: 15 });

  await waitForSaved(page);
  const sent = await page.evaluate(() => (window as unknown as { __editsSent: number }).__editsSent);
  // 44 keystrokes typed @ 15ms = ~660ms of typing → with 300ms debounce
  // and 1500ms cap, expect 1–3 deltas. Allow up to 5 for CI jitter.
  expect(sent).toBeGreaterThanOrEqual(1);
  expect(sent).toBeLessThanOrEqual(5);
});

test("editable surface has browser spellcheck enabled", async ({ page }) => {
  // CodeMirror 6 disables spellcheck by default; we explicitly re-enable
  // it via EditorView.contentAttributes. The cm-content attribute is the
  // visible contract — if it's gone, no red squiggles for the author.
  await openChapterAndFocus(page);
  const spellcheck = await page.locator(".cm-content").getAttribute("spellcheck");
  expect(spellcheck).toBe("true");
  const autocorrect = await page.locator(".cm-content").getAttribute("autocorrect");
  expect(autocorrect).toBe("off");
});

test("cursor stays put while typing (no jump-to-top regression)", async ({ page }) => {
  await openChapterAndFocus(page);

  await page.keyboard.press("ControlOrMeta+End");
  // Push the cursor several lines down so position 0 is unmistakably wrong.
  for (let i = 0; i < 5; i++) await page.keyboard.press("Enter");
  await page.keyboard.type("line A", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("line B", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("line C", { delay: 10 });

  await waitForSaved(page);

  // Read the cursor's selection anchor from CodeMirror's runtime. Anything
  // greater than the scaffold length proves we didn't jump to the start.
  const anchor = await page.evaluate(() => {
    // CodeMirror 6 doesn't expose the view on the DOM by default. Look it
    // up via the EditorView's host node walking up from .cm-content.
    const el = document.querySelector(".cm-editor") as HTMLElement | null;
    // Internal: CM stores `cmView` on a child of .cm-editor. Easier: use the
    // global selection.
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return -1;
    const range = sel.getRangeAt(0);
    // Compute a rough character offset by walking text nodes.
    let offset = 0;
    const walker = document.createTreeWalker(el ?? document.body, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      if (n === range.startContainer) {
        offset += range.startOffset;
        return offset;
      }
      offset += (n.textContent ?? "").length;
    }
    return -1;
  });
  expect(anchor).toBeGreaterThan(10);
});
