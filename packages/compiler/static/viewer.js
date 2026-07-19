/* blogspace viewer runtime — vanilla JS, no deps.
 * Progressive enhancement only: page must be fully readable without this. */
(function () {
  "use strict";
  const manifestUrl = new URL("manifest.json", document.baseURI).toString();
  let manifestPromise = null;
  const loadManifest = () => {
    if (!manifestPromise) {
      manifestPromise = fetch(manifestUrl)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    }
    return manifestPromise;
  };

  // --- keyboard nav: ← prev, → next ---
  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowLeft") {
      const a = document.querySelector('a[rel="prev"]');
      if (a) window.location.href = a.href;
    } else if (e.key === "ArrowRight") {
      const a = document.querySelector('a[rel="next"]');
      if (a) window.location.href = a.href;
    }
  });

  // --- wikilink hover preview ---
  // Must match .preview-popover { max-width } in viewer.css — avoids reading
  // offsetWidth after appendChild, which would force a synchronous reflow.
  const POPOVER_MAX_W = 320;
  let activePopover = null;
  const showPreview = (anchor, data) => {
    hidePreview();
    // Read geometry BEFORE any DOM mutation to avoid forced reflow.
    const rect = anchor.getBoundingClientRect();
    const top = window.scrollY + rect.bottom + 6;
    const left = Math.min(
      window.scrollX + rect.left,
      window.scrollX + window.innerWidth - POPOVER_MAX_W - 16,
    );
    const pop = document.createElement("div");
    pop.className = "preview-popover";
    pop.innerHTML = "<h3></h3><p></p>";
    pop.querySelector("h3").textContent = data.title;
    pop.querySelector("p").textContent = data.summary;
    pop.style.top = top + "px";
    pop.style.left = left + "px";
    document.body.appendChild(pop);
    activePopover = pop;
  };
  const hidePreview = () => {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
  };
  document.addEventListener("mouseover", async (e) => {
    const a = e.target.closest && e.target.closest("[data-chapter-preview]");
    if (!a) return;
    const slug = a.getAttribute("data-chapter-preview");
    const m = await loadManifest();
    if (!m) return;
    const ch = m.chapters.find((c) => c.slug === slug);
    if (!ch) return;
    showPreview(a, ch);
  });
  document.addEventListener("mouseout", (e) => {
    const a = e.target.closest && e.target.closest("[data-chapter-preview]");
    if (!a) return;
    // Don't hide if mouse moved onto the popover itself
    if (activePopover && (e.relatedTarget === activePopover || (activePopover.contains && activePopover.contains(e.relatedTarget)))) return;
    hidePreview();
  });
  document.addEventListener("scroll", hidePreview, { passive: true });

  // --- map: click static image to load interactive Leaflet ---
  document.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest(".map__activate");
    if (!btn) return;
    const fig = btn.closest(".map");
    if (!fig || !fig.dataset.interactive) return;
    e.preventDefault();
    activateMap(fig);
  });
  async function activateMap(fig) {
    const center = fig.dataset.center.split(",").map(Number);
    const zoom = Number(fig.dataset.zoom);
    let markers = [];
    try {
      markers = JSON.parse(fig.dataset.markers || "[]");
    } catch (_) {}
    await loadLeaflet();
    const img = fig.querySelector("img");
    const w = img.width, h = img.height;
    const host = document.createElement("div");
    host.style.width = "100%";
    host.style.height = h + "px";
    img.replaceWith(host);
    fig.querySelector(".map__activate")?.remove();
    const L = window.L;
    const map = L.map(host).setView(center, zoom);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);
    for (const m of markers) {
      const marker = L.marker([m.lat, m.lng]).addTo(map);
      if (m.label) marker.bindPopup(m.label);
    }
  }
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      js.onload = resolve;
      js.onerror = reject;
      document.head.appendChild(js);
    });
  }

  // --- reader chat panel ---
  // Fetches chat-config.json (emitted by the compiler from .blogspace/
  // config.yaml + ai-context.yaml), and either lights up the panel that
  // ships with the page shell, or leaves it hidden when chat is not
  // configured.
  //
  // Conversation history is per-reader, kept in sessionStorage so it
  // persists across page navigations within the same tab but doesn't
  // leak between readers or sessions. The server-side endpoint is
  // stateless — we send the full transcript on every turn.
  initReaderChat();

  async function initReaderChat() {
    const panel = document.getElementById("reader-chat");
    if (!panel) return;
    let config;
    try {
      const url = new URL("chat-config.json", document.baseURI).toString();
      const res = await fetch(url);
      if (!res.ok) return;
      config = await res.json();
    } catch {
      return;
    }
    if (!config || !config.enabled || !config.chatProxyUrl) return;

    panel.removeAttribute("hidden");
    panel.classList.add("reader-chat--collapsed");

    const toggle = panel.querySelector(".reader-chat__toggle");
    const body = panel.querySelector(".reader-chat__body");
    const log = panel.querySelector(".reader-chat__log");
    const form = panel.querySelector(".reader-chat__form");
    const textarea = form.querySelector("textarea");
    const send = form.querySelector(".reader-chat__send");
    const hint = panel.querySelector(".reader-chat__hint");

    if (config.provider) {
      hint.textContent = `via ${config.provider}${config.fileId ? "" : " — no PDF context attached"}`;
    } else {
      hint.textContent = "No PDF context attached — answers are unbounded";
    }

    const storageKey = `reader-chat:${config.spaceId}`;
    const loadHistory = () => {
      try {
        const raw = sessionStorage.getItem(storageKey);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch {
        return [];
      }
    };
    const saveHistory = (msgs) => {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(msgs));
      } catch {
        /* full / disabled storage — fine to drop */
      }
    };

    let history = loadHistory();
    renderLog();

    toggle.addEventListener("click", () => {
      const isOpen = !body.hidden;
      body.hidden = isOpen;
      panel.classList.toggle("reader-chat--open", !isOpen);
      panel.classList.toggle("reader-chat--collapsed", isOpen);
      toggle.setAttribute("aria-expanded", String(!isOpen));
      if (!isOpen) textarea.focus();
    });

    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = textarea.value.trim();
      if (!text || send.disabled) return;
      const userMsg = { role: "user", content: text };
      history.push(userMsg);
      saveHistory(history);
      textarea.value = "";
      renderLog();
      await streamReply();
    });

    async function streamReply() {
      send.disabled = true;
      textarea.disabled = true;
      const assistantMsg = { role: "assistant", content: "", streaming: true };
      history.push(assistantMsg);
      renderLog();
      try {
        const res = await fetch(config.chatProxyUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: history
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map((m) => ({ role: m.role, content: m.content })),
          }),
        });
        if (!res.ok || !res.body) {
          assistantMsg.content = `⚠️ ${await res.text().catch(() => "request failed")}`;
          assistantMsg.streaming = false;
          renderLog();
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try {
                const p = JSON.parse(line.slice(5).trim());
                if (p.delta) {
                  assistantMsg.content += p.delta;
                  renderLog();
                } else if (p.error) {
                  assistantMsg.content += `\n\n⚠️ ${p.error}`;
                  renderLog();
                }
              } catch {
                /* keepalive / malformed */
              }
            }
          }
        }
      } catch (err) {
        assistantMsg.content += `\n\n⚠️ ${err && err.message ? err.message : "stream failed"}`;
      } finally {
        assistantMsg.streaming = false;
        saveHistory(history);
        renderLog();
        send.disabled = false;
        textarea.disabled = false;
        textarea.focus();
      }
    }

    function renderLog() {
      if (history.length === 0) {
        log.innerHTML = `<p class="reader-chat__empty">Ask a question about this blog — the model has the series PDF as context.</p>`;
        return;
      }
      // Render with simple DOM creation so a malicious assistant reply
      // can't inject HTML. Streamed deltas update the last bubble's
      // textContent in place; the cursor pseudo-element handles the
      // typing indicator.
      log.innerHTML = "";
      for (const m of history) {
        const wrap = document.createElement("div");
        wrap.className = `reader-chat__msg reader-chat__msg--${m.role}`;
        const role = document.createElement("div");
        role.className = "reader-chat__msg-role";
        role.textContent = m.role === "user" ? "You" : "Assistant";
        const content = document.createElement("div");
        content.className = `reader-chat__msg-content${
          m.streaming ? " reader-chat__msg-content--streaming" : ""
        }`;
        content.textContent = m.content;
        wrap.appendChild(role);
        wrap.appendChild(content);
        log.appendChild(wrap);
      }
      log.scrollTop = log.scrollHeight;
    }
  }

  // --- Welcomments Reply Handlers ---
  window.welcommentsReply = function (id, author) {
    const replyInput = document.getElementById("welcomments_reply_to");
    if (replyInput) {
      replyInput.value = id;
      let label = document.getElementById("welcomments__reply-label");
      if (!label) {
        label = document.createElement("div");
        label.id = "welcomments__reply-label";
        label.style = "font-family: var(--font-sans); font-size: 0.85rem; color: var(--accent); margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem;";
        const form = document.getElementById("welcomments__form");
        form.insertBefore(label, form.firstChild);
      }
      label.innerHTML = "";
      label.appendChild(document.createTextNode("Replying to "));
      const strong = document.createElement("strong");
      strong.textContent = author;
      label.appendChild(strong);
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.style = "background: none; border: 0; color: var(--muted); cursor: pointer; text-decoration: underline; padding: 0; margin-left: 0.5rem;";
      cancelBtn.textContent = "(Cancel)";
      cancelBtn.onclick = window.welcommentsCancelReply;
      label.appendChild(cancelBtn);
      
      const formEl = document.getElementById("welcomments__form");
      if (formEl) formEl.scrollIntoView({ behavior: "smooth" });
    }
  };
  window.welcommentsCancelReply = function () {
    const replyInput = document.getElementById("welcomments_reply_to");
    if (replyInput) replyInput.value = "";
    const label = document.getElementById("welcomments__reply-label");
    if (label) label.remove();
  };

  // --- Umami Cloud Analytics & Event Tracking ---
  const trackUmami = (eventName, eventData) => {
    if (window.umami && typeof window.umami.track === "function") {
      window.umami.track(eventName, eventData);
    }
  };

  // 1. Scroll Depth
  const scrollTracked = { p25: false, p50: false, p75: false, p100: false };
  document.addEventListener("scroll", () => {
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    if (docHeight <= 0) return;
    const scrollPercent = (window.scrollY / docHeight) * 100;
    
    if (scrollPercent >= 25 && !scrollTracked.p25) {
      scrollTracked.p25 = true;
      trackUmami("scroll-depth", { percentage: "25%" });
    }
    if (scrollPercent >= 50 && !scrollTracked.p50) {
      scrollTracked.p50 = true;
      trackUmami("scroll-depth", { percentage: "50%" });
    }
    if (scrollPercent >= 75 && !scrollTracked.p75) {
      scrollTracked.p75 = true;
      trackUmami("scroll-depth", { percentage: "75%" });
    }
    if (scrollPercent >= 95 && !scrollTracked.p100) {
      scrollTracked.p100 = true;
      trackUmami("scroll-depth", { percentage: "100%" });
    }
  }, { passive: true });

  // 2. Active Reading Time
  let lastActiveTime = Date.now();
  let activeSeconds = 0;
  let isFocused = true;

  const updateActiveTime = () => {
    if (isFocused && document.visibilityState === "visible") {
      const now = Date.now();
      activeSeconds += Math.round((now - lastActiveTime) / 1000);
      lastActiveTime = now;
    }
  };

  setInterval(() => {
    updateActiveTime();
    lastActiveTime = Date.now();
  }, 5000);

  window.addEventListener("focus", () => {
    lastActiveTime = Date.now();
    isFocused = true;
  });
  window.addEventListener("blur", () => {
    updateActiveTime();
    isFocused = false;
  });

  let timeReported = false;
  const reportReadingTime = () => {
    if (timeReported) return;
    updateActiveTime();
    if (activeSeconds > 5) {
      timeReported = true;
      const mins = Math.floor(activeSeconds / 60);
      trackUmami("read-time", { 
        minutes: mins === 0 ? "Under 1m" : `${mins}m`,
        seconds: String(activeSeconds)
      });
    }
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      reportReadingTime();
    } else {
      lastActiveTime = Date.now();
    }
  });
  window.addEventListener("pagehide", reportReadingTime);

  // 3. Image & Carousel Interaction
  let carouselInteracted = false;
  document.addEventListener("scroll", (e) => {
    if (e.target && e.target.classList && e.target.classList.contains("gallery--carousel")) {
      if (!carouselInteracted) {
        carouselInteracted = true;
        trackUmami("gallery-interaction", { type: "carousel-swipe" });
      }
    }
  }, { capture: true, passive: true });

  document.addEventListener("click", (e) => {
    const img = e.target.closest && e.target.closest(".gallery img, .chapter__body img");
    if (img) {
      trackUmami("image-click", { src: img.src });
    }
  });
})();
