# Blogspace — Agent guide

This repository was built and is maintained by AI agents working with a
single human author. This document is the durable contract between past
and future iterations. Read it before making non-trivial changes; update
it when you make decisions that future agents need to know about.

The companion file [CLAUDE.md](CLAUDE.md) is a thin Claude-specific pointer
that defers here for substance.

## What this project is

A two-part authoring platform for connected blog series — think a travel
or food blogger who writes themed multi-chapter "spaces" rather than
single posts.

- **Authoring webapp** — local, single-user, will become multi-tenant SaaS
  later. The author writes markdown chapters, uploads images and videos,
  and edits structured metadata (frontmatter, series.yaml) through a UI.
- **Compiler** — turns a blog space into a static HTML zip that drops on
  any CDN. Responsive images via `<picture>`/`srcset`, video with
  multiple `<source>` resolutions, full SEO (OpenGraph, JSON-LD, sitemap),
  AI-friendly manifests (`llms.txt`, `llms-full.txt`).
- **Viewer** — vanilla JS that ships with the compiled output. Chapter
  navigation, wikilink hover previews, click-to-make-interactive maps.
  Chat-with-blog is reserved for a future step but the embedding index
  has a hook point already.

The reader's experience must work fully without JavaScript (HTML is
authoritative); JS is progressive enhancement only.

## Workspace shape

This is an npm-workspaces monorepo. Each package owns one concern.

```
packages/
  schemas/     zod schemas for everything persistent (single source of truth)
  media/       sharp + ffmpeg image/video processing primitives
  compiler/    markdown → static HTML zip pipeline
  server/      Fastify HTTP + WebSocket backend for the editor
  editor/      React + Vite frontend (CodeMirror 6, TanStack Query)
fixtures/
  morocco-2026/  sample blog space used by manual tests and the compiler fixture
scripts/
  validate-fixture.ts     parses the fixture against the schemas
  seed-fixture-assets.ts  generates placeholder image/video files for the fixture
```

Dependency direction (no cycles):

```
schemas ← media ← compiler ← server
                ↑           ↑
                └───────────┴── editor (frontend types are hand-mirrored)
```

The editor doesn't import from `@blogspace/*` packages — Vite bundles
would balloon. Editor types are hand-mirrored from the schemas. Keep
them in sync when you change a schema.

## On-disk format

A **workspace** is a directory containing **blog spaces**. Each space is
a self-contained, git-friendly tree:

```
my-space/                            # the blog space root
  series.yaml                        # series metadata + ordered chapter slugs
  chapters/
    01-arrival.md                    # frontmatter (YAML) + markdown body
    02-the-market.md
    03-leaving.md
  assets/
    01-arrival/                      # author-uploaded originals (per chapter)
      rooftop.jpg
      walk.mp4
    .variants/                       # pre-generated derivatives (server-managed)
      01-arrival/
        rooftop-320.avif
        rooftop-320.webp
        rooftop-320.jpg
        ...                          # 4–5 widths × 3 formats per image
        rooftop-poster.jpg           # videos get a poster frame
        rooftop-1280.mp4             # and a 1280w h264 downscale
  .blogspace/
    config.yaml                      # per-space author preferences (LLM choice)
    assets.yaml                      # asset manifest — single source of truth
                                     # for what variants exist on disk
    preview/<spaceId>/               # compile output cache (served by Fastify)
```

The author **never** hand-edits the YAML files. All structured edits flow
through the editor UI as JSON-Patch operations over WebSocket.

## Architecture decisions

These are the non-obvious calls. Each decision is here because the
alternative was considered and rejected; preserve the reasoning unless
you have a concrete reason to change it.

### Filesystem is the database

No SQLite, no Postgres. The space directory IS the model. Pros:
git-friendly, hand-inspectable, exports for free, easy backup. Con:
no cross-space search. We'll add an index later if it bites; not now.

### Single-writer assumption

There is no collaborative editing in v1, and no plan for it. This lets
us skip CRDTs and OT entirely. The protocol assumes the client is the
sole writer of any resource. If two browser tabs ever open the same
chapter, the second one will eventually hit a `version-mismatch` and
resync from server — acceptable for the SaaS case where each author
edits one tab at a time.

### Two delta encodings, one message

The WebSocket carries two kinds of edits behind one `edit` message:

- **Text deltas** (`edit.kind: "text"`) for free-form prose. Encoded as
  CodeMirror 6's `ChangeSet.toJSON()`. The format is positional, lossless,
  and what CodeMirror produces natively.
- **JSON patches** (`edit.kind: "json"`) for structured data — chapter
  frontmatter and `series.yaml`. RFC 6902 operations like `move`/`add`/
  `replace`/`remove` against the parsed object. Chapter reorder is one
  `move` op, not a full array re-send.

Each resource has its own version counter and ack channel.

### Server acks ONLY after disk flush

The spinner contract: "saving…" stays on until the bytes are durably
persisted. The server applies deltas in memory, debounces a disk write
50ms, and only emits the `ack` after `writeFile` completes. Closing the
browser tab when no spinner is visible is genuinely safe.

### No in-memory eviction

The server keeps chapter/series state alive in memory for the lifetime
of the process. Was tempting to evict on close, but the side effects
were nasty: React StrictMode's double-mount cycle briefly drops sub
count to zero → state evicted → version reset to 0 → next delta from
client hits `version-mismatch` → editor force-resyncs → cursor jumps
to top. For a single-user local app, memory bound is "chapters touched
this session" — trivial. SaaS will need a TTL eviction with a fresh
version-rebase mechanism; not now.

