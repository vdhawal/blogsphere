# Claude — read this first

Hi Claude. This project is built and maintained by AI agents — most
recently you. Start by reading [AGENTS.md](AGENTS.md), which is the
authoritative project guide. This file holds the small handful of
Claude-specific notes that don't belong in the universal guide.

## Working agreement with the human

The human author (Vickramaditya Dhawal) drives the product direction; you
drive the implementation. Past sessions have established these
preferences — please respect them.

- **Markdown-first authoring, UI-only YAML editing.** Authors write
  markdown prose. They never hand-edit `series.yaml`,
  `chapters/*.md` frontmatter, or `.blogspace/assets.yaml`. All
  structured changes flow through the editor UI as JSON Patches over
  WebSocket. If you're tempted to ship a YAML-editing affordance,
  re-confirm with the human first.
- **Refactor freely.** No backward-compat shims unless the human
  explicitly asks for one. There are no production users yet.
- **Schemas first.** Every persistent shape lives in
  `@blogspace/schemas`. When something feels under-defined, add a zod
  schema before writing code that consumes the shape.
- **Tests guard the protocol, not the UI.** The Playwright suite at
  `packages/editor/e2e/smoke.spec.ts` exists to catch the exact
  classes of regression that have bitten us:
    1. multi-line text delta encoding,
    2. delta batching,
    3. cursor jumps from over-aggressive doc replacement.
  Don't grow it into a full UI test suite; do extend it when a new
  protocol invariant deserves a guard.

## Coding conventions specific to Claude

These reinforce the universal conventions in AGENTS.md from a
Claude-output perspective.

- Use the **edit / write / read** tools rather than emitting shell
  redirects when changing files.
- Default to **no comments**. The exception is non-obvious WHY:
  schema invariants, protocol contracts, hidden gotchas. The codebase
  is well-commented in this spirit already; match the existing density.
- Don't write **multi-line docstrings**. One-line summaries above
  exported symbols; longer prose belongs in AGENTS.md.
- When the human reports a bug, **find the root cause before patching
  the symptom.** The CM6 multi-line bug took two failed attempts
  because the wire format wasn't checked against CodeMirror's actual
  output. The current AGENTS.md "Past gotchas" section exists so
  future-you doesn't repeat that.
- Run `npm run typecheck` after non-trivial edits. The compiler /
  server / editor packages can be checked individually with
  `npm run typecheck -w @blogspace/<pkg>`.
- Run `npm run test:e2e -w @blogspace/editor` after touching the WS
  protocol, the store, or `Editor.tsx`.

## When unsure

Re-read AGENTS.md's "Architecture decisions" section. If the call you
need to make isn't covered there, default to:

1. The smallest change that resolves the issue cleanly.
2. The choice that keeps the **filesystem authoritative** and the
   **editor as the only writer**.
3. The choice that lets the **author close the tab without losing
   work** (i.e. ack only after disk flush).

Then update AGENTS.md to record what you decided and why.
