import { useState } from "react";
import type { EditorView } from "@codemirror/view";
import { useAiStatus } from "../ai";

interface Props {
  view: EditorView | null;
  /** Slug of the current chapter — used to seed asset path placeholders. */
  chapterSlug: string;
  /** Open the AssetPicker dialog. The picker emits the markdown block which
   *  the editor surface inserts at the cursor — Toolbar doesn't own that
   *  state, it just signals that the picker should open. */
  onPickFromAssets?: () => void;
  /** Open the spell + grammar review dialog. */
  onSpellGrammar?: () => void;
}

/**
 * Inserts directive templates at the cursor. The author fills in the asset
 * paths and attributes afterwards; we don't try to be clever about wiring
 * uploaded assets here in v1.
 *
 * Templates are plain markdown — they round-trip through the same parser
 * as everything else, so authors can also hand-write any of these.
 */
export function Toolbar({ view, chapterSlug, onPickFromAssets, onSpellGrammar }: Props) {
  const [galleryOpen, setGalleryOpen] = useState(false);
  const aiStatus = useAiStatus();

  const insert = (template: string) => {
    if (!view) return;
    const sel = view.state.selection.main;
    const needsLeadingNewline = sel.from > 0 && view.state.doc.sliceString(sel.from - 1, sel.from) !== "\n";
    const text = (needsLeadingNewline ? "\n" : "") + template + "\n";
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    });
    view.focus();
  };

  const galleryTemplate = (layout: string) =>
    `:::gallery{layout=${layout}}
![alt text](./assets/${chapterSlug}/PLACEHOLDER.jpg)
:::`;

  return (
    <div className="toolbar" role="toolbar" aria-label="Insert directive">
      <div className="toolbar__group">
        <button
          className="toolbar__btn"
          onClick={() => setGalleryOpen((v) => !v)}
          aria-expanded={galleryOpen}
        >
          Gallery ▾
        </button>
        {galleryOpen && (
          <div className="toolbar__menu" onMouseLeave={() => setGalleryOpen(false)}>
            {(["tile", "masonry", "carousel", "fullbleed", "single"] as const).map((l) => (
              <button
                key={l}
                className="toolbar__menu-item"
                onClick={() => {
                  insert(galleryTemplate(l));
                  setGalleryOpen(false);
                }}
              >
                {l}
              </button>
            ))}
            {onPickFromAssets && (
              <>
                <hr className="toolbar__menu-rule" />
                <button
                  className="toolbar__menu-item"
                  onClick={() => {
                    onPickFromAssets();
                    setGalleryOpen(false);
                  }}
                >
                  From uploaded assets…
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <button
        className="toolbar__btn"
        onClick={() =>
          insert(
            `::video[Caption]{src=./assets/${chapterSlug}/PLACEHOLDER.mp4 poster=./assets/${chapterSlug}/PLACEHOLDER.jpg}`,
          )
        }
      >
        Video
      </button>
      <button
        className="toolbar__btn"
        onClick={() =>
          insert(`::map{center="0,0" zoom=13 markers="0,0:Label" style=streets}`)
        }
      >
        Map
      </button>
      <button
        className="toolbar__btn"
        onClick={() =>
          insert(
            `:::quote-card{author="Author" source="Source" year=2026}
Quote text here.
:::`,
          )
        }
      >
        Quote
      </button>
      <button
        className="toolbar__btn"
        onClick={() => insert(`::chapter-link[Label]{to=chapter-slug variant=card}`)}
      >
        Chapter link
      </button>
      <span className="toolbar__spacer" />
      {aiStatus?.enabled && aiStatus.features.spellGrammar && onSpellGrammar && (
        <button
          className="toolbar__btn"
          onClick={onSpellGrammar}
          title="Spelling, grammar, and fact check (AI)"
        >
          ✓ Review text
        </button>
      )}
      <span className="toolbar__hint">drop images anywhere to upload</span>
    </div>
  );
}
