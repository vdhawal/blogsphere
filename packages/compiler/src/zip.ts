import { createWriteStream } from "node:fs";
import archiver from "archiver";

export async function zipDirectory(srcDir: string, zipPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    let bytes = 0;
    out.on("close", () => resolve(bytes));
    out.on("error", reject);
    archive.on("error", reject);
    archive.on("end", () => {
      bytes = archive.pointer();
    });
    archive.pipe(out);
    archive.directory(srcDir, false);
    archive.finalize();
  });
}