### Assets are processed on upload, not at compile time

Earlier versions did image variant generation inside the compiler. Now
the server processes each upload through `@blogspace/media` and records
every variant in `<space>/.blogspace/assets.yaml`. The compiler reads
the manifest and copies variants verbatim. Wins:

- Asset picker UI can show thumbnails without running the full compiler
- Compile becomes near-instant for repeat builds
- Variants are authoritative bytes, not a derived cache
- Adding new formats/widths only re-runs new uploads, not the whole space

**Upload is non-blocking.** The upload API saves the original, writes a
`processingStatus: pending` manifest stub, and enqueues a background job
(`AssetProcessingQueue` — single worker, in-process). The editor polls
`/api/spaces/:id/media/status` and opens the **Media** panel for per-asset
encoding details. When the job finishes the manifest entry flips to
`ready` with the full variant ladder.

**Videos always get a web fallback.** iPhone `.MOV` uploads are HEVC/HDR.
`processVideo` always emits a `{stem}-web.mp4` (H.264 SDR, tonemapped when
HDR) with `role: web`, while keeping the original as `role: source`. Web
encodes step through a compression ladder until the output fits Cloudflare
Pages' **25 MB per-file limit** (target ≤ 24 MB). The compiler still lists
`<source>` elements widest-first so Safari keeps HDR and Chrome/Firefox fall
through to the web MP4.

**Export/preview safety net.** Both call `ensureSpaceAssetsReady` before
compile: drain the queue, then `ensureAssetVariants` re-runs processing
for any referenced asset that's incomplete (missing responsive image
variants, missing web MP4, missing poster, variant files absent on disk).
This repairs legacy uploads like a MOV-only `zipline.mov` without a
one-off script.

The compiler retains a **fallback path** that runs `@blogspace/media` at
compile time for images not in the manifest. Useful for hand-seeded
fixtures and the migration window where existing spaces predate the
manifest. Videos do not compile-time transcode — the ensure step owns that.

**Editor-side raw asset access.** The server exposes
`GET /api/workspace-asset/:spaceId/*path` which streams a file from
within the space directory. Used by `AssetPicker` and the cover image
preview in `FrontmatterPanel` to render real `<img>` thumbnails (the
smallest jpeg variant from the manifest, or the source path as a
fallback). Path-traversal-guarded via `path.relative` + a round-trip
resolve check; rejects `..`, absolute paths that escape, and non-files.
There is no directory listing — the editor knows what to ask for via
the asset manifest.

### Pre-rendered static maps with click-to-interactive

Maps ship as SVG placeholders (or, when keys are wired, server-rendered
PNG via Mapbox/Maptiler). The viewer's runtime fetches Leaflet on
demand only when the user clicks "Interactive map". Keeps every page
fully readable without JS and doesn't bake a tile-service dependency
into the zip.

### Incremental compile with stable pretty URLs + HTTP-header cache-busting

The compiler keeps a per-space build cache at
`<space>/.blogspace/build-cache.yaml` that records, for every chapter, a
**source hash** (frontmatter + body) and a **render-deps hash**. On a
re-compile the deps hash is recomputed and compared against the cached
one — when they match AND the previously-written HTML still exists,
the chapter is skipped and the existing file stays in place.

Render-deps hash inputs for chapter N:

- N's own source hash
- `series.yaml` source hash (changes affect every chapter's header
  chrome and chapter-list nav)
- prev/next neighbor source hashes (their titles appear in N's nav
  footer)
- inbound chapter source hashes (chapters that link TO N — their
  titles appear in N's "Referenced from" backlinks)
- outbound chapter-link target source hashes (N's chapter-link card
  directives embed the target's title/summary/cover)
- compiler version (bumped when rendering logic changes)

This is wider than "just neighbors" but it's the correct semantic
dependency set; the user's specific example (a neighbor change forces
re-render) is one consequence of it. Editing one chapter in the middle
of a series cascades to its two neighbors. Editing series.yaml
cascades to everything.

The render-deps hash is **purely a cache key** — it decides reuse, and
nothing else. It is NOT in the URL. Chapter HTML lives at the stable
`chapters/<slug>.html`, and the URL never changes when a chapter's
content does. All internal references — chapter-link cards, wikilinks,
prev/next nav, sitemap, RSS, llms.txt, manifest.json, JSON-LD — use this
stable filename. The graph carries `outputFilename` (`<slug>.html`) per
node so every renderer agrees; `buildGraph` no longer needs a filename
map (the name is derivable from the slug), so the compiler builds the
graph once instead of the old provisional-then-final two-step.

**Why stable URLs, not content-hashed URLs.** An earlier design baked
the render-deps hash into the filename (`<slug>.<hash10>.html`) for
cache-busting. That churned a chapter's public URL on every edit, which
breaks external links, re-surfaces RSS items as new, loses
search-engine link equity, and means each edit 404s the old URL. We
switched to stable URLs and moved cache-busting to the HTTP layer:

- The compiler emits a Cloudflare Pages `_headers` file
  (`renderHeaders` in `render/feeds.ts`). HTML is served
  `Cache-Control: public, max-age=0, must-revalidate` so the browser
  *always* revalidates — it sends `If-None-Match`/`If-Modified-Since`
  and Cloudflare returns a cheap `304` when the bytes are unchanged, or
  the new HTML when they changed. A stale chapter is never served, and
  the URL stays put forever.
- Asset variants under `/assets/*` are `max-age=31536000, immutable`.
  Their names are width/format-keyed and Cloudflare snapshots each
  deploy, so returning visitors reuse them for free. Caveat documented
  in `renderHeaders`: re-uploading a *different* image to the same
  source path reuses the variant filename, so a year-cached client
  could see old bytes until TTL lapses — fix is content-hashed variant
  names if it ever matters.
- `404.html` and a generated `favicon.svg` are emitted at the root;
  Cloudflare Pages serves `404.html` automatically for unknown paths.

`_headers` is inert on hosts that don't read it (it's just a plain
file), so the output stays a portable static bundle.

