/** Replace wikilink / chapter-link targets when a chapter slug changes. */
export function replaceChapterSlugReferences(text: string, fromSlug: string, toSlug: string): string {
  if (fromSlug === toSlug) return text;
  let out = text;
  out = out.replaceAll(`[[${fromSlug}]]`, `[[${toSlug}]]`);
  out = out.replaceAll(`[[${fromSlug}|`, `[[${toSlug}|`);
  out = out.replaceAll(`[[${fromSlug}#`, `[[${toSlug}#`);
  out = out.replaceAll(`to=${fromSlug}`, `to=${toSlug}`);
  for (const prefix of [`assets/${fromSlug}/`, `./assets/${fromSlug}/`]) {
    const next = prefix.replace(fromSlug, toSlug);
    out = out.replaceAll(prefix, next);
  }
  for (const prefix of [`assets/.variants/${fromSlug}/`, `./assets/.variants/${fromSlug}/`]) {
    const next = prefix.replace(fromSlug, toSlug);
    out = out.replaceAll(prefix, next);
  }
  return out;
}
