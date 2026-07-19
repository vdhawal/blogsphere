import jsonpatch from "fast-json-patch";
import type { ChangeDelta, JsonPatchOp } from "./types.js";

/**
 * Apply a CodeMirror-6 ChangeSet.toJSON() delta to a string.
 *
 * Throws if any step walks past the end of the input — that indicates a
 * version mismatch and the server must reject the edit.
 */
export function applyTextDelta(doc: string, delta: ChangeDelta): string {
  let out = "";
  let i = 0;
  for (const step of delta) {
    if (typeof step === "number") {
      if (i + step > doc.length) {
        throw new RangeError(
          `retain past end of doc: pos=${i} retain=${step} len=${doc.length}`,
        );
      }
      out += doc.slice(i, i + step);
      i += step;
    } else if (Array.isArray(step)) {
      const del = step[0];
      if (typeof del !== "number" || del < 0) {
        throw new TypeError(`invalid delete count: ${JSON.stringify(step)}`);
      }
      // Indices 1..end are the inserted lines. Join with "\n" to recover
      // the literal inserted text.
      const lines: string[] = [];
      for (let k = 1; k < step.length; k++) {
        const line = step[k];
        if (typeof line !== "string") {
          throw new TypeError(`invalid insert line at index ${k}: ${JSON.stringify(step)}`);
        }
        lines.push(line);
      }
      const ins = lines.join("\n");
      if (i + del > doc.length) {
        throw new RangeError(
          `delete past end of doc: pos=${i} del=${del} len=${doc.length}`,
        );
      }
      i += del;
      out += ins;
    } else {
      throw new TypeError(`invalid delta step: ${JSON.stringify(step)}`);
    }
  }
  if (i < doc.length) out += doc.slice(i);
  return out;
}

export function validateTextDelta(delta: unknown): delta is ChangeDelta {
  if (!Array.isArray(delta)) return false;
  for (const step of delta as unknown[]) {
    if (typeof step === "number") {
      if (step < 0 || !Number.isFinite(step)) return false;
      continue;
    }
    if (!Array.isArray(step)) return false;
    if (step.length === 0) return false;
    if (typeof step[0] !== "number" || step[0] < 0) return false;
    // All elements after the delete count are inserted line strings.
    for (let i = 1; i < step.length; i++) {
      if (typeof step[i] !== "string") return false;
    }
  }
  return true;
}

/**
 * Apply RFC 6902 patches to a JSON-shaped value. Returns the new value;
 * the input is left untouched (fast-json-patch clones via JSON ops).
 *
 * Throws on any patch failure — the WS layer turns this into an
 * `invalid-edit` error and the client must reload the resource.
 */
export function applyJsonPatches<T>(value: T, patches: JsonPatchOp[]): T {
  const result = jsonpatch.applyPatch(
    jsonpatch.deepClone(value),
    patches,
    /*validateOperation*/ true,
  );
  return result.newDocument as T;
}

export function validateJsonPatches(patches: unknown): patches is JsonPatchOp[] {
  if (!Array.isArray(patches)) return false;
  for (const p of patches) {
    if (typeof p !== "object" || p === null) return false;
    const op = (p as { op?: unknown }).op;
    if (
      op !== "add" &&
      op !== "remove" &&
      op !== "replace" &&
      op !== "move" &&
      op !== "copy" &&
      op !== "test"
    ) {
      return false;
    }
    if (typeof (p as { path?: unknown }).path !== "string") return false;
    if ((op === "move" || op === "copy") && typeof (p as { from?: unknown }).from !== "string") {
      return false;
    }
  }
  return true;
}
