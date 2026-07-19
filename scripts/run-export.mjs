import { compile, zipDirectory, loadBlogSpace, renderWorkspaceIndex } from "@blogspace/compiler";
import { join } from "node:path";
import { rm, mkdir, writeFile } from "node:fs/promises";

async function run() {
  const root = "c:\\Users\\vdhaw\\Documents\\blog\\fixtures";
  const exportRoot = join(root, "export");
  
  console.log("Cleaning export directory...");
  await rm(exportRoot, { recursive: true, force: true });
  await mkdir(exportRoot, { recursive: true });

  const spaceIds = ["bharat-bhraman", "book-reviews", "movie-reviews"];
  const seriesList = [];

  for (const spaceId of spaceIds) {
    const spaceDir = join(root, spaceId);
    const outDir = join(exportRoot, spaceId);
    console.log(`Compiling space: ${spaceId} → ${outDir}...`);
    
    const result = await compile({
      spaceDir,
      outDir,
      format: "dir"
    });
    console.log(`✓ Compiled ${spaceId}: chapters=${result.chaptersWritten}, images=${result.imagesProcessed}`);
    
    // Load series metadata for index rendering
    const space = await loadBlogSpace(spaceDir);
    seriesList.push(space.series);
  }

  console.log("Generating root index.html...");
  const indexHtml = renderWorkspaceIndex(seriesList);
  await writeFile(join(exportRoot, "index.html"), indexHtml, "utf8");

  console.log("Zipping export directory to export.zip...");
  const zipPath = join(root, "export.zip");
  await rm(zipPath, { force: true });
  await zipDirectory(exportRoot, zipPath);
  console.log(`✓ Export complete! Zip archive written to: ${zipPath}`);
}

run().catch(console.error);