Orphan cleanup: at the end of every dir-mode compile, files in
`chapters/` that aren't in the current chapter set (one `<slug>.html`
per chapter) are removed (`pruneOrphanChapterFiles`). With stable
filenames this only fires when a chapter is deleted or its slug
changes — a content edit overwrites `<slug>.html` in place.

Bumping the scheme: `COMPILER_VERSION`/`BUILD_CACHE_VERSION` in
`cache.ts` were bumped when this landed so old hashed-filename caches
are rejected and every chapter re-renders once onto its pretty URL.

**Asset caching.** Image variants are the most expensive single thing
the compiler does (sharp encoding × widths × formats). They're also
the least likely to change after an upload, so the cache covers them
two ways:

1. *Manifest-served path* (image is in `<space>/.blogspace/assets.yaml`,
   meaning the server already pre-generated variants at upload time):
   for each variant the compiler stats the destination and skips the
   copy when `dst.size === manifest.variant.bytes`. Real-author
   workflow goes through here.
2. *Runtime-fallback path* (image not in manifest — fixture-seeded or
   pre-manifest assets): the source file is hashed; if the hash
   matches the previous build-cache entry AND every recorded variant
   file is still on disk at the recorded byte size, the cached
   `ProcessedImage` is reused verbatim. No sharp run, no file writes.

The build-cache schema's `assets: Record<sourceRef, CachedImageEntry>`
holds the runtime-fallback metadata. Assets no longer referenced this
compile drop out of the next cache automatically.

Verified speedups on the Morocco fixture:

```
Cold compile (no cache):         6.5s
Warm cache hit (zero changes):   67ms       ← 100× faster
Single chapter edit:             1.0s       ← 7× faster
```

Videos use the same skip-if-already-on-disk pattern (manifest-served
variants + passthrough copies). Maps still re-emit unconditionally
because the SVG generation is sub-millisecond — not worth caching.

Zip-mode skips the cache entirely. The staging dir is rebuilt fresh
each invocation because the zip is a single archive that gets re-zipped
end-to-end anyway. Dir mode (which is what preview uses) is where the
incremental wins land.

PDF is gated on `anyChapterChanged` — skipped when every chapter is
reused, saving ~1.5–2s of Playwright launch + render per compile.

### Chat context is a PDF artifact, not a vector index

