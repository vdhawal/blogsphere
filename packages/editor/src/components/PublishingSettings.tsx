import { useEffect, useRef, useState } from "react";
import * as jsonpatch from "fast-json-patch";
import { getWsClient } from "../ws";
import type { ResourceRef, SeriesShape } from "../types";

interface Props {
  spaceId: string;
  onClose: () => void;
}

/**
 * Series-level publishing + SEO settings. These fields gate a large chunk
 * of the compiled output's metadata that the per-chapter frontmatter panel
 * can't express:
 *
 *  - `site.baseUrl` — without it canonical/OG URLs and the sitemap come out
 *    relative, which search engines and social scrapers can't consume.
 *  - `publisher` — the schema.org Organization Google's Article rich
 *    results require (with a logo).
 *  - author social profiles (`sameAs`) — JSON-LD entity linking.
 *  - the default Twitter handle and license.
 *
 * Edits flow through the same series WS resource as chapter reordering —
 * JSON patches against series.yaml, acked after disk flush. Version
 * mismatches (e.g. a concurrent reorder) self-heal via close+reopen, same
 * pattern as the frontmatter panel.
 */
export function PublishingSettings({ spaceId, onClose }: Props) {
  const resource: ResourceRef = { kind: "series", spaceId };
  const baselineRef = useRef<SeriesShape | null>(null);
  // The series we last shipped, so the ack handler can rebase the baseline
  // onto it without depending on the (stale-in-closure) form state.
  const lastSentRef = useRef<SeriesShape | null>(null);
  const versionRef = useRef(0);
  const clientSeqRef = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);

  // Form fields.
  const [baseUrl, setBaseUrl] = useState("");
  const [basePath, setBasePath] = useState("/");
  const [publisherName, setPublisherName] = useState("");
  const [publisherLogo, setPublisherLogo] = useState("");
  const [publisherUrl, setPublisherUrl] = useState("");
  const [twitter, setTwitter] = useState("");
  const [license, setLicense] = useState("");
  const [sameAs, setSameAs] = useState("");

  useEffect(() => {
    const ws = getWsClient();
    const unsub = ws.subscribe(resource, (msg) => {
      if (msg.type === "opened" && msg.content.kind === "json") {
        const s = msg.content.value as SeriesShape;
        baselineRef.current = jsonpatch.deepClone(s);
        versionRef.current = msg.version;
        setBaseUrl(s.site?.baseUrl ?? "");
        setBasePath(s.site?.basePath ?? "/");
        setPublisherName(s.publisher?.name ?? "");
        setPublisherLogo(s.publisher?.logo ?? "");
        setPublisherUrl(s.publisher?.url ?? "");
        setTwitter(s.seo?.social?.twitter ?? "");
        setLicense(s.license ?? "");
        setSameAs(
          typeof s.author === "object" && s.author.sameAs ? s.author.sameAs.join(", ") : "",
        );
        setLoaded(true);
      } else if (msg.type === "ack") {
        if (lastSentRef.current) baselineRef.current = jsonpatch.deepClone(lastSentRef.current);
        setSaved(true);
      } else if (msg.type === "error" && msg.code === "version-mismatch") {
        ws.close(resource);
        ws.open(resource);
      }
    });
    const sendOpen = () => ws.open(resource);
    const unsubConn = ws.onConnected(sendOpen);
    sendOpen();
    return () => {
      unsub();
      unsubConn();
      ws.close(resource);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId]);

  /** Apply the current form state onto a base series, normalizing empties. */
  function buildNext(base: SeriesShape): SeriesShape {
    const next: SeriesShape = jsonpatch.deepClone(base);
    const bu = baseUrl.trim();
    if (bu) next.site = { baseUrl: bu, basePath: basePath.trim() || "/" };
    else delete next.site;

    const pn = publisherName.trim();
    if (pn) {
      next.publisher = {
        name: pn,
        ...(publisherLogo.trim() ? { logo: publisherLogo.trim() } : {}),
        ...(publisherUrl.trim() ? { url: publisherUrl.trim() } : {}),
      };
    } else {
      delete next.publisher;
    }

    const tw = twitter.trim();
    const social = { ...(next.seo.social ?? {}) };
    if (tw) social.twitter = tw;
    else delete social.twitter;
    next.seo = { ...next.seo, ...(Object.keys(social).length ? { social } : { social: undefined }) };
    if (!Object.keys(social).length) delete next.seo.social;

    const lic = license.trim();
    if (lic) next.license = lic;
    else delete next.license;

    const profiles = sameAs
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const authorName =
      typeof next.author === "string" ? next.author : next.author.name;
    if (profiles.length) {
      const authorObj =
        typeof next.author === "object" ? { ...next.author } : { name: authorName };
      authorObj.sameAs = profiles;
      next.author = authorObj;
    } else if (typeof next.author === "object" && next.author.sameAs) {
      const rest = { ...next.author };
      delete rest.sameAs;
      next.author = rest;
    }
    return next;
  }

  function save() {
    if (!baselineRef.current) return;
    const next = buildNext(baselineRef.current);
    const patches = jsonpatch.compare(baselineRef.current, next) as Parameters<
      ReturnType<typeof getWsClient>["sendJsonEdit"]
    >[3];
    if (patches.length === 0) {
      onClose();
      return;
    }
    lastSentRef.current = next;
    const fromVersion = versionRef.current;
    versionRef.current = fromVersion + 1;
    clientSeqRef.current += 1;
    getWsClient().sendJsonEdit(resource, fromVersion, clientSeqRef.current, patches);
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog--wide" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2>Publishing &amp; SEO settings</h2>
          <button className="btn btn--ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="dialog__body">
          {!loaded ? (
            <p className="panel__loading">Loading…</p>
          ) : (
            <>
              <p className="dialog__hint">
                These power canonical URLs, social cards, sitemaps, and structured
                data across the whole site. The base URL is the most important —
                without it, links and the sitemap are emitted relative.
              </p>
              <Field label="Site base URL" hint="e.g. https://blog.example.com — the public origin you deploy to">
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://your-domain.com"
                />
              </Field>
              <Field label="Base path" hint="Sub-path if not hosted at the domain root">
                <input value={basePath} onChange={(e) => setBasePath(e.target.value)} placeholder="/" />
              </Field>
              <Field label="Publisher name" hint="Shown as the schema.org publisher (defaults to the author)">
                <input
                  value={publisherName}
                  onChange={(e) => setPublisherName(e.target.value)}
                  placeholder="Your blog or brand name"
                />
              </Field>
              <Field label="Publisher logo" hint="Path or URL — falls back to the series cover">
                <input
                  value={publisherLogo}
                  onChange={(e) => setPublisherLogo(e.target.value)}
                  placeholder="./assets/logo.png"
                />
              </Field>
              <Field label="Publisher URL">
                <input
                  value={publisherUrl}
                  onChange={(e) => setPublisherUrl(e.target.value)}
                  placeholder="https://your-domain.com"
                />
              </Field>
              <Field label="Default Twitter/X handle" hint="Used for twitter:site and twitter:creator">
                <input value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="@handle" />
              </Field>
              <Field label="Author social profiles" hint="Comma-separated profile URLs for JSON-LD sameAs">
                <input
                  value={sameAs}
                  onChange={(e) => setSameAs(e.target.value)}
                  placeholder="https://instagram.com/…, https://mastodon.social/@…"
                />
              </Field>
              <Field label="License" hint="e.g. CC BY-NC 4.0">
                <input value={license} onChange={(e) => setLicense(e.target.value)} placeholder="All rights reserved" />
              </Field>
            </>
          )}
        </div>
        <div className="dialog__actions">
          {saved && <span className="status status--saved">saved</span>}
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn btn--primary" onClick={save} disabled={!loaded}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  );
}
