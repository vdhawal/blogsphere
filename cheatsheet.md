# Blogspace Command Cheatsheet

This cheatsheet covers the commands to run the editor, compile individual blogs, and export the entire multi-blog sphere.

---

## 1. Running the Editor

The editor consists of a Fastify backend server and a Vite/React frontend. Open two terminal instances in the repository root:

### Terminal 1: Backend Server
Since the root script uses Unix environment variable syntax, run this command on Windows:
```powershell
$env:BLOGSPACE_WORKSPACE = (Resolve-Path .\fixtures).Path
npm run dev -w @blogspace/server
```
* **Server Port**: `http://127.0.0.1:4317`

### Terminal 2: Editor Frontend
Start the local development server:
```powershell
npm run dev:editor
```
* **Editor Port**: `http://127.0.0.1:4318`

---

## 2. Compiling an Individual Blog (via CLI)

Compile any specific blog space directory using the compiler CLI. Incremental caching is fully active at this level (unchanged chapters and assets are skipped to save processing time).

### Compile to a Folder
```powershell
npx tsx packages/compiler/src/cli.ts compile fixtures/bharat-bhraman --out dist/bharat-bhraman --format dir
```

### Compile to a ZIP Archive
```powershell
npx tsx packages/compiler/src/cli.ts compile fixtures/bharat-bhraman --out dist --format zip
```

### Compile Both (Folder, ZIP, and PDF Chat Context Sibling)
```powershell
npx tsx packages/compiler/src/cli.ts compile fixtures/bharat-bhraman --out dist --format both
```

---

## 3. Exporting the Entire Blog Sphere

Compiling the multi-blog landing page (`index.html`) along with all selected subfolders is coordinated by the server.

### Method A: Via the Editor UI
1. Open the editor UI at `http://localhost:4318/`.
2. Click **Export** in the top bar.
3. Check the boxes for the blogs you want to export (e.g. `bharat-bhraman`, `book-reviews`, `movie-reviews`).
4. Click **Export Selected**.

### Method B: Programmatically via Terminal
Run the following PowerShell command while the backend server is running:
```powershell
$body = '{"spaceIds":["bharat-bhraman","book-reviews","morocco-2026","movie-reviews"]}'
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4317/api/export" -Headers @{ "Content-Type" = "application/json" } -Body $body
```

* **Export Location**: `fixtures/export/`
* **Static ZIP Archive**: `fixtures/export.zip`
