import { useMemo, useState } from "react";
import { api } from "../api";
import { useAiStatus } from "../ai";
import type { FactCheckFinding, SpellGrammarSuggestion } from "../types";

/**
 * Lightweight spell + grammar review. Lives as a dialog (not a permanent
 * panel) since it's a one-shot review action — author opens it, runs the
 * pass, accepts/rejects, then closes. Accepting a suggestion mutates the
 * editor body via the supplied `onApply` callback, which the parent uses
 * to substitute the `original` text with `replacement` everywhere it
 * occurs.
 *
 * Suggestions are "soft" — the model is instructed to only flag high-
 * confidence issues. Fact-check findings are shown separately as rewrite
 * notes because they need the author's judgement, not one-click edits.
 */
interface Props {
  spaceId: string;
  slug: string;
  onClose: () => void;
  onApply: (original: string, replacement: string) => void;
}

export function SpellGrammarPanel({ spaceId, slug, onClose, onApply }: Props) {
  const status = useAiStatus();
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<SpellGrammarSuggestion[] | null>(null);
  const [factChecks, setFactChecks] = useState<FactCheckFinding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<Set<number>>(new Set());

  const enabled = !!status?.enabled && !!status.features.spellGrammar;

  const visible = useMemo(
    () => (results ?? []).map((s, i) => ({ ...s, idx: i })).filter((s) => !applied.has(s.idx)),
    [results, applied],
  );

  async function run() {
    setRunning(true);
    setError(null);
    setResults(null);
    setFactChecks([]);
    setApplied(new Set());
    try {
      const { suggestions, factChecks } = await api.aiSpellGrammar(spaceId, slug);
      setResults(suggestions);
      setFactChecks(factChecks);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  function accept(idx: number) {
    const s = results?.[idx];
    if (!s) return;
    onApply(s.original, s.replacement);
    setApplied((prev) => new Set(prev).add(idx));
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog--wide" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2>Spelling, grammar & fact check</h2>
          <button className="btn btn--ghost" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="dialog__body">
          {!enabled ? (
            <p className="dialog__hint">
              AI is not enabled for this space. Set an API key in the server env
              or enable the spellGrammar feature in <code className="dialog__code">.blogspace/config.yaml</code>.
            </p>
          ) : (
            <>
              <div className="sg__actions">
                <button className="btn btn--primary" onClick={run} disabled={running}>
                  {running ? "Reviewing…" : results ? "Re-run" : "Run review"}
                </button>
                {results && (
                  <span className="sg__count">
                    {visible.length} edits open · {applied.size} accepted · {factChecks.length} fact notes
                  </span>
                )}
              </div>
              {error && <p className="dialog__error">{error}</p>}
              {results && visible.length === 0 && factChecks.length === 0 && !running && (
                <p className="dialog__hint">No further suggestions or fact-check notes. Looks good.</p>
              )}
              {visible.length > 0 && (
                <>
                  <h3 className="sg__section-title">Text fixes</h3>
                  <ul className="sg__list">
                    {visible.map((s) => (
                      <li key={s.idx} className="sg__item">
                        <div className="sg__diff">
                          <span className="sg__old">{s.original}</span>
                          <span className="sg__arrow">→</span>
                          <span className="sg__new">{s.replacement}</span>
                        </div>
                        <p className="sg__reason">{s.reason}</p>
                        <div className="sg__btns">
                          <button className="btn btn--small btn--primary" onClick={() => accept(s.idx)}>
                            Accept
                          </button>
                          <button
                            className="btn btn--small btn--ghost"
                            onClick={() =>
                              setApplied((prev) => new Set(prev).add(s.idx))
                            }
                          >
                            Dismiss
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {factChecks.length > 0 && (
                <>
                  <h3 className="sg__section-title">Historical fact-check notes</h3>
                  <ul className="sg__list sg__list--fact">
                    {factChecks.map((finding, idx) => (
                      <li key={`${finding.claim}-${idx}`} className="sg__item sg__item--fact">
                        <div className="sg__fact-head">
                          <span className="sg__fact-label">
                            {finding.confidence === "likely" ? "Likely issue" : "Verify"}
                          </span>
                          <span className="sg__fact-claim">{finding.claim}</span>
                        </div>
                        <p className="sg__reason">{finding.concern}</p>
                        <p className="sg__fact-suggestion">{finding.suggestedCorrection}</p>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
        <footer className="dialog__actions">
          <button className="btn" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  );
}