Chat-with-blog will use a PDF-in-context model rather than RAG. Every
compile generates a single-doc PDF of the entire series (cover, TOC,
all chapters, embedded image variants) which is intended to be
uploaded once per publish to an LLM Files API (OpenAI's Responses API
first; Anthropic's Files API is the same shape). Chat queries
reference that file_id as context. The model reads the PDF natively —
text and images — so it can answer questions about visual content
without needing a separate image-embedding pipeline.

Tradeoff vs RAG: every chat turn pays the full PDF in input tokens.
GPT-5.2's context window handles even multi-chapter blogs, and prompt
caching makes subsequent turns cheap. For sub-50-chapter blogs this is
clearly cheaper to build and maintain than the embedding/chunking/
retrieval machinery RAG demands. We'll revisit if anyone writes a 500-
chapter series.

Implementation lives in:

- `packages/compiler/src/book.ts` — concatenates every chapter into a
  single print-tailored HTML doc (`book.html`) with cover + TOC + page
  breaks. Reuses `renderChapterBody`, so directives serialize the same
  way as on the web.
- `packages/compiler/src/pdf.ts` — renders `book.html` to PDF via
  Playwright's headless Chromium. Adds ~1.5–2s per compile. Browser is
  relaunched per call; revisit only if compile latency becomes a real
  complaint.

Output layout:

- `format: "dir"` → PDF inside the dir at `<outDir>/book.pdf`
- `format: "zip"` → PDF as **sibling** of the zip at
  `<outDir>/<spaceId>.pdf`, deliberately NOT inside the zip (zips are
  the deployable HTML artifact; PDFs are chat context only, would just
  bloat the CDN payload)
- `book.html` stays in every output — it doubles as a printable
  single-page view and is useful for debugging the PDF render

Both the editor server's `/preview/` static mount and the live Python
preview server expose `book.pdf` over HTTP for download/upload. The
topbar's preview badge shows a `pdf` link alongside the `zip` link.

The chat upload + Responses API integration is **not yet built**. The
PDF is being staged now so when the chat hookup lands the artifact is
already there. Next step has these touch points:

- `<space>/.blogspace/config.yaml` adds `chat: { openaiFileId, lastUploadedAt, contentHash }`
- Server publish endpoint uploads PDF, updates config, deletes old file_id
- Server `POST /api/spaces/:id/chat` proxies to Responses API
- Viewer adds a chat panel that streams via SSE

### Export is one-shot dir + zip + pdf to a durable folder

The "Export" button in the editor topbar produces a deliverable triplet
in `<workspace>/export/<spaceId>/`:

```
<workspace>/export/
  <spaceId>/                ← static folder (deployable to a CDN as-is)
    index.html
    chapters/<slug>.html
    assets/.variants/...
    _headers
    404.html
    ...
  <spaceId>.zip             ← zipped static (downloadable archive)
  <spaceId>.pdf             ← chat-context single-doc render
```

The output folder is intentionally named after the blog space's slug,
matching the author's mental model ("morocco-2026 lives in the
morocco-2026 folder"). The PDF is included alongside but excluded from
the zip — the zip is the CDN-uploadable artifact; the PDF is for
chat-with-blog uploads.

Implementation:

- Compiler accepts `format: "both"` which keeps the staging dir as the
  final static output AND writes the zip + PDF as siblings. Build cache
  applies the same way as dir mode, so repeat exports of unchanged
  content take ~1 second (the chapter HTMLs and PDF are reused; only
  the re-zip costs time).
- Server `POST /api/spaces/:id/export` invokes the compiler with
  `format: "both"`, output rooted at `<workspace>/export/`, and returns
  the three absolute paths.
- Editor opens a modal showing the paths with one-click copy + a
  "Show in Finder" button that calls `POST /api/reveal` (`open` on
  macOS, `xdg-open` on Linux, `start` on Windows). The reveal endpoint
  validates the path is within the workspace root to keep a malicious
  client from revealing arbitrary filesystem locations.

Preview and Export share the same build cache. After a preview of
space X, exporting space X takes only the time to re-zip + re-render
the PDF — chapter HTML and image variants are already cached.

### Preview is an explicit start/stop child process, not Fastify static

Earlier versions served compiled output via `@fastify/static` mounted at
`/preview/<spaceId>/`. That route still exists for the zip download, but
the **live preview** now runs as a `python3 -m http.server` child process
spawned on demand, on a free port picked at request time. Reasoning:

- The author gets a real start/stop affordance and can free the port when
  they're done. Previously the preview was always-on as long as the
  editor server ran.
- A separate process is closer to how production hosting will work — the
  compiled output is genuinely self-contained.
- `file://` can't quite host the viewer fully because `fetch('manifest.json')`
  is blocked by browsers under that scheme, so we always need SOME server.
  Python's stdlib http.server is the simplest dependency.

If Python isn't installed, the start request 500s with a clear message
asking the author to install it. We don't fall back to a Node-spawned
server in v1 because the failure mode is loud and the install is
trivial; revisit if it becomes a real problem.

The implementation lives in `packages/server/src/preview.ts`:
`PreviewManager` holds a single active child at any time. Starting a
new preview implicitly stops the previous one. Graceful shutdown of the
editor server kills the child too, so `Ctrl+C`-then-restart doesn't
leak orphaned http.server processes.

The freshly-compiled zip lands at
`<workspace>/.blogspace/preview/<spaceId>.zip` alongside the served
directory, and is downloaded through the editor server's already-mounted
`@fastify/static` route at `/preview/<spaceId>.zip` — not through the
Python child. This keeps the Python server's responsibility narrow: it
hosts the HTML only.

### AI features are server-proxied; keys never reach the browser

API keys live in the **editor server's** process env
(`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`). The browser never sees them.
Every AI call is a JSON POST (or SSE GET) to a server route under
`/api/spaces/:spaceId/ai/*`; the server reads the key from env and calls
the provider SDK on the user's behalf.

What this buys us:
- The author can publish their static space without their key being
  embedded anywhere readable.
- Future multi-tenant SaaS: only the server config changes; the editor
  UI is unchanged. A single edge-proxy key swaps in for the env var.
- Per-space `.blogspace/config.yaml` carries an `ai.endpoints` block so
  the author can route to an Azure / Bedrock / internal-proxy URL
  without touching code.

Provider abstraction (`packages/server/src/ai/types.ts`) exposes four
methods: `generateText`, `vision`, `uploadFile`, `streamChat`. The
Anthropic and OpenAI implementations bridge each provider's API into
the same shape so route handlers don't branch on provider.

The chat-context PDF is **content-hash dedup'd** at every preview /
export. After compile produces `book.pdf`, the server hashes the bytes
(sha256), compares to `<space>/.blogspace/ai-context.yaml`, and only
re-uploads to the Files API when the hash differs. The yaml records
`{provider, pdfHash, fileId, fileSize, uploadedAt, filename}` per
provider — switching providers re-uploads, switching back reuses. The
yaml is bundled into the export directory so the file id travels with
the published space.

When no key is present in env, `/api/ai/status` returns
`enabled: false` and the editor hides all AI affordances entirely
(no disabled buttons, no teasers). The chat panel renders a single
banner with the env var names instead.

Chat history persists at `<space>/.blogspace/chat-history.yaml`,
bounded to the last 200 messages so the file stays small.

### AI output is voice-shaped and name-redacted at two layers

Two requirements shape every AI-generated string (SEO title/description,
chapter summary, AI metadata summary/topics/entities, tags, and the
chat stream — both editor and viewer):

1. **Author voice, not generic-blog voice.** The shared system prompts
   (`SYSTEM_PROMPT_FRONTMATTER` and `chatSystem` in
   `packages/server/src/ai/prompts.ts`) describe WHO the author is — a
   middle-class Indian living an ordinary happy family life, a good
   citizen exploring his own country, who points out the gap between
   how things are and how they could be to make readers *aware*, in a
   balanced way with **no political affiliation and no partisan side**.
   Generators must summarise from the chapter, stay authentic, and stay
   true to the per-field task. Keep this register if you re-tune prompts.

2. **Child-privacy is enforced at two layers.** The author's minor
   children appear by name throughout the prose, but their names must
   NEVER appear in machine-generated output.
   - *Layer 1 (prompt):* both system prompts carry a non-negotiable,
     highest-priority rule to refer to the children only generically
     ("the kids", "their younger one") and never to name them — this
     overrides even the "list named entities" instruction.
   - *Layer 2 (deterministic backstop):* `packages/server/src/ai/redact.ts`
     scrubs protected names from EVERY output after generation, so a
     model that ignores layer 1 still cannot leak a name. `redactText`
     for free strings, `redactAiMetadata` (drops matching `entities`
     entirely rather than replacing — a placeholder entity is
     meaningless), `redactStringArray` for tags, and `RedactStream` for
     chat (buffers to a whitespace boundary so a name split across SSE
     chunks — "Dev"+"asya" — is still caught; the persisted assistant
     message is the redacted text, never the raw stream).

   The protected names live in per-space config at
   `ai.privacy.redactNames` (`packages/schemas/src/config.ts`,
   `aiPrivacySchema`), with `ai.privacy.redactReplacement` for the
   free-text placeholder (default "our child"). Empty list → no-op
   matcher, so other spaces are unaffected. Matching is
   case-insensitive, word-boundary'd (so "Devasyanagar" is untouched),
   and swallows a trailing possessive. **Names are single tokens** —
   `RedactStream` only guarantees cross-chunk matching for single-token
   names; a multi-word target could split across a whitespace flush.

### LLM provider is per-space, not global

The space's `.blogspace/config.yaml` records which LLM the author wants
for SEO/AI generation. Two providers supported by design:

- **Anthropic** — `ANTHROPIC_API_KEY`, Messages API, default
  `claude-opus-4-7` model id
- **OpenAI** — `OPENAI_API_KEY`, Responses API, default `gpt-5.2` model id

A future "edge proxy" layer will fan out from a single server-side key
once we go multi-tenant. The protocol shape doesn't change.

### SEO / LLM metadata is generated at compile, fed by authored data

The compiler is the single place that assembles consumer-facing metadata.
Two principles: (a) every metadata surface is *derived* from authored
data, never hand-maintained; (b) the AI-generated frontmatter the editor
produces must actually reach the output (it used to be stored and then
ignored).

What each surface now carries:

- **`<head>`** (`render/shell.ts`): canonical (absolute when `site.baseUrl`
  is set), full OpenGraph + Twitter cards including `og:locale`,
  `og:image:width/height`, `og:image:alt`, `twitter:image:alt`,
  `article:author`/`article:section`/`tag`, `theme-color` (light/dark
  matching viewer.css), an SVG favicon, head `rel=prev/next` for chapter
  sequence, and a `robots` directive with
  `max-image-preview:large,max-snippet:-1,max-video-preview:-1`.
- **JSON-LD** (`render/pages.ts`): chapters are `BlogPosting` with
  `author` (Person + `url`/`sameAs`), `publisher` (Organization + logo —
  falls back to author name + series cover so Article rich-result
  eligibility never silently breaks), `wordCount`, `dateModified`,
  `image` as an `ImageObject` with dimensions, and `about` built from the
  AI `topics`. The index emits `CreativeWorkSeries` + a `WebSite` node.
- **`llms.txt` / `llms-full.txt`** (`render/feeds.ts`): now consume the AI
  metadata. Each chapter entry uses the dense `ai.summary` (falling back
  to the card summary) and lists dates, tags, and `ai.topics`;
  llms-full prepends a per-chapter metadata block (dates/tags/topics/
  entities) before the body.
- **`robots.txt`**: explicitly *welcomes* the major AI/search crawlers
  (GPTBot, ClaudeBot, Google-Extended, PerplexityBot, CCBot, …) with named
  `Allow` blocks — this blog wants LLM indexing; flip a line to `Disallow`
  to opt one out. Points at both the sitemap and llms.txt.
- **`sitemap.xml`**: image-sitemap extension (`image:image`) per chapter
  using the cover or fallback first-body image; `lastmod` from
  `updatedAt ?? publishedAt`.
- **`rss.xml`**: GUIDs are **stable, slug-based** (`isPermaLink="false"`),
  decoupled from the URL so a future URL-scheme change can't re-surface
  an item as new in subscribers' readers; `<link>` points at the live
  `<slug>.html`. Adds `dc:creator`, `atom:updated`, `managingEditor`,
  and a channel `<image>`.
- **`404.html`** + **`favicon.svg`** are emitted at the output root.
- **`_headers`**: Cloudflare Pages caching contract — HTML revalidates,
  `/assets/*` immutable for a year, feeds/manifests short-TTL, plus
  `nosniff` + a referrer policy on every path (`renderHeaders`).

**`updatedAt` is server-stamped, not hand-authored.** The whole
freshness chain (footer, `article:modified_time`, JSON-LD `dateModified`,
sitemap `<lastmod>`, RSS `atom:updated`) is fed by `frontmatter.updatedAt`
/ `series.updatedAt`. The editor never sets these — instead `Store`
stamps them at flush time on any real content change (`store.ts`),
WITHOUT bumping the resource version (the editor neither sends nor
displays `updatedAt`, so there's no client-version drift). This is why
`updatedAt` is absent in fixtures but appears the moment a chapter is
edited through the editor.

**`site.baseUrl` gates most off-page SEO.** Without it, canonical/OG URLs
and the sitemap/RSS come out relative (unusable by search/social). It —
plus `publisher`, the default Twitter handle, author `sameAs`, and
`license` — is edited through the **Publishing settings** dialog
(`editor/components/PublishingSettings.tsx`, opened from the topbar),
which writes `series.yaml` over the same series WS resource the sidebar
reorder uses (JSON patches, version-mismatch self-heals via close+reopen).

**Chapter URLs are now stable pretty URLs.** Chapter HTML lives at
`chapters/<slug>.html` and the URL no longer changes when content
changes — cache-busting moved to the HTTP layer via the `_headers`
file (HTML revalidates, assets immutable). See the "Incremental compile
with stable pretty URLs" decision above for the full rationale; this
replaced the earlier content-hashed-filename scheme that churned URLs
on every edit.

### Accessibility is a build-time concern

The compiler emits accessible HTML/CSS; there is no client-side JS that
later rewrites the page for accessibility. This keeps load time and
runtime cost identical for assistive-tech users and everyone else.

Concrete rules in `packages/compiler/static/viewer.css` +
`packages/compiler/src/render/shell.ts`:

- **Skip-to-main link** (`<a class="skip-link" href="#main">`) is the
  first focusable element on every page, visually hidden until focused.
  `<main id="main" tabindex="-1">` so it can receive focus from the
  link. WCAG 2.4.1.
- **`:focus-visible`** outlines use a palette-aware `--focus` blue with
  2px outline + 2px offset, applied to `a`, `button`, and `[tabindex]`.
  Never use `outline: none` without an equivalent indicator. WCAG 2.4.7,
  1.4.11.
- **Color palette** is tuned for AA contrast at 17px body text:
    - Light: `--fg: #1a1714` on `--bg: #fbfaf7` (~14:1)
    - Dark: `--fg: #f3eee4` on `--bg: #14120e` (~14:1)
    - `--muted` is for metadata only — clears AA for normal text but
      not large; do not use for paragraph copy.
- **`prefers-color-scheme`** auto-swaps the palette. `<meta
  name="color-scheme" content="light dark">` advertises support so the
  browser themes form controls and scrollbars to match.
- **`prefers-contrast: more`** opts the user into a near-AAA palette
  (pure black/white, saturated accent, thicker rule borders). Pairs
  with `prefers-color-scheme` for a 2×2 set.
- **`prefers-reduced-motion: reduce`** kills animations, transitions,
  and `scroll-snap-type` on the carousel gallery. Applies via a
  blanket selector to catch any future motion we add.
- **`forced-colors: active`** (Windows High Contrast) — card and nav
  borders explicitly use `CanvasText` so they stay visible when the OS
  overrides our palette. Focus outline uses `Highlight`.
- **Chapter card layout** uses a modifier class
  `.chapter-card--with-cover` so the 2-column (cover | body) grid only
  applies when a cover is present — otherwise the body squeezed into
  the implicit 280px gutter and titles wrapped mid-word.
- **Cover fallback** — if `frontmatter.cover` is unset, the compiler
  uses the chapter's first body image (mdast `image` node, also covers
  galleries). The home page thumbnail still renders without the author
  doing extra work. The editor's cover field placeholder spells this
  out ("auto: first body image"). See `markdown.ts#firstBodyImage`
  and `graph.ts`.

When adding new components: confirm contrast, add a `:focus-visible`
rule that uses `--focus`, gate any motion behind the reduced-motion
query, and verify the layout doesn't collapse without an image.

## WebSocket protocol reference

Endpoint: `GET /ws`. JSON messages, both directions.

### Resources

```ts
type ResourceRef =
  | { kind: "chapter-body";        spaceId: string; slug: string }
  | { kind: "chapter-frontmatter"; spaceId: string; slug: string }
  | { kind: "series";              spaceId: string }
```

### Client → server

```ts
{ type: "open",  resource: ResourceRef }
{ type: "close", resource: ResourceRef }
{ type: "edit",
  resource: ResourceRef,
  fromVersion: number,
  clientSeq: number,
  edit: { kind: "text", changes: ChangeDelta }
      | { kind: "json", patches: JsonPatchOp[] } }
```

### Server → client

```ts
{ type: "opened", resource, content: { kind:"text", text } | { kind:"json", value }, version }
{ type: "ack",    resource, version, clientSeq }     // only after disk flush
{ type: "closed", resource }
{ type: "error",  code: "version-mismatch" | "invalid-edit" | "validation-failed" | …,
                  message, resource? }
```

### Text delta encoding — DON'T GUESS

This caused a multi-day bug. The format is CodeMirror 6's
`ChangeSet.toJSON()` output, which has TWO shapes only:

```
positive number      → retain that many chars
[del, ...lines]      → delete `del` chars, then insert the remaining
                       strings joined with "\n"
```

Multi-line inserts are SPREAD, not nested:

```
[0, "a", "b"]   means insert "a\nb"   (NOT [0, ["a","b"]])
[0, ""]         means insert ""
[3, "x"]        means delete 3, insert "x"
[5]             means delete 5
```

Both the server (`packages/server/src/edits.ts`) and the editor
(`packages/editor/src/types.ts`) must agree. If you find yourself adding
a `string[]` to the InsertText union, you have it wrong — re-read this
section.

### Inflight counter contract

The editor's WS client increments an inflight counter per `edit` sent
and clears it on `ack` OR `error`. If you forget to clear on error, the
spinner sticks on "saving" forever after a rejected edit.

## Build, run, test

All from repo root unless noted.

```
npm install                            # one-time
npm run build                          # build every package's dist/
npm run typecheck                      # tsc --noEmit across the monorepo

# Dev (two terminals)
npm run dev:server                     # Fastify on :4317, workspace = ./fixtures
npm run dev:editor                     # Vite on :4318, proxies /api and /ws

# Compile the fixture into a static zip
cd packages/compiler && npx tsx src/cli.ts compile ../../fixtures/morocco-2026 \
  --out ../../dist --format zip

# E2E smoke test (uses ports 4327/4328 with isolated temp workspace)
cd packages/editor
npx playwright install chromium        # one-time
npm run test:e2e

# Validate the fixture against schemas
npx tsx scripts/validate-fixture.ts

# Seed placeholder image/video files for the fixture
npx tsx scripts/seed-fixture-assets.ts
```

## Code conventions

These are real preferences expressed by the author over the project's
history. Don't drift.

- **TypeScript strict everywhere.** `noUncheckedIndexedAccess: true` and
  `noImplicitAny`. We disable `exactOptionalPropertyTypes` only in the
  compiler/server/editor packages where the optional-vs-undefined
  ceremony cost was too high. Schemas keep it on.
- **Validate at the boundary, trust internally.** All YAML loads and
  WebSocket inputs go through zod. Once inside, types are exact.
- **One-line comments only.** No multi-paragraph docstrings. Write
  comments that explain WHY non-obvious decisions exist, not WHAT the
  code does. Future agents read these as context.
- **No backward-compat shims when a clean refactor is short.** This
  project has no users yet. If a schema change is right, change it and
  rebuild.
- **Atomic file writes.** Every persistent write goes through
  `writeFileAtomic` (write tmp + rename) so a crash mid-flush can't
  truncate the author's work.
- **WebSocket payloads are debug-loggable.** When you add a new message
  type, make sure the existing `app.log.debug({ws: msg})` line in
  `ws.ts` captures it.
- **Tests live next to what they test.** The Playwright suite is at
  `packages/editor/e2e/`. The fixture is reused across REST + WS + UI
  paths so a single fixture-format change can be verified everywhere at
  once.

## Past gotchas (preserve this list)

When you fix a real bug, add an entry here. Future agents avoid
re-discovering them.

- **AI-generated frontmatter must be clamped to schema bounds.** The
  generation prompts only *ask* for short output ("≤60 chars", "5-12
  entities"); models overshoot, especially on longer chapters. The store
  validates the whole patched frontmatter against `chapterFrontmatterSchema`
  on persist, so one over-long field (`seo.title>70`, `seo.description>200`,
  `ai.summary>600`, `ai.topics>15`, `ai.entities>30`) made the ENTIRE save
  fail with `validation-failed`. The editor used to `console.error` that
  silently, so "Generate" looked successful but nothing persisted — and it
  only reproduced on content-rich chapters, not the short intro. Fix:
  `routes.ts` clamps every generated value to the schema cap (`LIMITS` +
  `clampText`/`clampAiMetadata`) before returning, and `FrontmatterPanel`
  now surfaces any non-version-mismatch persist error instead of swallowing
  it. If a schema max changes in `common.ts`/`chapter.ts`, update `LIMITS`.
  AI metadata prompts hard-cap summary at 600 characters and topics at 4
  (`LIMITS.aiTopics`); truncation mid-sentence was losing retrieval context.
- **CM6 multi-line insert format.** Documented above. Both the server
  validator/applier and the editor type model must accept the flat-
  spread format `[del, ...lines]`. We previously crashed any time the
  user pressed Enter.
- **`@codemirror/state` ChangeSet must be composed against the right
  doc length.** When batching deltas (`pending.compose(next)`), `next`'s
  source-doc length must equal `pending.newLength`. Naturally true if
  you compose every transaction in order; subtly wrong if you ever
  drop a transaction.
- **fast-json-patch's `applyPatch` mutates the input by default.** We
  use `deepClone(value)` first so the caller's reference doesn't
  silently change underneath them.
- **js-yaml turns ISO dates into `Date` objects.** The `isoDateSchema`
  in `packages/schemas/src/common.ts` accepts both string and Date and
  normalizes to a string via a zod `transform`. Don't replace it with
  `z.string()` — fixture parses will start failing.
- **Fastify 5 needs Node ≥ 20.** We pinned Fastify to v4 because the
  author's local environment is Node 18.18. If you bump Node, you can
  also bump Fastify and Playwright (which needs ≥ 18.19 at v1.46+).
- **`series.chapters` cannot be `.min(1)`.** A freshly-created space
  has zero chapters until the author makes one through the UI, and the
  "New blog space" flow validates the schema before any chapter exists.
- **No filesystem path can escape the workspace root.** `Workspace`
  methods validate slug formats AND double-check the resolved path is
  inside `root` before any destructive op. Don't bypass these for
  "convenience".
- **Vite proxy must use 127.0.0.1, not localhost.** Node sometimes
  resolves `localhost` to `::1` (IPv6) but the server only binds IPv4.
  Same trap in the smoke test's `ws` client (use `ws://127.0.0.1:…`).
- **H.264 re-encode of HEVC phone videos inflates file size.** iPhone `.MOV` files use HEVC (H.265), which achieves much higher compression than H.264 at the same visual quality. Re-encoding a 20 MB HEVC clip to H.264 at `crf 23 -preset medium` can produce a 28 MB output even after downscaling to 1280w — a 40% increase that blows Cloudflare Pages' 25 MB per-asset limit. The fix is in `packages/media/src/videos.ts`: after generating the downscale, compare `downStat.size` against `sizeBytes` (the source). If the variant is not smaller, delete the file and skip adding it to variants — the compiler will serve the original. The `width > TARGET_WIDTH` spatial guard is a necessary but insufficient condition.
- **HEIC/HEIF inputs need JS-side decoding.** Sharp doesn't ship with
  libheif (HEVC licensing), so `sharp(<heicPath>)` throws "unsupported
  image format" — caught by the resolver and turned into a silent
  warning, leaving an empty `<div class="gallery">`. iPhone photos
  upload as HEIC by default so this hits every author. The fix is in
  `packages/media/src/images.ts`: detect by extension (`.heic`/`.heif`),
  decode via `heic-convert` (libheif compiled to WebAssembly) to a PNG
  buffer, then feed the buffer to the standard sharp pipeline. Variants
  emitted are still AVIF/WebP/JPEG — HEIC never reaches the browser.
  First decode is slow (Wasm init); subsequent same-process decodes
  are fast, and the build cache means HEIC is decoded once per upload.
- **REST chapter create/delete must sync open series WS state.** Chapter
  creation goes through `POST /api/spaces/:id/chapters`, which writes
  `series.yaml` on disk but bypasses the Store. The sidebar's reorder
  buttons use the in-memory series opened over WS (`seriesRef`), so
  immediately after create the REST chapter list shows the new slug but
  reorder patches target stale indices and silently fail (or
  version-mismatch). Fix: `Store.appendSeriesChapter` /
  `removeSeriesChapter` mirror disk and push a fresh `opened` to
  subscribers — same pattern as `patchSeriesChapterSlug` after rename.
- **Workspace/Sphere Index theme integrity.** The index landing page of the blog sphere must always reuse the standard reader theme (`viewer.css`) and layout conventions. Ad-hoc modern visual styles (like glassmorphism, Google Fonts, or unique card structures) must not be introduced for the landing page or any exported assets. The design prioritizes minimal UI, fastest loading times, readability, and WCAG compliance.


## Deferred work (intentionally unbuilt)

Things we've decided NOT to do yet but plan to. Each line is a hook
point already present in the code; the work is the integration.

- **Chat-with-blog.** Compiler already extracts `plainText` per chapter
  for an eventual `search-index.json`. The viewer's `manifest.json`
  preload is the surface that'll hold the embedding index.
- **AI-generated SEO + alt text.** Frontmatter schema has a `generated`
  block with `contentHash` provenance. The plumbing for a "Generate"
  button in the frontmatter panel just needs a server endpoint that
  dispatches to the Anthropic Messages API or OpenAI Responses API per
  the space's `.blogspace/config.yaml`.
- **Real static maps.** `packages/compiler/src/media.ts:renderStaticMap`
  is a stable signature; swap the SVG generator for `fetch(<mapbox or
  maptiler static API>)` when keys are configured. Editor surface for
  setting keys is the natural follow-up.
- **HLS video.** `processVideo` in `@blogspace/media` is already
  ffmpeg-driven; adding an `.m3u8` + segment ladder is a few lines.
  Compiler's `<video>` renderer should add an `application/x-mpegURL`
  source above the MP4 fallback when present.
- **Live preview pane.** Out of scope — author opens preview in a new
  tab via the Preview button instead. The compile endpoint and static
  `/preview/<spaceId>/` hosting are already in place.
- **Per-author / multi-tenant SaaS.** Workspace = author home folder.
  Auth, account, billing — none of it built. The decision points are:
  put workspaces in object storage with a manifest registry, or shard
  by author into separate filesystems. We'll know more when the
  product shape settles.

## When making changes

A few rules that have held up well:

1. **Schemas change → rebuild `@blogspace/schemas`.** The server reads
   from `dist/` (npm workspace symlink). Editor types are hand-mirrored
   — keep them in sync.
2. **Don't introduce a third edit encoding.** Text and JSON cover every
   case. If you're tempted to add a "patch text" or "splice json", step
   back; you almost certainly want a richer JSON Patch or a longer text
   delta.
3. **Don't bypass the inflight counter.** All edit sends increment it,
   all acks AND errors decrement it. Otherwise the spinner lies.
4. **Run the Playwright smoke test after touching the WS protocol or
   the editor's transaction handling.** The three tests catch the
   exact class of regression we hit before: multi-line breakage,
   delta volume, cursor jumps.
5. **Update this document.** If a decision in this file is no longer
   true, edit the section to reflect what's true now AND add an entry
   to "Past gotchas" if the change was driven by a bug.

## Reading the code

Recommended order for a fresh agent:

1. `packages/schemas/src/series.ts`, `chapter.ts`, `assets.ts` — the
   shape of every persistent object
2. `packages/server/src/types.ts` — the WS protocol shape, including
   the resource union and the discriminated edit
3. `packages/server/src/store.ts` — version counters, debounced flush,
   ack draining (this is the heart of the save contract)
4. `packages/server/src/edits.ts` — text delta applier and JSON-Patch
   applier. Re-read the multi-line note above if confused.
5. `packages/editor/src/components/Editor.tsx` — ChangeSet batching,
   the hydrated guard, drag-drop upload
6. `packages/compiler/src/pipeline.ts` — end-to-end compile orchestration
7. `packages/compiler/src/media.ts` — manifest lookup vs runtime fallback

Skim test files for the concrete contract they assert — `e2e/smoke.spec.ts`
is the closest thing to a behavioural spec we have.
