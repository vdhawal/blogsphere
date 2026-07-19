import { stat } from "node:fs/promises";
import { chromium, type Browser } from "playwright";

/**
 * Render an HTML file on disk to a PDF on disk using headless Chromium.
 *
 * The Chromium binary is shared with `@playwright/test` (same cache at
 * `~/Library/Caches/ms-playwright/`), so authors who already ran
 * `npx playwright install chromium` for the e2e suite don't need a
 * second download. If no binary is found, Playwright will tell us via
 * a clear error from `chromium.launch()`.
 *
 * Browser launch + navigation + PDF emit adds ~2–4s per compile. We
 * relaunch per call rather than keeping a persistent browser instance
 * across compiles because (a) the simpler lifecycle avoids leaks if
 * the compile process exits abnormally and (b) the cost is acceptable
 * for the once-per-publish cadence the PDF is intended for.
 */
export async function renderHtmlToPdf(args: {
  htmlPath: string;
  pdfPath: string;
}): Promise<{ bytes: number }> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    // `file://` lets Chromium resolve relative paths inside the dist tree
    // (image variants, static maps, etc.) without any HTTP server.
    await page.goto(`file://${args.htmlPath}`, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    await page.pdf({
      path: args.pdfPath,
      format: "A4",
      printBackground: true,
      margin: { top: "1in", right: "0.75in", bottom: "1in", left: "0.75in" },
      preferCSSPageSize: true,
    });
    await context.close();
  } finally {
    if (browser) await browser.close();
  }
  const stats = await stat(args.pdfPath);
  return { bytes: stats.size };
}
