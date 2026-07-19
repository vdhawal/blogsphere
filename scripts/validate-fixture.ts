/**
 * Parses the Morocco fixture and validates it against the schemas.
 * Run with: npx tsx scripts/validate-fixture.ts
 *
 * This isn't a test suite — it's a smoke check that the schemas and the
 * sample fixture haven't drifted apart while we iterate on either. The
 * compiler (step 2) will absorb this logic properly with diagnostics.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import matter from "gray-matter";
import {
  seriesSchema,
  chapterFrontmatterSchema,
  workspaceConfigSchema,
} from "../packages/schemas/src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "..", "fixtures", "morocco-2026");

function loadYaml(path: string): unknown {
  return yaml.load(readFileSync(path, "utf8"));
}

function validate(label: string, schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown; data?: unknown } }, value: unknown): boolean {
  const result = schema.safeParse(value);
  if (result.success) {
    console.log(`  ✓ ${label}`);
    return true;
  }
  console.error(`  ✗ ${label}`);
  console.error(JSON.stringify(result.error, null, 2));
  return false;
}

let ok = true;

console.log("series.yaml");
ok = validate("series", seriesSchema, loadYaml(join(FIXTURE, "series.yaml"))) && ok;

console.log("\n.blogspace/config.yaml");
ok = validate("workspace config", workspaceConfigSchema, loadYaml(join(FIXTURE, ".blogspace/config.yaml"))) && ok;

console.log("\nchapter frontmatter");
const chaptersDir = join(FIXTURE, "chapters");
for (const file of readdirSync(chaptersDir).filter((f) => f.endsWith(".md")).sort()) {
  const { data } = matter(readFileSync(join(chaptersDir, file), "utf8"));
  ok = validate(file, chapterFrontmatterSchema, data) && ok;
}

if (!ok) {
  console.error("\nFixture failed validation.");
  process.exit(1);
}
console.log("\nAll fixture files conform to schema.");
