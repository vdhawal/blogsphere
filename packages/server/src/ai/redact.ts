/**
 * Deterministic privacy backstop for AI output.
 *
 * The system prompts already instruct the model to refer to protected
 * people generically and never to name them. This module is the
 * belt-and-braces layer that runs AFTER generation so a model that
 * ignores the instruction can still never leak a redacted name into
 * machine-generated metadata or chat. It is intentionally dumb and
 * deterministic — no model in the loop.
 *
 * Matching rules:
 *   - case-insensitive
 *   - word-boundary'd, so an unrelated word that merely contains the
 *     token is left alone
 *   - a trailing possessive ("'s" / "’s") is swallowed so "Devasya's
 *     bag" → "<replacement>'s bag" reads naturally
 *
 * Names are expected to be single tokens (given names of the author's
 * children). Multi-token targets are matched literally but the streaming
 * redactor only guarantees single-token matches across chunk boundaries
 * (see RedactStream).
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build one case-insensitive, boundary-anchored matcher for all names. */
export function buildRedactRegex(names: string[]): RegExp | null {
  const cleaned = names.map((n) => n.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  // Longest-first so a longer name wins over a shorter prefix match.
  cleaned.sort((a, b) => b.length - a.length);
  const alt = cleaned.map(escapeRegExp).join("|");
  // \b…\b boundary plus an optional possessive suffix.
  return new RegExp(`\\b(?:${alt})(?:['’]s)?\\b`, "giu");
}

/** Replace every redacted name in a free-text string. */
export function redactText(text: string, regex: RegExp | null, replacement: string): string {
  if (!regex || !text) return text;
  return text.replace(regex, replacement);
}

/**
 * Scrub AI-metadata output. `summary` and `topics` are free text and get
 * the replacement; `entities` is a named-entity list, so any entity that
 * still matches a redacted name is dropped entirely rather than rewritten
 * to the placeholder (a placeholder entity is meaningless in a list).
 */
export function redactAiMetadata(
  value: unknown,
  regex: RegExp | null,
  replacement: string,
): unknown {
  if (!regex || value === null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };
  if (typeof obj.summary === "string") {
    out.summary = redactText(obj.summary, regex, replacement);
  }
  if (Array.isArray(obj.topics)) {
    out.topics = obj.topics.map((t) =>
      typeof t === "string" ? redactText(t, regex, replacement) : t,
    );
  }
  if (Array.isArray(obj.entities)) {
    out.entities = obj.entities.filter(
      (e) => !(typeof e === "string" && regexMatches(regex, e)),
    );
  }
  return out;
}

/** Drop any array entry (e.g. a tag) that matches a redacted name. */
export function redactStringArray(
  values: unknown,
  regex: RegExp | null,
): string[] {
  if (!Array.isArray(values)) return [];
  const strings = values.filter((v): v is string => typeof v === "string");
  if (!regex) return strings;
  return strings.filter((v) => !regexMatches(regex, v));
}

function regexMatches(regex: RegExp, s: string): boolean {
  // lastIndex must be reset between .test() calls on a /g/ regex.
  regex.lastIndex = 0;
  return regex.test(s);
}

/**
 * Streaming redactor for chat. Tokens arrive in arbitrary chunks, so a
 * protected name can be split across two chunks ("Dev" + "asya"). We
 * buffer until a whitespace boundary — a single-token name can never
 * contain whitespace — then redact and release the completed portion,
 * holding back the trailing partial word for the next chunk. `flush()`
 * drains whatever remains at end-of-stream.
 */
export class RedactStream {
  private buf = "";
  constructor(
    private readonly regex: RegExp | null,
    private readonly replacement: string,
  ) {}

  /** Feed a chunk; returns the safe-to-emit, already-redacted slice. */
  push(chunk: string): string {
    if (!this.regex) return chunk;
    this.buf += chunk;
    // Release everything up to and including the last whitespace run;
    // keep the trailing (possibly partial) word buffered.
    const lastWs = Math.max(
      this.buf.lastIndexOf(" "),
      this.buf.lastIndexOf("\n"),
      this.buf.lastIndexOf("\t"),
    );
    if (lastWs < 0) return "";
    const ready = this.buf.slice(0, lastWs + 1);
    this.buf = this.buf.slice(lastWs + 1);
    return redactText(ready, this.regex, this.replacement);
  }

  /** Emit any buffered tail, redacted. Call once when the stream ends. */
  flush(): string {
    if (!this.regex) {
      const tail = this.buf;
      this.buf = "";
      return tail;
    }
    const tail = redactText(this.buf, this.regex, this.replacement);
    this.buf = "";
    return tail;
  }
}
