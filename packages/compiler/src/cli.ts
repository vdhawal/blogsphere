#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { compile } from "./pipeline.js";

const program = new Command();

program
  .name("blogspace")
  .description("Compile a blog space into static HTML")
  .version("0.0.1");

program
  .command("compile")
  .description("Compile a blog space at <path> into HTML or a zip")
  .argument("<spaceDir>", "path to the blog space directory")
  .option("-o, --out <dir>", "output directory", "./dist")
  .option("-f, --format <fmt>", "output format: dir | zip | both", "zip")
  .action(async (spaceDir: string, opts: { out: string; format: string }) => {
    const absSpace = resolve(spaceDir);
    const absOut = resolve(opts.out);
    const format: "dir" | "zip" | "both" =
      opts.format === "dir" ? "dir" : opts.format === "both" ? "both" : "zip";
    console.log(pc.dim(`compiling ${absSpace} → ${absOut} (${format})`));
    const t0 = Date.now();
    try {
      const result = await compile({ spaceDir: absSpace, outDir: absOut, format });
      const ms = Date.now() - t0;
      console.log(pc.green("✓"), `compiled in ${ms}ms`);
      if (result.dirPath) console.log(`  dir:    ${pc.cyan(result.dirPath)}`);
      if (result.zipPath) console.log(`  zip:    ${pc.cyan(result.zipPath)}`);
      console.log(`  pdf:    ${pc.cyan(result.pdfPath)}`);
      const incremental =
        result.chaptersReused > 0
          ? ` (${result.chaptersRendered} rendered, ${result.chaptersReused} reused from cache)`
          : ` (${result.chaptersRendered} rendered)`;
      console.log(`  chapters: ${result.chaptersWritten}${incremental}`);
      const imageDetails: string[] = [];
      if (result.imagesManifestServed) imageDetails.push(`${result.imagesManifestServed} from manifest`);
      if (result.imagesReusedFromCache) imageDetails.push(`${result.imagesReusedFromCache} reused`);
      if (result.imagesRegenerated) imageDetails.push(`${result.imagesRegenerated} regenerated`);
      const imageSuffix = imageDetails.length ? ` (${imageDetails.join(", ")})` : "";
      console.log(
        `  images: ${result.imagesProcessed} source → ${result.variantsWritten} variants${imageSuffix}`,
      );
      console.log(`  pdf: ${(result.pdfBytes / 1024).toFixed(1)} KB${result.pdfRendered ? " (rendered)" : " (reused from cache)"}`);
      if (result.bytesWritten > 0) {
        console.log(`  zip size: ${(result.bytesWritten / 1024).toFixed(1)} KB`);
      }
      if (result.warnings.length > 0) {
        console.log(pc.yellow(`  ${result.warnings.length} warning(s):`));
        for (const w of result.warnings) console.log(pc.yellow(`    · ${w}`));
      }
    } catch (err) {
      console.error(pc.red("✗ compile failed:"));
      console.error(pc.red((err as Error).message));
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
