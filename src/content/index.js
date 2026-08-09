/* ==========================================================================
   Chatto Enhancer
   1. Per-participant volume sliders on the call panel
   2. Emoji picker next to the send button

   Everything here is additive: it only reads Chatto's DOM and appends its own
   nodes. Nothing Chatto renders is modified or removed, so if a Chatto update
   changes the markup the worst case is that these controls stop appearing —
   not that the app breaks.

   v1.3 — every lookup now runs a cascade of strategies instead of one hard
   selector, storage failure can no longer wedge startup, and Firefox is
   supported. See __ceDebug() for which strategy is currently winning.

   v1.9 — markdown no longer simulates typing when it can help it. The
   main-world script hands us Chatto's real TipTap editor commands, and the
   old typing path survives only as a per-format fallback. __ceDebug() shows
   which path is live.
   ========================================================================== */
(() => {
  'use strict';

  try {
    if (typeof window.__ceIsoCleanup === 'function') window.__ceIsoCleanup();
  } catch (_) {}

  /* ============================ browser compatibility ==================== */

  /* Firefox exposes promise-based `browser.*`; Chromium exposes callback-based
     `chrome.*`. Firefox also provides a `chrome` alias, so prefer `browser`
     when it is the real thing. */
  const API = (typeof browser !== 'undefined' && browser && browser.storage) ? browser : chrome;
  const PROMISE_API = (typeof browser !== 'undefined' && browser && browser.storage) ? true : false;
  const IS_GECKO = typeof navigator !== 'undefined' && /Gecko\/|Firefox\//.test(navigator.userAgent);
  const MAX_RECENTS = 27;
  const MAX_NAME_LEN = 160;
  const SAFE_LINK_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);
  const ALLOWED_IN_TYPES = new Set([
    'ready', 'audio', 'elements', 'order', 'levels', 'md-info',
    'md-active', 'md-result', 'state',
  ]);
  const bridgeToken = (() => {
    try {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      return String(Date.now()) + '-' + Math.random().toString(16).slice(2);
    }
  })();

  const log = (...a) => console.log('%c[Chatto Enhancer]', 'color:#2f9bf5;font-weight:600', ...a);
  const warn = (...a) => console.warn('%c[Chatto Enhancer]', 'color:#f5a02f;font-weight:600', ...a);

  /* Where the scroll wheel changes volume.
     'card'   — anywhere over a participant (default, fewest movements)
     'slider' — only over the bar itself
     Switch to 'slider' if you ever have enough people in a call that the
     participant list needs scrolling, since 'card' swallows the wheel. */
  const WHEEL_TARGET = 'card';

  /* ---------------------------------------------------------------- state -- */

  let volumes = Object.create(null);   // { participantName: 0..1 }
  let recents = [];   // most-recently-used emoji characters
  let ready = false;

  function own(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function cleanName(name) {
    if (typeof name !== 'string') return null;
    const s = name.trim();
    return s && s.length <= MAX_NAME_LEN ? s : null;
  }

  function cleanVolumeValue(value) {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.min(1, value))
      : null;
  }

  function cleanVolumes(value) {
    const out = Object.create(null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const key of Object.keys(value)) {
      const name = cleanName(key);
      const vol = cleanVolumeValue(value[key]);
      if (name && vol !== null) out[name] = Math.round(vol * 100) / 100;
    }
    return out;
  }

  function cleanRecents(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      if (!item || item.length > 24) continue;
      if (!out.includes(item)) out.push(item);
      if (out.length >= MAX_RECENTS) break;
    }
    return out;
  }

  /* --- feature toggles ------------------------------------------------
     Read once at startup (see the combined storageGet() below) and never
     re-read afterward — a setting flipped in the popup takes effect on the
     next page load, not live. That's a deliberate simplification: doing
     this live would mean writing a teardown path for every feature (remove
     buttons, close open pickers, disconnect listeners) in addition to the
     setup path that already exists, roughly doubling this section's
     surface for a responsiveness win most users won't need. The popup says
     as much rather than implying it's instant.

     Disabling a feature here skips its setup work — it never builds its
     DOM, never runs its per-scan checks, never opens network connections
     (GIF search/fetch) — which is the actual point: the manifest still
     declares this whole file as one content script, so the browser loads
     and parses it regardless of these flags (that part is unavoidable
     without splitting into several separately-injected scripts, a much
     larger change than this pass). What these flags buy is real: skipping
     ~1,900 emoji buttons' worth of DOM construction, or a GIF search
     round-trip, when that feature is off. */
  const FEATURES = [
    { key: 'volume', label: 'Per-participant volume sliders' },
    { key: 'emoji', label: 'Emoji picker' },
    { key: 'gif', label: 'GIF picker' },
    { key: 'markdown', label: 'Markdown toolbar' },
    { key: 'pip', label: 'Screen-share pop-out button' },
    { key: 'nicknames', label: 'Local nicknames' },
  ];

  function defaultSettings() {
    const out = {};
    for (const f of FEATURES) out[f.key] = true;
    return out;
  }

  function cleanSettings(value) {
    const out = defaultSettings();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const f of FEATURES) if (typeof value[f.key] === 'boolean') out[f.key] = value[f.key];
    }
    return out;
  }

  let settings = defaultSettings();

  const MAX_GIF_FAVORITES = 200;

  /** Favorited GIFs are rendered as <img src> directly from stored data,
      without going through background.js's fetch relay the way inserting
      one does — so this is the only gate on what URL ends up in an <img>
      built from storage. Low severity either way (an <img> src can't
      execute script), but cheap to restrict to Giphy's own media hosts,
      consistent with how background.js already restricts its fetch relay. */
  function isGiphyMediaUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 2048) return false;
    let url;
    try { url = new URL(value); } catch (_) { return false; }
    return url.protocol === 'https:' && /(^|\.)giphy\.com$/.test(url.hostname);
  }

  function cleanGifFavorite(item) {
    if (!item || typeof item !== 'object') return null;
    const id = typeof item.id === 'string' && item.id && item.id.length <= 64 ? item.id : null;
    if (!id || !isGiphyMediaUrl(item.url)) return null;
    const previewUrl = isGiphyMediaUrl(item.previewUrl) ? item.previewUrl : item.url;
    const title = typeof item.title === 'string' ? item.title.slice(0, 200) : '';
    const dim = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 20000 ? v : 0);
    return { id, url: item.url, previewUrl, title, width: dim(item.width), height: dim(item.height) };
  }

  function cleanGifFavorites(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of value) {
      const item = cleanGifFavorite(raw);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
      if (out.length >= MAX_GIF_FAVORITES) break;
    }
    return out;
  }

  /* Storage that cannot wedge startup.
     Firefox refuses storage.local outright when an add-on is loaded
     temporarily without an explicit ID in browser_specific_settings — the
     manifest now has one, but a rejected promise or a lastError still has to
     leave the extension running rather than hanging on a callback that never
     fires. Defaults are fine; you just lose remembered levels. */
  function storageGet(keys) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        resolve(v && typeof v === 'object' ? v : {});
      };
      const guard = setTimeout(() => {
        warn('storage did not answer in time — continuing with defaults');
        done(null);
      }, 2000);

      try {
        if (PROMISE_API) {
          API.storage.local.get(keys).then(done, (e) => {
            warn('storage read failed:', e && e.message ? e.message : e);
            done(null);
          });
        } else {
          API.storage.local.get(keys, (r) => {
            const err = API.runtime && API.runtime.lastError;
            if (err) warn('storage read failed:', err.message);
            done(err ? null : r);
          });
        }
      } catch (e) {
        warn('storage unavailable:', e && e.message ? e.message : e);
        done(null);
      }
    });
  }

  function storageSet(obj) {
    try {
      const r = API.storage.local.set(obj);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (_) {
      /* extension context can go away on reload; nothing to do */
    }
  }

  /** Talks to background.js, which is where anything Giphy-related actually
      happens — a content script's fetch() is bound by the page's own CSP,
      the background script's is not. Never rejects: callers get { ok:false }
      instead, since "the extension context went away mid-reload" is routine,
      not exceptional. */
  function sendBg(msg) {
    return new Promise((resolve) => {
      try {
        if (PROMISE_API) {
          API.runtime.sendMessage(msg).then(
            (r) => resolve(r || { ok: false, error: 'no-response' }),
            () => resolve({ ok: false, error: 'unreachable' }),
          );
        } else {
          API.runtime.sendMessage(msg, (r) => {
            if (API.runtime.lastError) { resolve({ ok: false, error: 'unreachable' }); return; }
            resolve(r || { ok: false, error: 'no-response' });
          });
        }
      } catch (_) {
        resolve({ ok: false, error: 'unreachable' });
      }
    });
  }

  /* One combined read instead of three separate storage round-trips (this
     used to be volumes/recents, nicknames, and gifFavorites each reading
     independently) — nicknames/gifFavorites/settings are declared with
     `let` further down but already initialized by the time this callback
     runs, since a promise callback can't fire until the whole synchronous
     script body — every `let` in it — has finished executing. */
  storageGet(['volumes', 'recents', 'nicknames', 'gifFavorites', 'settings']).then((r) => {
    volumes = cleanVolumes(r && r.volumes);
    recents = cleanRecents(r && r.recents);
    nicknames = cleanNicknames(r && r.nicknames);
    gifFavorites = cleanGifFavorites(r && r.gifFavorites);
    settings = cleanSettings(r && r.settings);
    ready = true;
    findCards().forEach(paintCard);
    if (settings.nicknames) {
      findCards().forEach(applyNickname);
      applyNicknamesEverywhere();
    }
  });

  let saveTimer = null;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => storageSet({ volumes, recents }), 250);
  }

  /* ======================== resilient element lookup =====================
     The original code used one hardcoded selector per target. A single
     Chatto release, or a localised aria-label, was enough to make a control
     silently never appear — which is the failure you are seeing.

     Each target now runs an ordered list of strategies and takes the first
     that produces something. Results are cached for one animation frame so a
     scan is not paying for the cascade repeatedly, and __ceDebug() reports
     which strategy actually matched so a future breakage is diagnosable in
     one line instead of by bisecting selectors. */

  const qs = (s, root) => { try { return (root || document).querySelector(s); } catch (_) { return null; } };
  const qsa = (s, root) => { try { return Array.prototype.slice.call((root || document).querySelectorAll(s)); } catch (_) { return []; } };

  /* Small DOM builder. Every node the extension inserts is now constructed
     rather than assigned through innerHTML. Mozilla's reviewer lint flags all
     innerHTML writes, and building nodes removes the need to hand-escape emoji
     names into an HTML string in the first place. */
  function h(tag, props, children) {
    const el = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'dataset') { for (const d in v) el.dataset[d] = v[d]; }
        else el.setAttribute(k, v);
      }
    }
    if (children) {
      for (const c of [].concat(children)) if (c) el.appendChild(c);
    }
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  const strategyUsed = {};   // target -> name of the strategy that matched

  function resolveOne(target, strategies) {
    for (const [name, fn] of strategies) {
      let v = null;
      try { v = fn(); } catch (_) {}
      if (v) { strategyUsed[target] = name; return v; }
    }
    strategyUsed[target] = null;
    return null;
  }

  function resolveMany(target, strategies) {
    for (const [name, fn] of strategies) {
      let v = null;
      try { v = fn(); } catch (_) {}
      if (v && v.length) { strategyUsed[target] = name; return v; }
    }
    strategyUsed[target] = null;
    return [];
  }

  /* One-frame memo. Without it, a scan that calls findCards() from four
     places runs the cascade four times over the whole document. */
  const memo = new Map();
  let memoScheduled = false;
  function cached(key, fn) {
    if (memo.has(key)) return memo.get(key);
    /* Genuinely one task, not "until the next scan". The memo used to live
       until something called dropCache(), so an event handler firing between
       scans could be told the composer is one the user had since left — which
       with a thread open meant typing into one box and formatting the other.
       A microtask clears it as soon as the current task finishes, so a scan
       still computes each lookup once and no handler ever sees stale state. */
    if (!memoScheduled) {
      memoScheduled = true;
      Promise.resolve().then(() => { memoScheduled = false; memo.clear(); });
    }
    const v = fn();
    memo.set(key, v);
    return v;
  }
  function dropCache() { memo.clear(); }

  /* --- the composer ------------------------------------------------------ */

  /* --- one composer per page was the wrong assumption ---------------------
     Opening a thread mounts a SECOND composer. The old lookup took the first
     match in the document, so it kept pointing at the main channel's box:
     inside a thread the markdown toolbar never matched the selection and the
     emoji button was never installed (it bailed whenever a button existed
     anywhere). Threads, and any future side panel, need every composer found
     and the ACTIVE one identified. */

  let cidSeq = 0;
  function cidOf(el) {
    if (!el.dataset.ceCid) el.dataset.ceCid = String(++cidSeq);
    return el.dataset.ceCid;
  }

  const visible = (el) => !!el && el.isConnected && el.offsetParent !== null;
  const byArea = (a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight);

  /** Every composer on the page, largest first. */
  function findInputs() {
    return cached('inputs', () => {
      /* UNION, not first-wins. The single-result cascade stops at the first
         strategy that matches anything, which is right when there is one
         answer and wrong here: Chatto's main box is
         `data-testid="message-input"` but a thread's is
         `thread-reply-input`, so the testid strategy matched the main
         composer, returned it, and the thread's box was never looked for.
         Every specific strategy contributes, and the broad
         "anything editable" sweep runs only if they all come up empty. */
      const specific = [
        ['testid', () => qsa('[data-testid="message-input"], [data-testid*="reply-input"], [data-testid*="message-input"]')],
        ['prosemirror', () => qsa('.ProseMirror[contenteditable="true"], .tiptap[contenteditable="true"]')],
        ['role-textbox', () => qsa('[contenteditable="true"][role="textbox"]')],
      ];
      const hits = [];
      const used = [];
      for (const [name, fn] of specific) {
        let v = [];
        try { v = fn() || []; } catch (_) { v = []; }
        v = v.filter(visible);
        if (v.length) used.push(name);
        for (const el of v) if (!hits.includes(el)) hits.push(el);
      }
      let found = hits;
      if (!found.length) {
        found = resolveMany('input', [
          ['any-editable', () => qsa('[contenteditable="true"], [contenteditable=""]')],
        ]).filter(visible);
      } else {
        strategyUsed.input = used.join('+');
      }
      // Nested editables (a composer inside a wrapper that is itself
      // editable) would otherwise be counted twice.
      const outer = found.filter((el) => !found.some((o) => o !== el && o.contains(el)));
      return outer.sort(byArea);
    });
  }

  /* The composer the user last touched. Focus alone is not enough: clicking a
     toolbar button moves focus out of the box, and the selection may be
     collapsed by then, so the last interaction is what disambiguates. */
  let lastInput = null;
  const noteInput = (el) => {
    if (!el) return;
    const inp = el.closest && el.closest('[contenteditable="true"], [contenteditable=""]');
    if (inp) lastInput = inp;
  };
  document.addEventListener('focusin', (e) => noteInput(e.target), true);
  document.addEventListener('pointerdown', (e) => noteInput(e.target), true);

  /** The composer to act on: whichever one the user is actually working in. */
  function findInput() {
    return cached('input', () => {
      const all = findInputs();
      if (!all.length) return null;
      if (all.length === 1) return all[0];

      // 1. Focus.
      const active = document.activeElement;
      const focused = all.find((el) => el === active || el.contains(active));
      if (focused) return focused;

      // 2. The current selection.
      try {
        const sel = window.getSelection();
        if (sel && sel.anchorNode) {
          const owner = all.find((el) => el.contains(sel.anchorNode));
          if (owner) return owner;
        }
      } catch (_) {}

      // 3. Last touched, while it is still on the page.
      if (lastInput && visible(lastInput) && all.includes(lastInput)) return lastInput;

      // 4. Largest visible — the old behaviour, now only as a last resort.
      return all[0];
    });
  }

  /* aria-label was the single point of failure. "Send message" is an English
     string; on a localised build nothing matches it and the emoji button is
     never anchored. The cascade now ends in a structural guess that has no
     text dependency at all. */
  /* Scoped to one composer: a document-wide search would hand the thread
     composer the MAIN channel's send button and stack both emoji buttons in
     the same corner. Every strategy below looks only inside the box's own
     surroundings.

     `root` is the nearest ancestor that looks like a composer shell — the
     first one holding a button, walking up a few levels. */
  function shellOf(inp) {
    let n = inp.parentElement;
    for (let i = 0; i < 5 && n && n !== document.body; i++, n = n.parentElement) {
      if (qs('button', n)) return n;
    }
    return inp.closest('form') || inp.parentElement || inp;
  }

  function findSendButton(inp) {
    inp = inp || findInput();
    if (!inp) return null;
    return cached('send:' + cidOf(inp), () => {
      const root = inp.closest('form') || shellOf(inp);
      const pick = (sel) => qsa(sel, root).filter((b) => !b.classList.contains('ce-emoji-btn'))[0] || null;
      return resolveOne('send', [
        ['testid', () => pick('[data-testid="send-message-button"], [data-testid="send-button"]')],
        ['aria-exact', () => pick('button[aria-label="Send message"]')],
        ['aria-fuzzy', () => pick('button[aria-label*="send" i], button[aria-label*="envoy" i], button[aria-label*="senden" i], button[aria-label*="enviar" i]')],
        ['title-fuzzy', () => pick('button[title*="send" i]')],
        ['type-submit', () => {
          const form = inp.closest('form');
          return form ? qs('button[type="submit"]', form) : null;
        }],
        ['last-in-composer', () => {
          let n = inp.parentElement;
          for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
            const btns = qsa('button', n).filter((b) => !b.classList.contains('ce-emoji-btn'));
            if (btns.length) return btns[btns.length - 1];
          }
          return null;
        }],
      ]);
    });
  }

  /* The element that should host a floating emoji button when there is no
     send button to sit beside. */
  function findComposer(inp) {
    inp = inp || findInput();
    if (!inp) return null;
    return cached('composer:' + cidOf(inp), () => {
      const send = findSendButton(inp);
      if (send) {
        let n = inp.parentElement;
        while (n && n !== document.body) {
          if (n.contains(send)) return n;
          n = n.parentElement;
        }
      }
      return inp.closest('form') || inp.parentElement;
    });
  }

  /* --- the call panel ---------------------------------------------------- */

  function findCards() {
    return cached('cards', () => resolveMany('cards', [
      ['testid', () => qsa('[data-testid="call-participant-card"]')],
      ['data-participant', () => qsa('[data-call-participant-id], [data-participant-id], [data-participant-identity]')],
      ['list-children', () => {
        const list = qs('[data-testid="call-participants-list"]');
        if (!list) return [];
        return qsa(':scope > *', list).filter((el) => el.nodeType === 1 && el.clientHeight > 0);
      }],
    ]));
  }

  /** Chatto swaps the panel testid depending on whether you've joined:
      call-observer-panel when watching, call-participant-panel when in it.
      Sliders are meaningless until you're actually in the call. */
  function inCall() {
    return cached('inCall', () => {
      if (qs('[data-testid="call-participant-panel"]')) return true;
      // Fallback: if the observer panel is explicitly present we are NOT in
      // the call; otherwise treat the presence of cards as being in it.
      if (qs('[data-testid="call-observer-panel"]')) return false;
      return findCards().length > 0;
    });
  }

  /* --- screen-share pop-out (Picture-in-Picture) --------------------------
     Confirmed working live: requestPictureInPicture() on the screen-share
     card's <video> opens a genuine OS-level floating window that stays on
     top of every window — not just the browser — on Windows, macOS, and
     Linux/X11. On Linux/Wayland this is a known platform limitation outside
     anything a page or extension can control: Wayland deliberately does not
     let a client force itself above other windows, so the popped-out
     window may not stay on top there without a manual compositor-level
     override (e.g. KWin's "Keep above others" window rule). Nothing to work
     around here — it is between the browser and the compositor. */

  function findScreenShareCards() {
    return cached('screenShareCards', () => qsa('[data-testid="call-screen-share-card"]'));
  }

  /* Picture-in-picture glyph — a frame with a smaller floating rectangle in
     the corner, the composition most open-source icon sets (Lucide, Tabler,
     Material) use for this concept. Redrawn to this codebase's own stroke
     convention (24x24, 1.7px stroke, round caps — matching gifIcon() and
     the markdown toolbar icons) rather than copied byte-for-byte from a
     specific set, the same honesty standard applied to the GIF icon. */
  function pipIcon() {
    const svg = svgEl('svg', {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.7', 'stroke-linecap': 'round',
      'stroke-linejoin': 'round', 'aria-hidden': 'true',
      // Chatto's own icons in this toolbar render at text-base (16px), via
      // an icon font/mask sized by font-size. An <svg> ignores font-size
      // and defaults to its own intrinsic size without explicit dimensions
      // — hence oversized until pinned here to match.
      width: '16', height: '16',
    });
    svg.appendChild(svgEl('path', { d: 'M21 9V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4' }));
    svg.appendChild(svgEl('rect', { x: '12', y: '13', width: '10', height: '7', rx: '2' }));
    return svg;
  }

  /** One pop-out button per screen-share card, dropped into Chatto's own
      call-media-actions toolbar right beside its Fullscreen/Mute buttons —
      reusing Chatto's exact button classes (proven to exist and work,
      since Chatto's own buttons in the same toolbar use them) so it reads
      as a native control rather than something bolted on. Mirrors
      addEmojiButton()'s per-card tracking and cleanup. */
  function ensurePipButtons() {
    if (!document.pictureInPictureEnabled) return; // browser doesn't support it at all
    const cards = findScreenShareCards();
    const live = new Set(cards.map(cidOf));

    qsa('.ce-pip-btn').forEach((b) => {
      if (!b.isConnected || !live.has(b.dataset.ceFor)) b.remove();
    });

    for (const card of cards) {
      const cid = cidOf(card);
      const existing = qsa('.ce-pip-btn').find((b) => b.dataset.ceFor === cid);
      if (existing && existing.isConnected) continue;

      const toolbar = qs('[data-testid="call-media-actions"]', card);
      const video = card.querySelector('video');
      if (!toolbar || !video) continue;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pointer-events-auto flex h-10 w-10 cursor-pointer items-center ' +
        'justify-center rounded text-muted transition-[background-color,color,scale] ' +
        'hover:bg-surface-200 hover:text-text focus-visible:outline-2 ' +
        'focus-visible:outline-offset-1 focus-visible:outline-primary active:scale-[0.96] ce-pip-btn';
      btn.title = 'Pop out (Picture-in-Picture)';
      btn.setAttribute('aria-label', 'Pop out video');
      btn.dataset.ceFor = cid;
      btn.appendChild(pipIcon());

      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
          else await video.requestPictureInPicture();
        } catch (err) {
          warn('could not pop out this video:', err && err.message ? err.message : err);
        }
      });

      toolbar.appendChild(btn);
    }
  }

  /* --- local nicknames -----------------------------------------------------
     A "Rename" button added to Chatto's own user-profile popover (the one
     with "Send Message" / "Ban from room"). There is no Chatto API this
     extension can call to actually rename someone server-side, and this
     never claims to — it is a purely local, visual relabeling that only the
     person who set it ever sees. Nicknames are stored keyed by the
     person's real display name, the same convention (and the same
     duplicate-name caveat — see SECURITY-REVIEW.md) already used for
     per-participant volume levels.

     Currently applied only to call participant cards, the one place this
     extension already has solid, tested control over card DOM structure.
     Message author names, the member sidebar, and DM list entries are not
     covered yet — that would need separate live DOM evidence for that
     markup before touching it. The Rename button itself still appears
     wherever the popover does, since it is one shared Chatto component. */

  const MAX_NICKNAMES = 500;

  function cleanNicknames(value) {
    const out = Object.create(null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    let n = 0;
    for (const key of Object.keys(value)) {
      if (n >= MAX_NICKNAMES) break;
      const name = cleanName(key);
      const nick = typeof value[key] === 'string' ? cleanName(value[key]) : null;
      if (name && nick) { out[name] = nick; n++; }
    }
    return out;
  }

  // Populated by the combined storageGet() near the top of this file.
  let nicknames = Object.create(null);

  function findProfilePopovers() {
    return cached('profilePopovers', () => resolveMany('profilePopover', [
      ['aria-label', () => qsa('[popover][aria-label="User profile"]')],
      ['dialog-fallback', () => qsa('[role="dialog"]').filter((el) =>
        qsa('.sidebar-item', el).some((b) => b.textContent.trim() === 'Send Message'))],
    ]));
  }

  function realNameFromPopover(popover) {
    const el = popover.querySelector('.font-semibold');
    const name = el && el.textContent.trim();
    return name || null;
  }

  /* Checkmark glyph — the same simple polyline every open-source stroke-icon
     set (Feather, Lucide, Tabler) uses for "confirm", drawn to this
     codebase's own convention rather than copied from a specific set. */
  function checkIcon() {
    const svg = svgEl('svg', {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '2', 'stroke-linecap': 'round',
      'stroke-linejoin': 'round', 'aria-hidden': 'true',
      width: '16', height: '16',
    });
    svg.appendChild(svgEl('polyline', { points: '20 6 9 17 4 12' }));
    return svg;
  }

  /** Toggles an inline "nickname + confirm" row directly under the Rename
      button, instead of a native window.prompt() — sits inside Chatto's own
      popover so it reads as part of that menu rather than an OS dialog. */
  function toggleRenameField(popover, renameBtn) {
    const existing = popover.querySelector('.ce-rename-field');
    if (existing) { existing.remove(); return; }

    const realName = realNameFromPopover(popover);
    if (!realName) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ce-rename-input';
    input.placeholder = 'Nickname — only visible to you';
    input.value = nicknames[realName] || '';
    input.maxLength = MAX_NAME_LEN;

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'ce-rename-confirm';
    confirmBtn.title = 'Save nickname';
    confirmBtn.setAttribute('aria-label', 'Save nickname');
    confirmBtn.appendChild(checkIcon());

    const row = document.createElement('div');
    row.className = 'ce-rename-field';
    row.appendChild(input);
    row.appendChild(confirmBtn);

    const save = () => {
      const nick = cleanName(input.value);
      if (nick) nicknames[realName] = nick;
      else delete nicknames[realName];
      storageSet({ nicknames });
      findCards().forEach(applyNickname);
      applyNicknamesEverywhere();
      row.remove();
    };

    // Keep every interaction with the field from being read by Chatto's own
    // "click outside this manual popover, close it" handling as a click
    // outside — same reasoning as the markdown toolbar buttons' mousedown
    // preventDefault, just for a text field instead of a selection.
    row.addEventListener('mousedown', (e) => e.stopPropagation());
    row.addEventListener('click', (e) => e.stopPropagation());
    confirmBtn.addEventListener('click', (e) => { e.preventDefault(); save(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { e.preventDefault(); row.remove(); }
    });

    renameBtn.insertAdjacentElement('afterend', row);
    input.focus();
    input.select();
  }

  function addRenameButtons() {
    for (const popover of findProfilePopovers()) {
      if (popover.querySelector('.ce-rename-btn')) continue;
      const sendBtn = qsa('.sidebar-item', popover).find((b) => b.textContent.trim() === 'Send Message');
      if (!sendBtn || !sendBtn.parentElement) continue;

      const btn = document.createElement('button');
      btn.type = 'button';
      // Chatto's own class for this exact menu's buttons, so it matches
      // Send Message / Ban from room instead of looking bolted on.
      btn.className = sendBtn.className + ' ce-rename-btn';
      btn.textContent = 'Rename';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleRenameField(popover, btn);
      });

      sendBtn.parentElement.insertBefore(btn, sendBtn.nextSibling);
    }
  }

  /** Swaps a participant card's displayed name for its nickname, if any —
      without touching nameOf()'s return value, which every piece of
      internal logic (local-user detection, volume keys, voice matching)
      must keep reading as the real name. Chatto's own name element is
      hidden via a class rather than mutated, so a Svelte re-render of that
      node (e.g. on a speaking-state change) can't silently undo this; the
      replacement is a sibling element re-applied every scan instead. */
  /** Hides `target` and shows/updates a sibling label with the nickname for
      `real`, or restores `target` if there is no nickname for it. Shared by
      every surface below — each one only has to find the right element and
      the right real name; this owns the actual swap exactly once. Never
      touches target's own textContent, so re-reading it later (as
      applyNicknameToMessageAuthor does, since it has no other source for
      the real name) always still returns the real name, hidden or not. */
  function swapNameDisplay(target, real) {
    if (!target || !real) return;
    const nick = nicknames[real];
    const existing = target.nextElementSibling;
    const label = existing && existing.classList && existing.classList.contains('ce-nick-label')
      ? existing : null;

    if (!nick) {
      target.classList.remove('ce-name-hidden');
      if (label) label.remove();
      return;
    }
    // Base the label's classes on target's *un-hidden* class list: adding
    // ce-name-hidden to target first, then copying its className, would
    // carry that class onto the label too — hiding both spans instead of
    // swapping one for the other. Also strips ce-nick-label itself so a
    // second call (target already hidden from a previous scan) can't
    // accumulate duplicates of either class.
    const baseClass = target.className
      .split(/\s+/)
      .filter((c) => c && c !== 'ce-name-hidden' && c !== 'ce-nick-label')
      .join(' ');
    target.classList.add('ce-name-hidden');
    const el = label || document.createElement(target.tagName.toLowerCase());
    el.className = baseClass + ' ce-nick-label';
    if (el.textContent !== nick) el.textContent = nick;
    el.title = 'Local nickname for ' + real + ' — only visible to you';
    if (!label) target.insertAdjacentElement('afterend', el);
  }

  function applyNickname(card) {
    swapNameDisplay(card.querySelector('span, p, h1, h2, h3, h4'), nameOf(card));
  }

  /* --- extending nicknames to the rest of the app -------------------------
     Each surface below is a distinct piece of Chatto markup, found and
     confirmed live rather than guessed. All three only ever touch a name
     *label* element — never a message body — since swapping the visible
     text of an actual message would misrepresent what someone really typed,
     which this extension does not do anywhere else either. */

  /** Member sidebar: `title="View profile of <name>"` on the row button
      already carries the exact real name, so there is no ambiguity about
      what to look up even though the visible span itself carries no id. */
  function findMemberListEntries() {
    return cached('memberListEntries', () => qsa('button.sidebar-item[title^="View profile of "]'));
  }

  function applyNicknameToMemberEntry(btn) {
    const title = btn.getAttribute('title') || '';
    const prefix = 'View profile of ';
    if (!title.startsWith(prefix)) return;
    const real = title.slice(prefix.length).trim();
    swapNameDisplay(qs('span.min-w-0.truncate', btn), real);
  }

  /** Message author name: the bold, underlined-on-hover name button shown
      above a message. No testid or title to read the name from, so the
      name span's own text is the source of truth — safe to re-read every
      scan since swapNameDisplay() never rewrites it. */
  function findMessageAuthorButtons() {
    return cached('messageAuthorButtons', () => qsa('button').filter((b) =>
      b.classList.contains('font-semibold') &&
      b.classList.contains('hover:underline') &&
      b.classList.contains('leading-none') &&
      b.classList.contains('inline-flex')));
  }

  function applyNicknameToMessageAuthor(btn) {
    const nameEl = btn.querySelector('span');
    if (!nameEl || nameEl.classList.contains('ce-nick-label')) return;
    swapNameDisplay(nameEl, nameEl.textContent.trim());
  }

  /** Direct-message list entry. `a.sidebar-item` alone is too broad (it
      also matches channel links), so this only acts on ones with the exact
      avatar-stack + name-span shape a DM entry has. */
  function findDmListEntries() {
    return cached('dmListEntries', () => qsa('a.sidebar-item'));
  }

  function applyNicknameToDmEntry(a) {
    const nameEl = qs(':scope > span.flex-1.truncate', a);
    if (!nameEl || nameEl.classList.contains('ce-nick-label')) return;
    swapNameDisplay(nameEl, nameEl.textContent.trim());
  }

  function applyNicknamesEverywhere() {
    findMemberListEntries().forEach(applyNicknameToMemberEntry);
    findMessageAuthorButtons().forEach(applyNicknameToMessageAuthor);
    findDmListEntries().forEach(applyNicknameToDmEntry);
  }

  /** Our own display name, so we don't put a volume slider on our own card.
      Confirmed against the account panel Chatto renders in the channel
      sidebar (also [data-testid="current-user-identity-text"], reused for
      the in-call "you are" label): the name lives in a plain inner span,
      one level deeper than a sibling span that optionally carries a custom
      status emoji + tooltip. Reading the outer wrapper's combined
      textContent (the old 'testid-child' strategy) swept up that status
      emoji along with the name — that was the actual cause of local-card
      detection permanently failing on live Chatto, not a loading race. */
  function localUserName() {
    return cached('me', () => resolveOne('me', [
      ['testid-name-span', () => {
        const el = qs('[data-testid="current-user-identity-text"]');
        const nameSpan = el && el.firstElementChild && el.firstElementChild.firstElementChild;
        const text = nameSpan && nameSpan.textContent.trim();
        return text || null;
      }],
      ['testid-child', () => {
        const el = qs('[data-testid="current-user-identity-text"]');
        const first = el && el.firstElementChild;
        return first ? first.textContent.trim() : null;
      }],
      ['testid-self', () => {
        const el = qs('[data-testid="current-user-identity-text"]');
        return el ? el.textContent.trim() : null;
      }],
      ['local-card', () => {
        const c = qs('[data-testid="call-participant-card"][data-local="true"], [data-local-participant="true"]');
        return c ? nameOf(c) : null;
      }],
    ]));
  }

  /** Chatto decorates the "this is you" sidebar label (the element matched
      by localUserName()) with a trailing decorative emoji that never appears
      on the participant card itself — confirmed against a live call, where
      the card's title/text stayed the plain display name for the whole
      session while the sidebar consistently carried an emoji suffix.
      Comparing the two strings as-is therefore never matches, not just
      during an initial loading race. Stripping a trailing run of whitespace
      and pictographic characters before comparing recovers the plain name
      on both sides. */
  function stripTrailingDecoration(s) {
    return typeof s === 'string'
      ? s.replace(/[\s\u{FE0F}\u{200D}\p{Extended_Pictographic}]+$/gu, '')
      : s;
  }

  /** Is this the local participant's own card?
      Checked in order of how much we trust the signal:
      1. An explicit marker Chatto puts on the card itself.
      2. A stable participant id shared with whichever card carries that
         marker (covers the case where the marker lands on a wrapper rather
         than the card returned by findCards()).
      3. Display name, matched against localUserName() after stripping the
         sidebar's decorative suffix — the only option left when Chatto
         exposes no id or marker on the card at all (confirmed live: this
         build's participant cards carry no data-local, data-local-
         participant, or any participant-id attribute), and still unreliable
         if two participants share a name (see SECURITY-REVIEW.md). */
  function isLocalCard(card) {
    if (card.getAttribute('data-local') === 'true' ||
        card.getAttribute('data-local-participant') === 'true') return true;

    const marker = qs('[data-testid="call-participant-card"][data-local="true"], [data-local-participant="true"]');
    if (marker && marker !== card) {
      const markerId = marker.getAttribute('data-call-participant-id') ||
                        marker.getAttribute('data-participant-id') ||
                        marker.getAttribute('data-participant-identity');
      const cardId = card.getAttribute('data-call-participant-id') ||
                     card.getAttribute('data-participant-id') ||
                     card.getAttribute('data-participant-identity');
      if (markerId && cardId) return markerId === cardId;
    }

    const me = localUserName();
    if (!me) return false;
    return stripTrailingDecoration(nameOf(card)) === stripTrailingDecoration(me);
  }

  /** Remove a slider that no longer belongs — either the card just resolved
      as local, or it's gone through a re-render and needs re-creating. */
  function removeSlider(card) {
    const wrap = card.querySelector('.ce-vol');
    if (wrap) wrap.remove();
    card.classList.remove('ce-card');
  }

  function nameOf(card) {
    const t = (card.getAttribute('title') || '').trim();
    if (t) return t;
    const aria = (card.getAttribute('aria-label') || '').trim();
    if (aria) return aria;
    const id = card.getAttribute('data-call-participant-id') ||
               card.getAttribute('data-participant-identity');
    const span = card.querySelector('span, p, h1, h2, h3, h4');
    const text = span && span.textContent.trim();
    return text || id || 'unknown';
  }

  function isSpeaking(card) {
    return card.dataset.callSpeaking === 'true' ||
           card.getAttribute('data-speaking') === 'true' ||
           card.getAttribute('aria-pressed') === 'speaking';
  }

  const getVol = (name) => (name in volumes ? volumes[name] : 1);

  /** The slider position (0-1, what's stored and shown as a percentage) is
      not what actually gets sent as the audio element's gain — human
      hearing is roughly logarithmic, not linear, so a literal
      volume = sliderPosition made the top half of the slider barely
      audible: dropping from 100% to 50% is only about a 6dB cut, well
      short of the ~10dB reduction that actually sounds "half as loud."
      Squaring the slider position before sending it as gain front-loads
      more of the perceptible change into the upper half of the slider's
      travel, without changing what's stored or displayed — the badge still
      reads "50%" at the halfway point, it now just sounds like a much more
      meaningful cut there too. */
  const perceptualGain = (v) => v * v;

  /* One window-level release for every slider. Firefox drops pointercancel in
     some drag cases; this guarantees no bar is left stuck in its drag state.
     (Registered once — 1.8 added one listener per slider and never removed
     them, which leaked a handler for every card ever shown.) */
  window.addEventListener('pointerup', () => {
    document.querySelectorAll('.ce-vol.ce-dragging').forEach((w) =>
      w.classList.remove('ce-dragging'));
  }, true);

  /* =========================================================================
     PART 1 — VOLUME
     ========================================================================= */

  /* --- Talking to the page ------------------------------------------------
     Chatto calls LiveKit's track.attach() with no argument, so the <audio>
     elements that actually carry voice are never put in the document. They
     can't be reached from here at all. main-world.js runs inside the page,
     hooks the volume accessor, and applies our factor to every write. This
     side just tells it what the factors should be. */

  const CHANNEL_OUT = 'ce-iso';
  const CHANNEL_IN = 'ce-main';
  const MAX_BRIDGE_JSON = 20000;

  let audioIds = [];           // element ids, best known ordering
  let mapping = Object.create(null); // participant name -> audio element id
  let orderConfirmed = false;  // have we seen a full sweep yet?
  let pageReady = false;
  let fallbackInjected = false;

  const send = (type, payload) => {
    try {
      window.postMessage({
        source: CHANNEL_OUT,
        token: bridgeToken,
        type,
        json: JSON.stringify(payload || {}),
      }, window.location.origin);
    } catch (_) {}
  };

  function isBridgeString(value, max) {
    return typeof value === 'string' && value.length > 0 && value.length <= max;
  }

  function isAudioId(value) {
    return isBridgeString(value, 32) && /^a\d+$/.test(value);
  }

  function validIdArray(value) {
    return Array.isArray(value) &&
      value.length <= 200 &&
      value.every(isAudioId) &&
      new Set(value).size === value.length;
  }

  function cleanLevels(value) {
    const out = Object.create(null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const id of Object.keys(value)) {
      if (!isAudioId(id)) continue;
      const n = Number(value[id]);
      if (Number.isFinite(n) && n >= 0 && n <= 1) out[id] = n;
    }
    return out;
  }

  function exactKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const allowed = new Set(keys);
    return Object.keys(value).every((key) => allowed.has(key));
  }

  function validMdActive(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.create(null);
    const out = Object.create(null);
    for (const id of FORMATS.map((f) => f.id)) out[id] = value[id] === true;
    return out;
  }

  function validMdSupported(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.create(null);
    const out = Object.create(null);
    for (const id of FORMATS.map((f) => f.id)) out[id] = value[id] === true;
    return out;
  }

  function cleanBridgePayload(type, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
    if (type === 'ready') return exactKeys(payload, []) ? {} : null;
    if (type === 'audio') {
      return exactKeys(payload, ['id', 'count']) &&
        isAudioId(payload.id) &&
        Number.isInteger(Number(payload.count)) &&
        Number(payload.count) >= 0 &&
        Number(payload.count) <= 200
        ? { id: payload.id, count: Number(payload.count) }
        : null;
    }
    if (type === 'elements') return exactKeys(payload, ['ids']) && validIdArray(payload.ids) ? { ids: payload.ids } : null;
    if (type === 'order') {
      return exactKeys(payload, ['ids', 'complete']) && validIdArray(payload.ids) && typeof payload.complete === 'boolean'
        ? { ids: payload.ids, complete: payload.complete }
        : null;
    }
    if (type === 'levels') return exactKeys(payload, ['levels']) ? { levels: cleanLevels(payload.levels) } : null;
    if (type === 'md-info') {
      if (!exactKeys(payload, ['editor', 'supported'])) return null;
      return {
        editor: payload.editor === true,
        supported: validMdSupported(payload.supported),
      };
    }
    if (type === 'md-active') {
      if (!exactKeys(payload, payload.editor === true ? ['editor', 'active'] : ['editor'])) return null;
      return payload.editor === true
        ? { editor: true, active: validMdActive(payload.active) }
        : { editor: false };
    }
    if (type === 'md-result') {
      if (!exactKeys(payload, ['seq', 'id', 'ok', 'editor', 'unsupported', 'active'])) return null;
      const seq = Number(payload.seq);
      const id = typeof payload.id === 'string' && FORMATS.some((f) => f.id === payload.id) ? payload.id : null;
      if (!Number.isInteger(seq) || seq < 1 || !id) return null;
      return {
        seq,
        id,
        ok: payload.ok === true,
        editor: payload.editor === true,
        unsupported: payload.unsupported === true,
        active: validMdActive(payload.active),
      };
    }
    if (type === 'state') {
      if (!exactKeys(payload, ['live', 'elements'])) return null;
      return {
        live: validIdArray(payload.live) ? payload.live : [],
        elements: Array.isArray(payload.elements) && payload.elements.length <= 200 ? payload.elements : [],
      };
    }
    return null;
  }

  function readBridgeMessage(e) {
    if (e.source !== window || e.origin !== window.location.origin) return null;
    const d = e.data;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    if (d.source !== CHANNEL_IN || d.token !== bridgeToken || !ALLOWED_IN_TYPES.has(d.type)) return null;
    if (typeof d.json !== 'string' || d.json.length > MAX_BRIDGE_JSON) return null;
    let payload = {};
    try { payload = d.json ? JSON.parse(d.json) : {}; } catch (_) { return null; }
    payload = cleanBridgePayload(d.type, payload);
    return payload ? { type: d.type, payload } : null;
  }

  /* If the MAIN-world content script never took effect — Firefox before 128
     ignores `world`, and some Chromium forks are inconsistent about it — pull
     the same file in as a page <script> instead. Requires the
     web_accessible_resources entry in the manifest. */
  function injectPageHook() {
    if (fallbackInjected) return;
    fallbackInjected = true;
    try {
      const s = document.createElement('script');
      s.src = API.runtime.getURL('main-world.js');
      s.async = false;
      s.onload = () => { send('init', {}); s.remove(); };
      (document.head || document.documentElement).appendChild(s);
      log('page hook was not active — injected it manually');
    } catch (e) {
      warn('could not inject the page hook; volume sliders will not work:', e);
    }
  }

  send('init', {});

  setTimeout(() => {
    if (pageReady) return;
    send('init', {});
    setTimeout(() => { if (!pageReady) injectPageHook(); }, 400);
  }, 1200);

  window.addEventListener('message', (e) => {
    const msg = readBridgeMessage(e);
    if (!msg) return;
    const d = { type: msg.type };
    const p = msg.payload;

    if (d.type === 'ready' || d.type === 'audio') {
      pageReady = true;
    } else if (d.type === 'elements') {
      // The set of live elements changed (someone joined or left). Creation
      // order is a reasonable first guess, so sliders work immediately; a
      // full sweep will confirm or correct it.
      if (!orderConfirmed || p.ids.length !== audioIds.length) {
        audioIds = p.ids;
        orderConfirmed = false;
        remap();
      }
    } else if (d.type === 'order') {
      // Only a sweep that touched every live element tells us the ordering.
      // Chatto also adjusts one participant at a time (local mute), and
      // treating that as the ordering would collapse the mapping to one
      // person.
      if (!p.complete) return;
      audioIds = p.ids;
      orderConfirmed = true;
      remap();
    } else if (d.type === 'levels') {
      learnFromVoice(p.levels || {});
    } else if (d.type === 'md-info') {
      mdBridgeInfo(p);
    } else if (d.type === 'md-active') {
      if (p.editor) paintActive(p.active);
    } else if (d.type === 'md-result') {
      mdBridgeResult(p);
    } else if (d.type === 'state') {
      window.__ceLastLive = p.live || [];
      log('page audio elements:', p.elements);
      log('mapping:', mapping);
    }
  });

  /** Remote participant cards, in DOM order, excluding ourselves. */
  function remoteCards() {
    return findCards().filter((c) => !isLocalCard(c));
  }

  function remap() {
    dropCache();
    const cards = remoteCards();
    const next = {};
    // Pair them off in order. If the counts disagree we only trust the
    // overlap rather than guessing.
    const n = Math.min(cards.length, audioIds.length);
    for (let i = 0; i < n; i++) next[nameOf(cards[i])] = audioIds[i];
    mapping = next;
    window.__ceMapping = mapping;
    if (window.__ceDebugOn) {
      log('remap:', cards.length, 'people,', audioIds.length, 'streams,',
          orderConfirmed ? 'confirmed' : 'provisional', mapping);
    }
    applyVolumes();
  }

  /* --- learning who is who from their voice -------------------------------
     Chatto marks the speaking participant on the card itself
     (data-call-speaking, set from LiveKit's audioLevel). When exactly one
     person is shown speaking and one stream is clearly the loudest, those two
     belong together. A few agreements in a row and we treat it as settled.

     v1.3 — this used to require exactly one stream above an absolute floor.
     Brave's fingerprinting protection adds noise to AudioContext output, so
     every stream sits slightly above any fixed floor and the test never
     passed. It now asks for relative dominance instead, which is robust to a
     raised noise floor. */

  const voiceScore = {};        // name -> { elementId: agreements }
  const VOICE_CONFIRM = 3;
  const SOUND_FLOOR = 0.02;
  const DOMINANCE = 2.5;        // loudest must beat runner-up by this factor

  function learnFromVoice(levels) {
    const speaking = remoteCards().filter(isSpeaking);
    if (speaking.length !== 1) return;

    const ranked = Object.keys(levels)
      .map((id) => [id, Number(levels[id]) || 0])
      .sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return;

    const [id, top] = ranked[0];
    const runnerUp = ranked.length > 1 ? ranked[1][1] : 0;
    if (top < SOUND_FLOOR) return;
    if (ranked.length > 1 && top < runnerUp * DOMINANCE) return;

    const name = nameOf(speaking[0]);
    if (mapping[name] === id) return;      // already known

    const s = (voiceScore[name] = voiceScore[name] || {});
    s[id] = (s[id] || 0) + 1;
    if (s[id] < VOICE_CONFIRM) return;

    // Settled. Take the stream off anyone it was wrongly assigned to.
    for (const other of Object.keys(mapping)) {
      if (mapping[other] === id) delete mapping[other];
    }
    mapping[name] = id;
    orderConfirmed = true;
    log('matched ' + name + ' to their voice');
    window.__ceMapping = mapping;
    applyVolumes();
  }

  /** Element id for a card: the learned mapping, else its position. */
  function idForCard(card) {
    const name = nameOf(card);
    if (mapping[name]) return mapping[name];
    const i = remoteCards().indexOf(card);
    return i >= 0 && i < audioIds.length ? audioIds[i] : null;
  }

  function applyVolumes() {
    for (const [name, id] of Object.entries(mapping)) {
      send('set', { id, factor: perceptualGain(name in volumes ? volumes[name] : 1) });
    }
  }

  function paintCard(card) {
    const wrap = card.querySelector('.ce-vol');
    if (!wrap) return;
    const v = getVol(nameOf(card));
    const pct = Math.round(v * 100);
    wrap.querySelector('.ce-vol-fill').style.width = pct + '%';
    wrap.querySelector('.ce-vol-knob').style.left = pct + '%';
    wrap.querySelector('.ce-vol-badge').textContent = pct === 0 ? 'Muted' : pct + '%';
    wrap.classList.toggle('ce-muted', pct === 0);
    wrap.setAttribute('aria-valuenow', String(pct));
  }

  function setVol(card, v) {
    // Round to whole percent: the wheel steps by 0.05/0.01 repeatedly and
    // binary floats drift (0.30000000000000004), which then shows up in
    // storage and in the badge.
    v = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
    const name = nameOf(card);
    volumes[name] = v;
    paintCard(card);
    const id = idForCard(card);
    if (id) send('set', { id, factor: perceptualGain(v) });
    else if (window.__ceDebugOn) log('no audio stream matched to ' + name + ' yet');
    saveSoon();
  }

  function resetAllVolumes() {
    volumes = Object.create(null);
    saveSoon();
    applyVolumes();
    findCards().forEach(paintCard);
  }

  function resetIcon() {
    const svg = svgEl('svg', {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'aria-hidden': 'true', width: '14', height: '14',
    });
    svg.appendChild(svgEl('path', { d: 'M3 12a9 9 0 1 0 3-6.7' }));
    svg.appendChild(svgEl('polyline', { points: '3 4 3 9 8 9' }));
    return svg;
  }

  /** One button, above the participant list, that clears every stored
      volume back to 100% at once — the existing per-slider double-click
      reset already covers one person at a time. Inserted as a sibling of
      [data-testid="call-participants-list"], a selector already relied on
      elsewhere (findCards()'s own fallback strategy), rather than beside
      Chatto's own call-controls row, whose exact markup this project has
      no DOM evidence for. */
  function ensureVolumeResetButton() {
    const list = qs('[data-testid="call-participants-list"]');
    if (!list || !list.parentElement) return;
    if (list.parentElement.querySelector('.ce-vol-reset-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ce-vol-reset-btn';
    btn.title = "Reset everyone's volume to 100%";
    btn.setAttribute('aria-label', 'Reset all volumes to 100%');
    btn.appendChild(resetIcon());
    btn.appendChild(document.createTextNode('Reset volumes'));
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resetAllVolumes();
    });
    list.parentElement.insertBefore(btn, list);
  }

  function addSlider(card) {
    if (isLocalCard(card)) { removeSlider(card); return; } // that's us
    if (card.querySelector('.ce-vol')) return;
    if (!inCall()) return;                        // not joined yet
    card.classList.add('ce-card');

    const wrap = document.createElement('div');
    wrap.className = 'ce-vol';
    wrap.setAttribute('role', 'slider');
    wrap.setAttribute('aria-label', 'Volume for ' + nameOf(card));
    wrap.setAttribute('aria-valuemin', '0');
    wrap.setAttribute('aria-valuemax', '100');
    wrap.title = 'Scroll or drag to set volume \u00b7 double-click to reset';
    const track = h('div', { class: 'ce-vol-track' }, [
      h('div', { class: 'ce-vol-fill' }),
      h('div', { class: 'ce-vol-knob' }),
    ]);
    wrap.appendChild(h('div', { class: 'ce-vol-badge', text: '100%' }));
    wrap.appendChild(track);
    card.appendChild(wrap);
    const fromX = (clientX) => {
      const r = track.getBoundingClientRect();
      return r.width ? (clientX - r.left) / r.width : 0;
    };

    // Drag anywhere along the bar.
    track.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { track.setPointerCapture(e.pointerId); } catch (_) {}
      wrap.classList.add('ce-dragging');
      setVol(card, fromX(e.clientX));
    });
    track.addEventListener('pointermove', (e) => {
      if (!wrap.classList.contains('ce-dragging')) return;
      e.preventDefault();
      setVol(card, fromX(e.clientX));
    });
    const endDrag = (e) => {
      if (!wrap.classList.contains('ce-dragging')) return;
      wrap.classList.remove('ce-dragging');
      try { track.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);

    // Double-click resets to full, which is quicker than dragging back.
    track.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setVol(card, 1);
    });

    // Scroll wheel. passive:false so the call panel doesn't scroll at the
    // same time as the volume changes.
    (WHEEL_TARGET === 'slider' ? wrap : card).addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const step = e.shiftKey ? 0.01 : 0.05;
      setVol(card, getVol(nameOf(card)) + (e.deltaY < 0 ? step : -step));
    }, { passive: false });

    // Keyboard access once the bar has focus.
    wrap.tabIndex = 0;
    wrap.addEventListener('keydown', (e) => {
      const cur = getVol(nameOf(card));
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { setVol(card, cur + 0.05); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { setVol(card, cur - 0.05); e.preventDefault(); }
      else if (e.key === 'Home') { setVol(card, 0); e.preventDefault(); }
      else if (e.key === 'End') { setVol(card, 1); e.preventDefault(); }
    });

    if (ready) paintCard(card);
  }

  /* =========================================================================
     PART 2 — EMOJI PICKER
     ========================================================================= */

  /* emoji-data.js assigns to `window`. In a Firefox content script `window` is
     an Xray wrapper over the page window and the assignment lands as a
     sandbox-local expando, which is fine — but read defensively across every
     global we might have been given, and say so loudly if the data never
     arrived, because "no emoji appear" and "emoji data failed to load" look
     identical from the outside. */
  function readEmojiData() {
    for (const scope of [typeof window !== 'undefined' ? window : null,
                         typeof globalThis !== 'undefined' ? globalThis : null,
                         typeof self !== 'undefined' ? self : null]) {
      try {
        if (scope && Array.isArray(scope.__CHATTO_EMOJI__) && scope.__CHATTO_EMOJI__.length) {
          return scope.__CHATTO_EMOJI__;
        }
      } catch (_) {}
    }
    return [];
  }
  const GROUPS = readEmojiData();

  function smileyIcon() {
    const svg = svgEl('svg', {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.7', 'stroke-linecap': 'round',
      'stroke-linejoin': 'round', 'aria-hidden': 'true',
    });
    svg.appendChild(svgEl('circle', { cx: '12', cy: '12', r: '9' }));
    svg.appendChild(svgEl('path', { d: 'M8.5 14.5a4.5 4.5 0 0 0 7 0' }));
    svg.appendChild(svgEl('path', { d: 'M9 9.5h.01M15 9.5h.01' }));
    return svg;
  }

  let picker = null;
  let savedRange = null;

  /* Some emoji default to TEXT presentation (monochrome or, on a system
     without the glyph, an empty box) unless followed by U+FE0F. 60 of the
     bundled set are in that category. CSS font-variant-emoji covers this on
     new browsers; appending the selector covers the rest. Harmless where it
     is already correct. */
  const VS16 = '\uFE0F';
  function emojiPresentation(ch) {
    if (ch.length !== 1) return ch;                 // already multi-codepoint
    const cp = ch.codePointAt(0);
    if (cp >= 0x1F000) return ch;                   // emoji-presentation plane
    return ch + VS16;
  }

  // Track the caret inside the composer continuously, so clicking the picker
  // (which blurs the editor) doesn't lose the insertion point.
  document.addEventListener('selectionchange', () => {
    const inp = findInput();
    if (!inp) return;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && inp.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  });

  /**
   * Chatto's composer is TipTap/ProseMirror, which keeps its own document
   * model — writing to the DOM directly would desync it. execCommand and the
   * synthetic paste both go through ProseMirror's own input handling, so the
   * editor stays consistent and the send button enables correctly.
   *
   * v1.3 — the order of the fallbacks now matters more, because Firefox
   * handles beforeinput/execCommand differently in contenteditable. We try
   * the paste path second and a real beforeinput third before touching the
   * DOM ourselves.
   */
  /* --- writing into the composer -----------------------------------------
     Shared by the emoji picker and the markdown toolbar.

     Chatto's composer is TipTap/ProseMirror, which keeps its own document
     model — writing to the DOM directly would desync it. Every path below
     goes through ProseMirror's own input handling instead, so the editor
     stays consistent and the send button enables correctly. */

  function restoreCaret(inp) {
    inp.focus();
    const sel = window.getSelection();
    if (savedRange && inp.contains(savedRange.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(savedRange);
    } else {
      const r = document.createRange();
      r.selectNodeContents(inp);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    return sel;
  }

  function rememberCaret(inp) {
    const s = window.getSelection();
    if (s && s.rangeCount && inp.contains(s.anchorNode)) {
      savedRange = s.getRangeAt(0).cloneRange();
    }
  }

  /** Replaces the current selection with `str`.
   *
   * mode picks the insertion path, and the two are NOT interchangeable —
   * Chatto's composer mangles each one differently:
   *
   *   'rich'    Paste. Chatto's ProseMirror runs a markdown parser on paste
   *             and turns the markers into real nodes. Correct for the four
   *             formats its schema can represent (bold, italic, inline code,
   *             link). Wrong for everything else: the parser consumes the
   *             syntax, finds no node to map it to, and drops both the
   *             markers and the formatting — which is why ~~strike~~, `##`,
   *             `-`, `1.` and `>` all came out as bare text.
   *
   *   'literal' execCommand. Leaves the characters verbatim so they survive
   *             to the server, whose markdown renderer supports far more than
   *             the composer's schema does. Not usable for bold/italic/code:
   *             those have live input rules that fire on text input and, when
   *             the whole wrapped string arrives in one transaction, delete a
   *             range shifted left by the prefix length — that is what turned
   *             "Test Bold" into "st Bold".
   *
   * Both fall back to the other path, then to beforeinput, then to writing
   * the node directly, so a wrong guess degrades rather than doing nothing.
   */
  function writeText(inp, str, mode) {
    const viaExec = () => {
      try { return document.execCommand('insertText', false, str); } catch (_) { return false; }
    };
    const viaPaste = () => {
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', str);
        return !inp.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: dt, bubbles: true, cancelable: true,
        }));
      } catch (_) { return false; }
    };

    let ok;
    if (mode === 'literal' && str.indexOf('\n') >= 0) {
      ok = writeLiteralLines(inp, str);
    } else if (mode === 'literal') {
      ok = viaExec() || viaPaste();
    } else {
      ok = viaPaste() || viaExec();
    }

    if (!ok) {
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', str);
        ok = !inp.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'insertText', data: str, dataTransfer: dt,
          bubbles: true, cancelable: true,
        }));
      } catch (_) {}
    }

    if (!ok) {
      try {
        const sel = window.getSelection();
        const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
        if (r) {
          r.deleteContents();
          const node = document.createTextNode(str);
          r.insertNode(node);
          r.setStartAfter(node);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
          inp.dispatchEvent(new InputEvent('input', {
            inputType: 'insertText', data: str, bubbles: true,
          }));
          ok = true;
        }
      } catch (_) {}
    }

    if (window.__ceDebugOn) log('write [' + (mode || 'rich') + ']', JSON.stringify(str), ok ? 'ok' : 'FAILED');
    if (!ok) warn('could not write into the composer — please report this.');
    return ok;
  }

  /* Multi-line literal text. execCommand('insertText') flattens newlines, so
     each line goes in separately with a break between them.
     
     The break is a paste of a bare "\n", NOT a synthetic Shift+Enter keydown.
     The keydown approach worked in testing but is unsafe in the real app:
     Chatto's composer handles Enter, and a synthetic one is capable of firing
     off a half-written message. A bug that formats badly is annoying; a bug
     that sends your draft is not acceptable. A lone newline also has no
     markdown meaning, so routing it through paste cannot be misparsed. */
  function pasteBreak(inp) {
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', '\n');
      return !inp.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true,
      }));
    } catch (_) { return false; }
  }

  function writeLiteralLines(inp, str) {
    const lines = str.split('\n');
    let ok = true;
    for (let i = 0; i < lines.length; i++) {
      // The first write replaces the selection; the rest append. When line 0
      // is empty (a leading break), the break itself does the replacing.
      if (i && !pasteBreak(inp)) ok = false;
      if (lines[i]) {
        let wrote = false;
        try { wrote = document.execCommand('insertText', false, lines[i]); } catch (_) {}
        if (!wrote) ok = false;
      }
    }
    return ok;
  }

  /** Steps the caret back n characters, for landing it inside new markers. */
  function moveCaretBack(n) {
    const sel = window.getSelection();
    if (!sel || typeof sel.modify !== 'function') return;
    for (let i = 0; i < n; i++) sel.modify('move', 'backward', 'character');
  }

  function insertEmoji(ch) {
    const inp = (pickerFor && findInputs().find((el) => el.dataset.ceCid === pickerFor))
             || findInput();
    if (!inp) return false;

    restoreCaret(inp);
    // 'literal' keeps the original execCommand-first order, which is the path
    // emoji insertion has been working on since 1.2. An emoji has no markdown
    // meaning, so there is nothing for the composer's parser to do either way.
    const ok = writeText(inp, ch, 'literal');
    rememberCaret(inp);

    // Update recents regardless of whether the insertion succeeded. The user
    // clearly wanted this emoji; if the insertion path failed silently they
    // can try again, but the recent list should still reflect their intent.
    recents = [ch, ...recents.filter((c) => c !== ch)].slice(0, MAX_RECENTS);
    saveSoon();
    return ok;
  }


  function emojiCell(ch, name) {
    return h('button', {
      class: 'ce-em', type: 'button', title: name,
      dataset: { e: ch, n: name }, text: emojiPresentation(ch),
    });
  }

  function emojiSection(slug, title, entries) {
    const grid = h('div', { class: 'ce-sec-grid' });
    const frag = document.createDocumentFragment();
    for (const [c, n] of entries) frag.appendChild(emojiCell(c, n));
    grid.appendChild(frag);
    return h('div', { class: 'ce-sec', dataset: { sec: slug } }, [
      h('div', { class: 'ce-sec-title', text: title }),
      grid,
    ]);
  }

  function sectionsNodes(query) {
    const out = document.createDocumentFragment();

    if (!GROUPS.length) {
      out.appendChild(h('div', { class: 'ce-pick-empty' }, [
        document.createTextNode('Emoji data failed to load.'),
        h('br'),
        document.createTextNode('Check that emoji-data.js is in the extension folder.'),
      ]));
      return out;
    }

    const q = query.trim().toLowerCase();
    let any = false;

    if (!q && recents.length) {
      out.appendChild(emojiSection('recent', 'Recently used',
        recents.map((c) => [c, 'recently used'])));
      any = true;
    }

    for (const g of GROUPS) {
      const list = q ? g.e.filter(([, n]) => n.includes(q)) : g.e;
      if (!list.length) continue;
      out.appendChild(emojiSection(g.s, g.n, list));
      any = true;
    }

    if (!any) {
      out.appendChild(h('div', { class: 'ce-pick-empty', text: 'No emoji matches that search.' }));
    }
    return out;
  }

  /* Scroll a section to the top of the body without relying on offsetTop,
     which is unreliable once content-visibility is skipping offscreen grids. */
  function scrollToSection(body, sec) {
    if (!sec) return;
    body.scrollTop += sec.getBoundingClientRect().top - body.getBoundingClientRect().top;
  }

  function buildPicker() {
    const tabs = h('div', { class: 'ce-pick-tabs' });
    GROUPS.forEach((g, i) => {
      tabs.appendChild(h('button', {
        class: 'ce-tab' + (i === 0 ? ' ce-tab-on' : ''),
        type: 'button', title: g.n,
        dataset: { go: g.s }, text: emojiPresentation(g.i),
      }));
    });

    const search = h('input', {
      type: 'text', placeholder: 'Search emoji', spellcheck: 'false',
    });
    const body = h('div', { class: 'ce-pick-body' });
    body.appendChild(sectionsNodes(''));

    const footEm = h('span', { class: 'ce-foot-em', text: emojiPresentation('\u{1F642}') });
    const footName = h('span', { class: 'ce-foot-name', text: 'Pick an emoji' });

    const el = h('div', { class: 'ce-pick', role: 'dialog', 'aria-label': 'Emoji picker' }, [
      tabs,
      h('div', { class: 'ce-pick-search' }, [search]),
      body,
      h('div', { class: 'ce-pick-foot' }, [footEm, footName]),
    ]);

    const rerender = (q) => body.replaceChildren(sectionsNodes(q));

    // Keep focus in the editor when clicking an emoji.
    body.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ce-em')) e.preventDefault();
    });

    body.addEventListener('click', (e) => {
      const b = e.target.closest('.ce-em');
      if (!b) return;
      insertEmoji(b.dataset.e);
      // Shift-click to keep going without reopening.
      if (!e.shiftKey) closePicker();
    });

    body.addEventListener('mouseover', (e) => {
      const b = e.target.closest('.ce-em');
      if (!b) return;
      footEm.textContent = emojiPresentation(b.dataset.e);
      footName.textContent = b.dataset.n;
    });

    let searchTimer = null;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        rerender(search.value);
        body.scrollTop = 0;
      }, 90);
    });

    tabs.addEventListener('click', (e) => {
      const t = e.target.closest('.ce-tab');
      if (!t) return;
      search.value = '';
      rerender('');
      const sec = Array.prototype.find.call(
        body.querySelectorAll('.ce-sec'), (x) => x.dataset.sec === t.dataset.go);
      scrollToSection(body, sec);
      tabs.querySelectorAll('.ce-tab').forEach((x) => x.classList.toggle('ce-tab-on', x === t));
    });

    // Highlight the tab for whichever section is in view.
    body.addEventListener('scroll', () => {
      const top = body.getBoundingClientRect().top;
      let cur = null;
      for (const sec of body.querySelectorAll('.ce-sec')) {
        if (sec.getBoundingClientRect().top - top <= 12) cur = sec;
      }
      if (!cur) return;
      tabs.querySelectorAll('.ce-tab').forEach((x) =>
        x.classList.toggle('ce-tab-on', x.dataset.go === cur.dataset.sec));
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closePicker(); }
    });

    el.__ceSearch = search;
    return el;
  }

  function place(btn) {
    if (!picker) return;
    const r = btn.getBoundingClientRect();
    const w = picker.offsetWidth || 352;
    const h = picker.offsetHeight || 380;
    let left = Math.min(r.right - w, window.innerWidth - w - 10);
    left = Math.max(10, left);
    let top = r.top - h - 8;
    if (top < 10) top = Math.min(r.bottom + 8, window.innerHeight - h - 10);
    picker.style.left = left + 'px';
    picker.style.top = Math.max(10, top) + 'px';
  }

  function closePicker() {
    pickerFor = null;
    if (!picker) return;
    picker.remove();
    picker = null;
    document.querySelectorAll('.ce-emoji-btn').forEach((b) => b.classList.remove('ce-open'));
    document.removeEventListener('mousedown', onDocDown, true);
    window.removeEventListener('resize', onReflow, true);
    window.removeEventListener('scroll', onReflow, true);
  }

  function onDocDown(e) {
    if (picker && !picker.contains(e.target) && !e.target.closest('.ce-emoji-btn')) closePicker();
  }

  function onReflow() {
    const btn = document.querySelector('.ce-emoji-btn.ce-open');
    if (btn) place(btn);
  }

  /* The composer whose button opened the picker. Without this, an emoji
     chosen from a thread's picker could land in the main channel's box: by
     the time the click lands, focus is in the picker's search field and the
     "which composer is active" question has no good answer. */
  let pickerFor = null;

  function togglePicker(btn) {
    if (picker) { closePicker(); return; }
    pickerFor = btn.dataset.ceFor || null;
    picker = buildPicker();
    document.body.appendChild(picker);
    btn.classList.add('ce-open');
    place(btn);
    if (picker.__ceSearch) picker.__ceSearch.focus();
    document.addEventListener('mousedown', onDocDown, true);
    window.addEventListener('resize', onReflow, true);
    window.addEventListener('scroll', onReflow, true);
  }

  function makeEmojiButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ce-emoji-btn';
    btn.title = 'Emoji';
    btn.setAttribute('aria-label', 'Insert emoji');
    btn.appendChild(smileyIcon());
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep caret
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePicker(btn);
    });
    return btn;
  }

  /* The button no longer depends on finding the send button. If every
     strategy for that fails — a renamed testid, a translated aria-label — it
     floats in the corner of the composer instead of not existing.

     One button per composer. A thread panel is a second composer, and the old
     "does a button exist anywhere?" check meant it never got one. Each button
     records the composer it belongs to so orphans can be cleaned up when a
     panel closes. */
  function addEmojiButton() {
    const inputs = findInputs();
    const live = new Set(inputs.map(cidOf));

    // Drop buttons whose composer is gone (thread closed, view swapped).
    qsa('.ce-emoji-btn').forEach((b) => {
      if (!b.isConnected || !live.has(b.dataset.ceFor)) b.remove();
    });

    for (const inp of inputs) {
      const cid = cidOf(inp);
      const existing = qsa('.ce-emoji-btn').find((b) => b.dataset.ceFor === cid);
      if (existing && existing.isConnected) continue;

      const btn = makeEmojiButton();
      btn.dataset.ceFor = cid;
      const sendBtn = findSendButton(inp);

      if (sendBtn && sendBtn.parentElement) {
        btn.dataset.ceAnchor = 'send:' + (strategyUsed.send || '?');
        sendBtn.parentElement.insertBefore(btn, sendBtn);
        continue;
      }

      const composer = findComposer(inp);
      if (!composer) continue;
      composer.classList.add('ce-composer');
      btn.classList.add('ce-emoji-float');
      btn.dataset.ceAnchor = 'float';
      composer.appendChild(btn);
      warn('no send button matched; the emoji button is floating in the composer instead. ' +
           'Run __ceDebug() if it is in an awkward place.');
    }
  }

  /* =========================================================================
     PART 2b — GIF PICKER

     Searches Giphy (via background.js — see the comment there for why a
     content script can't just fetch() this itself) and, on pick, uploads
     the GIF as a real file rather than pasting its URL as text. Chatto
     evidently doesn't animate a bare GIF link (confirmed by hand: a link
     sits static, an uploaded .gif file plays), so a link would just
     reproduce that limitation. Insertion goes through the same synthetic
     paste technique writeText() already uses for text — a DataTransfer
     carrying a File dispatched as a 'paste' ClipboardEvent — on the working
     assumption that Chatto's composer treats a pasted image as an upload
     the same way most chat apps do. That assumption is the one part of this
     feature not confirmed against the live app; if it doesn't upload,
     that's the first thing to check.
     ========================================================================= */

  let gifPicker = null;
  let gifPickerFor = null;
  let gifNextOffset = null;
  let gifQuery = '';
  let gifSearchSeq = 0;
  let gifTab = 'search'; // 'search' | 'favorites'

  // Populated by the combined storageGet() near the top of this file.
  let gifFavorites = [];

  function isGifFavorited(id) {
    return gifFavorites.some((f) => f.id === id);
  }

  function toggleGifFavorite(result) {
    const clean = cleanGifFavorite(result);
    if (!clean) return isGifFavorited(result && result.id);
    const i = gifFavorites.findIndex((f) => f.id === clean.id);
    if (i >= 0) {
      gifFavorites.splice(i, 1);
    } else {
      gifFavorites.unshift(clean);
      if (gifFavorites.length > MAX_GIF_FAVORITES) gifFavorites.length = MAX_GIF_FAVORITES;
    }
    storageSet({ gifFavorites });
    return i < 0; // true if it just became a favorite
  }

  /* Feather Icons' "image" glyph (MIT license, feathericons.com) — reused
     as-is rather than hand-drawn, and kept to this codebase's existing
     stroke-icon convention (currentColor, no fill) so it matches every
     other icon in the toolbar. */
  function gifIcon() {
    const svg = svgEl('svg', {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.7', 'stroke-linecap': 'round',
      'stroke-linejoin': 'round', 'aria-hidden': 'true',
    });
    svg.appendChild(svgEl('rect', { x: '3', y: '3', width: '18', height: '18', rx: '2', ry: '2' }));
    svg.appendChild(svgEl('circle', { cx: '8.5', cy: '8.5', r: '1.5' }));
    svg.appendChild(svgEl('polyline', { points: '21 15 16 10 5 21' }));
    return svg;
  }

  function makeGifButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ce-gif-btn';
    btn.title = 'GIF';
    btn.setAttribute('aria-label', 'Insert GIF');
    btn.appendChild(gifIcon());
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleGifPicker(btn);
    });
    return btn;
  }

  /** One button per composer, docked right beside that composer's emoji
      button — mirrors addEmojiButton() exactly, including its cleanup and
      float-as-last-resort behavior. */
  function addGifButton() {
    const inputs = findInputs();
    const live = new Set(inputs.map(cidOf));

    qsa('.ce-gif-btn').forEach((b) => {
      if (!b.isConnected || !live.has(b.dataset.ceFor)) b.remove();
    });

    for (const inp of inputs) {
      const cid = cidOf(inp);
      const existing = qsa('.ce-gif-btn').find((b) => b.dataset.ceFor === cid);
      if (existing && existing.isConnected) continue;

      const btn = makeGifButton();
      btn.dataset.ceFor = cid;
      const emojiBtn = qsa('.ce-emoji-btn').find((b) => b.dataset.ceFor === cid);

      if (emojiBtn && emojiBtn.parentElement) {
        emojiBtn.parentElement.insertBefore(btn, emojiBtn);
        continue;
      }

      const sendBtn = findSendButton(inp);
      if (sendBtn && sendBtn.parentElement) {
        sendBtn.parentElement.insertBefore(btn, sendBtn);
        continue;
      }

      const composer = findComposer(inp);
      if (!composer) continue;
      composer.classList.add('ce-composer');
      btn.classList.add('ce-emoji-float');
      composer.appendChild(btn);
    }
  }

  function buildGifPicker() {
    const tabSearch = h('button', {
      type: 'button', class: 'ce-tab ce-gif-tab ce-tab-on', text: 'GIFs',
    });
    const tabFavorites = h('button', {
      type: 'button', class: 'ce-tab ce-gif-tab', text: '★ Favorites',
    });
    const tabs = h('div', { class: 'ce-pick-tabs ce-gif-tabs' }, [tabSearch, tabFavorites]);

    const search = h('input', {
      type: 'text', placeholder: 'Search GIPHY', spellcheck: 'false', class: 'ce-gif-search',
    });
    const body = h('div', { class: 'ce-pick-body ce-gif-body' });

    const el = h('div', { class: 'ce-pick ce-gif-pick', role: 'dialog', 'aria-label': 'GIF picker' }, [
      tabs,
      h('div', { class: 'ce-pick-search' }, [search]),
      body,
    ]);

    function starButton(r) {
      const star = h('button', {
        type: 'button', class: 'ce-gif-star' + (isGifFavorited(r.id) ? ' ce-gif-star-on' : ''),
        title: 'Favorite', 'aria-label': 'Toggle favorite', text: '★',
      });
      star.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
      star.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nowFavorited = toggleGifFavorite(r);
        star.classList.toggle('ce-gif-star-on', nowFavorited);
        // Un-favoriting while looking at the Favorites tab should drop the
        // tile immediately rather than leave a favorite-less item in a list
        // that is, by definition, only ever the favorited ones.
        if (!nowFavorited && gifTab === 'favorites') star.closest('.ce-gif-item').remove();
      });
      return star;
    }

    function gifTile(r) {
      const btn = h('button', {
        type: 'button', class: 'ce-gif-item', title: r.title || 'GIF',
        'aria-label': r.title || 'Insert GIF',
      });
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = r.previewUrl;
      img.alt = r.title || '';
      btn.appendChild(img);
      btn.appendChild(starButton(r));
      btn.dataset.url = r.url;
      btn.__ceGif = r;
      return btn;
    }

    function renderResults(results, append) {
      const grid = append && body.querySelector('.ce-gif-grid')
        ? body.querySelector('.ce-gif-grid')
        : h('div', { class: 'ce-gif-grid' });
      for (const r of results) grid.appendChild(gifTile(r));
      if (!append) body.replaceChildren(grid);
      else if (!body.contains(grid)) body.appendChild(grid);
    }

    let loadingMore = false;
    async function loadMore() {
      if (gifTab !== 'search' || loadingMore || gifNextOffset === null) return;
      loadingMore = true;
      const seq = gifSearchSeq;
      const r = await sendBg({ type: 'gif-search', query: gifQuery, offset: gifNextOffset });
      loadingMore = false;
      if (seq !== gifSearchSeq || !r.ok) return;
      gifNextOffset = typeof r.nextOffset === 'number' ? r.nextOffset : null;
      renderResults(r.results, true);
    }

    async function runSearch(q) {
      gifQuery = q;
      const seq = ++gifSearchSeq;
      body.replaceChildren(h('div', { class: 'ce-pick-empty', text: 'Loading…' }));
      const r = await sendBg({ type: 'gif-search', query: q });
      if (seq !== gifSearchSeq) return;
      if (!r.ok) {
        const msg = r.error === 'no-key' || r.error === 'bad-key'
          ? 'GIF search isn’t configured for this build.'
          : 'GIF search is unavailable right now.';
        body.replaceChildren(h('div', { class: 'ce-pick-empty', text: msg }));
        return;
      }
      gifNextOffset = typeof r.nextOffset === 'number' ? r.nextOffset : null;
      if (!r.results.length) {
        body.replaceChildren(h('div', { class: 'ce-pick-empty', text: 'No GIFs matched that search.' }));
        return;
      }
      renderResults(r.results, false);
    }

    function renderFavorites(q) {
      const list = q
        ? gifFavorites.filter((f) => f.title.toLowerCase().includes(q.toLowerCase()))
        : gifFavorites;
      if (!list.length) {
        body.replaceChildren(h('div', {
          class: 'ce-pick-empty',
          text: gifFavorites.length ? 'No favorites match that search.' : 'No favorites yet — click the star on any GIF to save it here.',
        }));
        return;
      }
      renderResults(list, false);
    }

    function setTab(tab) {
      gifTab = tab;
      tabSearch.classList.toggle('ce-tab-on', tab === 'search');
      tabFavorites.classList.toggle('ce-tab-on', tab === 'favorites');
      search.placeholder = tab === 'search' ? 'Search GIPHY' : 'Filter favorites';
      if (tab === 'search') runSearch(search.value.trim());
      else renderFavorites(search.value.trim());
    }

    body.addEventListener('scroll', () => {
      if (body.scrollTop + body.clientHeight > body.scrollHeight - 200) loadMore();
    });

    body.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ce-gif-item')) e.preventDefault();
    });

    body.addEventListener('click', (e) => {
      const btn = e.target.closest('.ce-gif-item');
      if (!btn) return;
      insertGif(btn.dataset.url, btn);
    });

    let searchTimer = null;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = search.value.trim();
      searchTimer = setTimeout(() => {
        if (gifTab === 'search') runSearch(q);
        else renderFavorites(q);
      }, 250);
    });

    tabSearch.addEventListener('mousedown', (e) => e.preventDefault());
    tabFavorites.addEventListener('mousedown', (e) => e.preventDefault());
    tabSearch.addEventListener('click', () => setTab('search'));
    tabFavorites.addEventListener('click', () => setTab('favorites'));

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeGifPicker(); }
    });

    el.__ceSearch = search;
    setTab('search');

    return el;
  }

  function placeGif(btn) {
    if (!gifPicker) return;
    const r = btn.getBoundingClientRect();
    const w = gifPicker.offsetWidth || 320;
    const hgt = gifPicker.offsetHeight || 380;
    let left = Math.min(r.right - w, window.innerWidth - w - 10);
    left = Math.max(10, left);
    let top = r.top - hgt - 8;
    if (top < 10) top = Math.min(r.bottom + 8, window.innerHeight - hgt - 10);
    gifPicker.style.left = left + 'px';
    gifPicker.style.top = Math.max(10, top) + 'px';
  }

  function closeGifPicker() {
    gifPickerFor = null;
    if (!gifPicker) return;
    gifPicker.remove();
    gifPicker = null;
    document.querySelectorAll('.ce-gif-btn').forEach((b) => b.classList.remove('ce-open'));
    document.removeEventListener('mousedown', onGifDocDown, true);
    window.removeEventListener('resize', onGifReflow, true);
    window.removeEventListener('scroll', onGifReflow, true);
  }

  function onGifDocDown(e) {
    if (gifPicker && !gifPicker.contains(e.target) && !e.target.closest('.ce-gif-btn')) closeGifPicker();
  }

  function onGifReflow() {
    const btn = document.querySelector('.ce-gif-btn.ce-open');
    if (btn) placeGif(btn);
  }

  function toggleGifPicker(btn) {
    if (gifPicker) { closeGifPicker(); return; }
    gifPickerFor = btn.dataset.ceFor || null;
    gifPicker = buildGifPicker();
    document.body.appendChild(gifPicker);
    btn.classList.add('ce-open');
    placeGif(btn);
    if (gifPicker.__ceSearch) gifPicker.__ceSearch.focus();
    document.addEventListener('mousedown', onGifDocDown, true);
    window.addEventListener('resize', onGifReflow, true);
    window.addEventListener('scroll', onGifReflow, true);
  }

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function insertGif(url, btn) {
    const inputs = findInputs();
    const inp = inputs.find((el) => cidOf(el) === gifPickerFor) || findInput();
    if (!inp || !url) return;

    if (btn) btn.classList.add('ce-gif-loading');
    const r = await sendBg({ type: 'gif-fetch', url });
    if (btn) btn.classList.remove('ce-gif-loading');
    if (!r.ok) {
      warn('could not fetch that GIF (' + r.error + ') — nothing inserted.');
      return;
    }

    let file;
    try {
      const bytes = base64ToBytes(r.base64);
      file = new File([bytes], 'giphy.gif', { type: r.type || 'image/gif' });
    } catch (_) {
      warn('could not build a file from the fetched GIF — nothing inserted.');
      return;
    }

    closeGifPicker();
    inp.focus();

    let ok = false;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      ok = !inp.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true,
      }));
    } catch (_) { ok = false; }

    if (!ok) warn('pasting the GIF into the composer did not seem to work — ' +
                   'this may be a Chatto limitation rather than an extension bug.');
  }

  /* =========================================================================
     PART 3 — MARKDOWN TOOLBAR

     A toolbar is docked directly above each composer, always visible —
     like a native app's formatting bar, not a popup tied to the selection.
     Select text (or just place the caret) and click a button, or use its
     shortcut, to apply a format.

     The format set below matches what Chatto actually renders, confirmed by
     pasting a full markdown syntax guide into a message and reading back what
     survived. Notably absent: spoilers (`||text||`), which Chatto does not
     support at all.

     Since 1.9 the preferred way to apply a format is through Chatto's own
     editor commands, reached via main-world.js — see the comment above
     applyFormat. The marker-writing described below is the fallback path.
     ========================================================================= */

  /* `mode` only matters on the fallback path — the bridge ignores it.
     It is not a style preference — see writeText. 'rich' means Chatto's
     composer has a node for this and should render it itself; 'literal' means
     it does not, and the markers have to survive untouched to the server.

     Which is which was determined by testing, not guessed: pasting each
     format into the composer and reading back what survived. If a future
     Chatto release adds strikethrough or headings to its editor schema, move
     that line to 'rich'. */
  const FORMATS = [
    { id: 'bold',    title: 'Bold',          hint: 'Ctrl+B',       text: 'B',
      prefix: '**', suffix: '**', key: 'b', mode: 'rich' },
    { id: 'italic',  title: 'Italic',        hint: 'Ctrl+I',       text: 'I',
      prefix: '*',  suffix: '*',  key: 'i', mode: 'rich' },
    { id: 'strike',  title: 'Strikethrough', hint: 'Ctrl+Shift+X', text: 'S',
      prefix: '~~', suffix: '~~', key: 'x', shift: true, mode: 'literal' },

    { id: 'heading', title: 'Heading',       text: 'H', sep: true,
      line: '## ', block: true, mode: 'literal' },
    { id: 'bullet',  title: 'Bulleted list', icon: 'bullet',
      line: '- ', block: true, mode: 'literal' },
    { id: 'ordered', title: 'Numbered list', icon: 'ordered',
      line: (l, i) => (i + 1) + '. ', lineRe: /^\d+\.\s/, block: true, mode: 'literal' },
    { id: 'quote',   title: 'Quote',         icon: 'quote',
      line: '> ', block: true, mode: 'literal' },

    { id: 'code',    title: 'Inline code',   hint: 'Ctrl+E',       icon: 'code',
      prefix: '`', suffix: '`', key: 'e', sep: true, mode: 'rich' },
    { id: 'block',   title: 'Code block',    icon: 'block',
      fence: true, block: true, mode: 'literal' },

    { id: 'link',    title: 'Link',          hint: 'Ctrl+K',       icon: 'link',
      link: true, key: 'k', sep: true, mode: 'rich' },
  ];

  /* Shortcuts are deliberately limited to the five that are safe. The obvious
     candidates for the block formats are all taken by the browser itself:
     Ctrl+Shift+H opens the Firefox history library, Ctrl+Shift+O the bookmark
     manager, and Ctrl+Shift+E/M/K/I/J/C are devtools panels that are not
     cancelable from page script. Those formats are button-only rather than
     shortcuts that work on one browser and hijack another. */

  const ICONS = {
    bullet: ['M4.5 8h.01', 'M4.5 16h.01', 'M9.5 8h10', 'M9.5 16h10'],
    ordered: ['M4 6.6 5.2 6v4', 'M3.4 14.5c0-.6.6-1.1 1.3-1.1s1.3.5 1.3 1.1c0 1.2-2.6 1.9-2.6 3.5h2.8',
              'M9.5 8h10', 'M9.5 16h10'],
    quote: ['M6 5v14', 'M11 9h8', 'M11 13h8', 'M11 17h5'],
    code: ['M9 7 4.5 12 9 17', 'M15 7l4.5 5-4.5 5'],
    block: ['M4 5.5h16v13H4z', 'M9.5 10 8 12l1.5 2', 'M14.5 10 16 12l-1.5 2'],
    link: ['M10.5 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1 1',
           'M13.5 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1-1'],
  };

  function iconEl(name) {
    const svg = svgEl('svg', {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.7', 'stroke-linecap': 'round',
      'stroke-linejoin': 'round', 'aria-hidden': 'true',
    });
    for (const d of ICONS[name] || []) svg.appendChild(svgEl('path', { d }));
    return svg;
  }

  /** The nearest block-level ancestor of a node inside the composer. */
  function blockAncestorOf(inp, node) {
    let n = node && node.nodeType === 3 ? node.parentElement : node;
    while (n && n !== inp) {
      let d = '';
      try { d = getComputedStyle(n).display; } catch (_) {}
      if (d && d !== 'inline' && d !== 'inline-block' && d !== 'contents') return n;
      n = n.parentElement;
    }
    return inp;
  }

  /* Whether the selection begins at the start of its own line.
   *
   * Range.toString() cannot answer this. It flattens block boundaries without
   * emitting a newline, so with <p>one</p><p>two</p> the text before "two"
   * reads as "one" — no trailing newline — and every heading, quote and list
   * item got a blank line inserted above it that nobody asked for.
   *
   * Measuring against the enclosing block instead, and treating a trailing
   * <br> as a line start too. */
  function atLineStart(inp, range) {
    const block = blockAncestorOf(inp, range.startContainer);
    const r = document.createRange();
    try {
      r.selectNodeContents(block);
      r.setEnd(range.startContainer, range.startOffset);
    } catch (_) { return true; }

    const before = r.toString();
    if (!before.length) return true;        // start of the block
    if (/\n$/.test(before)) return true;    // explicit newline

    try {
      // Walk back past empty text nodes; a <br> as the last real thing before
      // us means we are at the start of a line inside the same block.
      let n = r.cloneContents().lastChild;
      while (n) {
        if (n.nodeType === 3) {
          if (n.data.length) return false;
          n = n.previousSibling;
        } else if (n.nodeName === 'BR') {
          return true;
        } else if (n.lastChild) {
          n = n.lastChild;
        } else {
          return false;
        }
      }
    } catch (_) {}

    return false;
  }

  /* If the markers sit just outside the selection — double-clicking a word
     that is already bold selects `word`, not `**word**` — widen the selection
     over them so the format toggles off instead of nesting.

     Only handled when both ends are in the same text node, which is the
     normal case in a chat composer. Spanning nodes falls through to wrapping,
     which is recoverable by the user; a wrong guess at a range boundary is
     not. */
  function unwrapOutside(sel, range, p, s) {
    const sc = range.startContainer, ec = range.endContainer;
    if (sc.nodeType !== 3 || ec.nodeType !== 3) return false;
    if (range.startOffset < p.length) return false;
    if (sc.data.slice(range.startOffset - p.length, range.startOffset) !== p) return false;
    if (ec.data.slice(range.endOffset, range.endOffset + s.length) !== s) return false;

    const r = document.createRange();
    r.setStart(sc, range.startOffset - p.length);
    r.setEnd(ec, range.endOffset + s.length);
    sel.removeAllRanges();
    sel.addRange(r);
    return true;
  }

  /** The last `n` characters before the caret, within its own block. */
  function textJustBefore(inp, n) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return '';
    const r = sel.getRangeAt(0);
    const block = blockAncestorOf(inp, r.startContainer);
    const rr = document.createRange();
    try {
      rr.selectNodeContents(block);
      rr.setEnd(r.startContainer, r.startOffset);
    } catch (_) { return ''; }
    return rr.toString().slice(-n);
  }

  function execInsert(str) {
    try { return document.execCommand('insertText', false, str); } catch (_) { return false; }
  }

  /* Line-prefix formats (heading, lists, quote).
   *
   * The marker goes in on its own, as a separate write ending in its space,
   * and the content follows in a second write. That is not a stylistic
   * choice — it is the whole fix.
   *
   * Chatto's ProseMirror has input rules that turn "> ", "## ", "- " and
   * "1. " at the start of a line into real blockquote / heading / list nodes.
   * Those rules match text *ending* in the marker, so writing
   * "> test quote" as one chunk never triggers them: the characters stay as
   * literal text in an ordinary paragraph, and the editor's serializer
   * escapes leading block markers on the way out so they cannot accidentally
   * format. Result: the markers reach the server escaped and render as plain
   * text — exactly the symptom.
   *
   * Typing "> " by hand works, so we type "> " too. If a future Chatto has no
   * such input rule, the marker simply stays literal and we are no worse off
   * than before. */
  /* --- plain-text offsets, for restoring a selection after a write -------
     Offsets are measured with Range.toString(), which flattens block
     boundaries. That is fine because both the read and the write use the same
     measure — it only has to be self-consistent, not faithful. */

  function offsetAt(inp, container, offset) {
    const r = document.createRange();
    try {
      r.selectNodeContents(inp);
      r.setEnd(container, offset);
    } catch (_) { return -1; }
    return r.toString().length;
  }

  function caretOffset(inp) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return -1;
    const r = sel.getRangeAt(0);
    return offsetAt(inp, r.startContainer, r.startOffset);
  }

  function selectByOffset(inp, start, end) {
    if (start < 0 || end <= start) return false;
    let sN = null, sO = 0, eN = null, eO = 0, pos = 0, n;
    // 4 === NodeFilter.SHOW_TEXT. Using the constant directly avoids depending
    // on a global that is not guaranteed to be present in every host.
    const walk = document.createTreeWalker(inp, 4, null);
    while ((n = walk.nextNode())) {
      const len = n.data.length;
      if (!sN && pos + len >= start) { sN = n; sO = start - pos; }
      if (sN && pos + len >= end) { eN = n; eO = end - pos; break; }
      pos += len;
    }
    if (!sN || !eN) return false;
    try {
      const r = document.createRange();
      r.setStart(sN, Math.max(0, Math.min(sO, sN.data.length)));
      r.setEnd(eN, Math.max(0, Math.min(eO, eN.data.length)));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return true;
    } catch (_) { return false; }
  }

  /* Block formats apply to whole lines.
   *
   * Double-clicking a word selects that word, so applying Code block to
   * "block" in "Test code block" tore just that word out into its own fence
   * and left "Test code" stranded on the line above with a break between
   * them. Nobody means that. Every editor treats a block format as acting on
   * the line the cursor is in, so the selection is widened to whole blocks
   * before anything is written.
   *
   * Returns the block elements themselves, not their text. sel.toString()
   * cannot be used here at all: it drops block boundaries without emitting
   * newlines, so a two-line selection comes back as one run-together line. */
  function expandToLines(inp, sel) {
    if (!sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    const first = blockAncestorOf(inp, r.startContainer);
    const last = blockAncestorOf(inp, r.endContainer);
    if (!first || first === inp || !first.parentElement) return null;

    const blocks = [];
    let n = first;
    while (n && blocks.length < 200) {
      blocks.push(n);
      if (n === last) break;
      n = n.nextElementSibling;
    }
    if (!blocks.length || blocks[blocks.length - 1] !== last) return null;

    try {
      const nr = document.createRange();
      nr.setStart(blocks[0], 0);
      const lastB = blocks[blocks.length - 1];
      nr.setEnd(lastB, lastB.childNodes.length);
      sel.removeAllRanges();
      sel.addRange(nr);
    } catch (_) { return null; }

    return blocks;
  }

  function selectContentsOf(el) {
    try {
      const r = document.createRange();
      r.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return true;
    } catch (_) { return false; }
  }

  function applyLineFormat(inp, fmt, blocks, selected, lead) {
    const lines = blocks ? blocks.map((b) => b.textContent)
                         : (selected || '').split('\n');
    const re = fmt.lineRe ||
      new RegExp('^' + String(fmt.line).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const already = lines.length > 0 && lines.every((l) => re.test(l));
    const markFor = (text, i) =>
      (typeof fmt.line === 'function' ? fmt.line(text, i) : fmt.line);

    /* Each line already has its own block, so rewrite them one at a time.
       No line breaks have to be manufactured, and — crucially — no range ever
       spans a block boundary. Replacing a cross-block range tears the
       structure apart: a two-line selection collapsed to a single empty
       paragraph and both lines were lost. */
    if (blocks) {
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        // Applying a format can make the editor rebuild its DOM, which
        // invalidates the references we are holding. Skipping a stale one
        // loses a marker; writing through it would corrupt the document.
        if (!b.isConnected || !selectContentsOf(b)) continue;
        const text = lines[i];
        if (already) {
          execInsert(text.replace(re, ''));
        } else {
          execInsert(markFor(text, i));   // may become a node and disappear
          if (text) execInsert(text);
        }
      }
      return;
    }

    // No block structure to work with — fall back to writing plain text.
    if (already) {
      writeText(inp, lines.map((l) => l.replace(re, '')).join('\n'), fmt.mode);
      return;
    }
    if (lead) pasteBreak(inp);
    for (let i = 0; i < lines.length; i++) {
      if (i) pasteBreak(inp);
      execInsert(markFor(lines[i], i));
      if (lines[i]) execInsert(lines[i]);
    }
  }

  /* --- how a format is applied -------------------------------------------
     Two paths, tried in this order:

     1. THE BRIDGE (new in 1.9). main-world.js finds Chatto's TipTap editor
        instance — TipTap stores it on the `.ProseMirror` element itself, a
        page-world property the isolated world cannot see — and runs the real
        command: toggleBold(), toggleBulletList(), and so on. One atomic
        transaction, proper toggling, multi-line selections handled by the
        editor itself. This is what the editor's own UI would do if it had
        formatting buttons.

     2. THE TYPING SIMULATION (everything below `legacyApply`). The 1.3–1.8
        approach: write markers through execCommand / synthetic paste and rely
        on the editor's input rules to convert them. Kept because it needs
        nothing from Chatto's internals — it is the safety net for a Chatto
        build where the editor instance is not where TipTap puts it, or for a
        single format the build did not register (the bridge reports support
        per format, so the fallback is per format too).

     __ceDebug() says which path is live. */

  const mdBridge = { editor: false, supported: {} };
  let mdSeq = 0;
  let mdQueriedAt = 0;
  const mdPending = new Map();   // seq -> { fmt, href, inp, timer }

  function markTarget(inp) {
    qsa('[data-ce-md-target]').forEach((el) => {
      if (el !== inp) el.removeAttribute('data-ce-md-target');
    });
    inp.setAttribute('data-ce-md-target', '1');
  }

  /* Ask the page whether the editor is reachable. Called from scan(), so it
     retries on its own until it succeeds, but never more than every 2.5 s. */
  function mdQueryMaybe() {
    if (mdBridge.editor || !pageReady) return;
    if (Date.now() - mdQueriedAt < 2500) return;
    const inp = findInput();
    if (!inp) return;
    mdQueriedAt = Date.now();
    markTarget(inp);
    send('md-query', {});
  }

  function mdBridgeInfo(p) {
    const had = mdBridge.editor;
    mdBridge.editor = !!p.editor;
    mdBridge.supported = p.supported || {};
    if (mdBridge.editor && !had) {
      log('markdown: direct editor access active (' +
          Object.keys(mdBridge.supported).filter((k) => mdBridge.supported[k]).join(', ') + ')');
    }
  }

  function mdBridgeResult(p) {
    const rec = mdPending.get(p.seq);
    if (!rec) return;
    mdPending.delete(p.seq);
    clearTimeout(rec.timer);

    if (p.ok) {
      if (p.active) paintActive(p.active);
      return;
    }
    /* The command could not run. Remember why, so the same format goes
       straight to the fallback next time, and run the fallback now — the
       failed attempt changed nothing, so the selection is still intact. */
    if (p.editor === false) mdBridge.editor = false;
    if (p.unsupported) mdBridge.supported[rec.fmt.id] = false;
    if (p.editor === false || p.unsupported) {
      warn('editor command unavailable for "' + rec.fmt.id + '" — using the typing fallback');
      legacyApply(rec.inp, rec.fmt, rec.href);
    } else if (window.__ceDebugOn) {
      // The editor exists and knows the command but declined it (not
      // applicable at this position). Writing literal markers on top of that
      // would produce escaped junk, so do nothing.
      log('editor declined "' + rec.fmt.id + '" at this position');
    }
  }

  /* --- keeping a drag-selection alive -------------------------------------
     Dragging out of the message box dropped the selection. Chromium collapses
     a selection the moment the pointer crosses into a region styled
     `user-select: none`, which chat apps set on the surrounding shell so the
     UI feels native rather than like a web page.

     While a drag that STARTED in the composer is in progress, force
     selectable text page-wide; release it the moment the button comes up. The
     page is only affected during the drag itself, so nothing about how Chatto
     normally behaves changes. Harmless if this was never the cause. */
  const DRAG_CLASS = 'ce-selecting';

  function endTextDrag() {
    document.documentElement.classList.remove(DRAG_CLASS);
  }

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const inp = findInput();
    if (!inp || !inp.contains(e.target)) return;
    document.documentElement.classList.add(DRAG_CLASS);
  }, true);

  document.addEventListener('pointerup', endTextDrag, true);
  document.addEventListener('pointercancel', endTextDrag, true);
  // Releasing outside the window never fires pointerup on the document.
  window.addEventListener('blur', endTextDrag);

  function askLinkHref() {
    const v = window.prompt('Link URL', 'https://');
    if (v === null) return null;
    const url = normalizeLinkHref(v);
    if (url) return url;
    warn('link was not inserted: only http:, https:, and mailto: URLs are supported');
    try { window.alert('Chatto Enhancer did not insert that link. Use an http:, https:, or mailto: URL.'); } catch (_) {}
    return null;
  }

  function normalizeLinkHref(raw) {
    if (typeof raw !== 'string') return null;
    if (/[\u0000-\u001F\u007F]/.test(raw)) return null;
    const trimmed = raw.trim();
    if (!trimmed || /\s/.test(trimmed) || trimmed.length > 2048) return null;
    let url;
    try { url = new URL(trimmed); } catch (_) { return null; }
    if (!SAFE_LINK_PROTOCOLS.has(url.protocol)) return null;
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) return null;
    if (url.protocol === 'mailto:' && !url.pathname) return null;
    return url.href;
  }

  function applyFormat(fmt) {
    const inp = findInput();
    if (!inp) return;

    /* The link URL is asked for up front, whichever path applies it. (The
       old placeholder-and-edit-it-yourself flow cannot work on the bridge
       path: a real link node keeps its URL in the mark, not in the text.) */
    let href;
    if (fmt.link) {
      href = askLinkHref();
      if (href === null) return;   // cancelled
    }

    if (mdBridge.editor && mdBridge.supported[fmt.id]) {
      markTarget(inp);
      const seq = ++mdSeq;
      const timer = setTimeout(() => {
        // The page never answered — main-world.js is gone. Fall back.
        mdPending.delete(seq);
        mdBridge.editor = false;
        warn('page hook did not answer — using the typing fallback');
        legacyApply(inp, fmt, href);
      }, 400);
      mdPending.set(seq, { fmt, href, inp, timer });
      send('md-format', { seq, id: fmt.id, href });
      return;
    }

    legacyApply(inp, fmt, href);
  }

  function legacyApply(inp, fmt, href) {
    /* Read the selection BEFORE focusing. Calling focus() on an element that
       is not already focused collapses the selection in some engines, which
       silently turned "wrap the selected word" into "insert an empty pair at
       the caret". */
    let sel = window.getSelection();
    const hasSelection = sel && sel.rangeCount && inp.contains(sel.anchorNode);

    if (!hasSelection) {
      sel = restoreCaret(inp);
      if (!sel || !sel.rangeCount || !inp.contains(sel.anchorNode)) return;
    } else if (document.activeElement !== inp && !inp.contains(document.activeElement)) {
      const keep = sel.getRangeAt(0).cloneRange();
      inp.focus();
      sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(keep);
    }

    // Block formats act on whole lines, so widen before measuring anything.
    let blocks = null;
    if (fmt.block) blocks = expandToLines(inp, sel);

    const selected = blocks ? blocks.map((b) => b.textContent).join('\n')
                            : sel.toString();
    const startOff = offsetAt(inp, sel.getRangeAt(0).startContainer,
                                   sel.getRangeAt(0).startOffset);

    /* After widening we are at a block start, so no leading break is needed.
       It is only wanted when the widening could not be done at all. */
    const lead = (fmt.block && !blocks && !atLineStart(inp, sel.getRangeAt(0))) ? '\n' : '';

    runFormat(inp, sel, fmt, selected, lead, blocks, href);

    /* Re-select what we just wrote so the toolbar stays up and formats can be
       chained — bold, then italic, without re-selecting by hand. */
    selectByOffset(inp, startOff, caretOffset(inp));
    rememberCaret(inp);
  }

  function runFormat(inp, sel, fmt, selected, lead, blocks, href) {
    if (fmt.line) {
      applyLineFormat(inp, fmt, blocks, selected, lead);
      return;
    }

    if (fmt.fence) {
      /* Same principle as the line formats: open the fence as its own write
         so a code-block input rule can match it, then add the content. */
      if (lead) pasteBreak(inp);
      execInsert('```');
      /* Did the editor swallow the fence and build a code block? Comparing
         total length before and after does not answer that: the same write
         also deletes the selection, so the document can shrink even when no
         rule fired. Look at what is actually sitting before the caret. */
      const consumed = textJustBefore(inp, 3) !== '```';
      // If it was swallowed the caret is already inside the block; breaking
      // here would push the content back out into a following paragraph.
      if (!consumed) pasteBreak(inp);
      if (selected) {
        const parts = selected.split('\n');
        for (let i = 0; i < parts.length; i++) {
          if (i) pasteBreak(inp);
          if (parts[i]) execInsert(parts[i]);
        }
      }
      if (!consumed) {
        pasteBreak(inp);
        execInsert('```');
        if (!selected) moveCaretBack(4);
      }
      if (window.__ceDebugOn) {
        log('code block: opener was', consumed ? 'converted to a node' : 'left literal',
            '| composer text length:', inp.textContent ? inp.textContent.length : 0);
      }
      return;
    }

    if (fmt.link) {
      const url = href || 'https://';
      writeText(inp, '[' + (selected || 'text') + '](' + url + ')', fmt.mode);
      if (url === 'https://') moveCaretBack(1);   // caret before the closing paren
      return;
    }

    const p = fmt.prefix, sfx = fmt.suffix;

    // Markers inside the selection -> strip them.
    if (selected.length >= p.length + sfx.length &&
        selected.startsWith(p) && selected.endsWith(sfx)) {
      writeText(inp, selected.slice(p.length, selected.length - sfx.length), fmt.mode);
      return;
    }

    // Markers just outside the selection -> widen, then strip.
    if (selected && unwrapOutside(sel, sel.getRangeAt(0), p, sfx)) {
      writeText(inp, selected, fmt.mode);
      return;
    }

    if (!selected) {
      writeText(inp, p + sfx, fmt.mode);
      moveCaretBack(sfx.length);
      return;
    }

    writeText(inp, p + selected + sfx, fmt.mode);
  }

  /* --- the floating bar --------------------------------------------------- */

  /* Debug hook: __ceApply('bold') runs a format without clicking. Lives in
     the extension's isolated world, so page script cannot reach it. */
  window.__ceFormats = () => FORMATS.map((f) => ({ id: f.id, mode: f.mode }));
  window.__ceApply = (id) => {
    const f = FORMATS.find((x) => x.id === id);
    if (!f) return 'no such format: ' + FORMATS.map((x) => x.id).join(', ');
    applyFormat(f);
    return 'applied ' + id;
  };
  /* Docked, always-visible toolbar — one per composer, sitting directly above
     its text box like a native app's formatting bar, rather than a popup that
     appears and disappears with the selection. This sidesteps the class of
     bug a floating/selection-anchored bar has: there is nothing left to hide
     when a drag's mouseup lands outside the composer, because visibility no
     longer depends on the live selection at all. Formatting itself still
     goes through the selection Chatto's editor tracks (unchanged), the same
     way a native toolbar button would. */

  function buildBar() {
    const el = h('div', { class: 'ce-md', role: 'toolbar', 'aria-label': 'Text formatting' });
    for (const f of FORMATS) {
      if (f.sep) el.appendChild(h('span', { class: 'ce-md-sep' }));
      const b = h('button', {
        class: 'ce-md-btn ce-md-' + f.id, type: 'button',
        title: f.hint ? f.title + '   ' + f.hint : f.title,
        'aria-label': f.title,
      });
      if (f.text) b.textContent = f.text;
      else b.appendChild(iconEl(f.icon));
      // Keep the selection alive while the button is pressed.
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        applyFormat(f);
      });
      el.appendChild(b);
    }
    return el;
  }

  /** Creates or drops one docked bar per composer, and keeps each one
      anchored directly above its composer's own box — mirrors how
      addEmojiButton() manages one button per composer. */
  function ensureMdBar() {
    const inputs = findInputs();
    const live = new Set(inputs.map(cidOf));

    // Drop bars whose composer is gone (thread closed, view swapped).
    qsa('.ce-md').forEach((bar) => {
      if (!bar.isConnected || !live.has(bar.dataset.ceFor)) bar.remove();
    });

    for (const inp of inputs) {
      const cid = cidOf(inp);
      const existing = qsa('.ce-md').find((b) => b.dataset.ceFor === cid);
      if (existing && existing.isConnected) continue;

      const bar = buildBar();
      bar.dataset.ceFor = cid;

      const composer = findComposer(inp);
      if (composer && composer.parentElement) {
        composer.parentElement.insertBefore(bar, composer);
      } else if (composer) {
        composer.insertBefore(bar, composer.firstChild);
        warn('markdown toolbar has no composer parent to dock above; ' +
             'placed inside the composer instead. Run __ceDebug() if it looks wrong.');
      } else {
        continue; // no anchor at all — try again next scan
      }
    }
  }

  function removeMdBars() {
    qsa('.ce-md').forEach((bar) => bar.remove());
  }

  /** Toggle the pressed look on toolbar buttons from a bridge state report.
      Targets the bar for whichever composer was just marked/queried
      (markTarget()), since the bridge only tracks one target at a time. */
  function paintActive(active) {
    if (!active) return;
    const target = qs('[data-ce-md-target="1"]');
    const bar = target && qsa('.ce-md').find((b) => b.dataset.ceFor === cidOf(target));
    if (!bar) return;
    for (const f of FORMATS) {
      const b = bar.querySelector('.ce-md-' + f.id);
      if (b) {
        b.classList.toggle('ce-on', !!active[f.id]);
        b.setAttribute('aria-pressed', active[f.id] ? 'true' : 'false');
      }
    }
  }

  /* Coalesce active-state queries to one per frame, same reasoning as the
     rest of the file's scan scheduling: rAF alone freezes in a background
     tab, so the timeout is the fallback that keeps this from ever getting
     stuck. Only asks the page for state; never affects bar visibility. */
  let mdStateFrame = 0;
  function scheduleActiveState() {
    if (!settings.markdown || mdStateFrame) return;
    const run = () => {
      clearTimeout(mdStateFrame);
      mdStateFrame = 0;
      if (!mdBridge.editor) return;
      const inp = findInput();
      if (!inp) return;
      markTarget(inp);
      send('md-state', {});
    };
    mdStateFrame = setTimeout(run, 120);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  }

  document.addEventListener('selectionchange', scheduleActiveState);

  /* Capture phase so these beat both Chatto's own handlers and the browser's
     defaults — Ctrl+B opens the bookmarks sidebar in Firefox and Ctrl+K jumps
     to the search bar. Only fires while the composer has focus. */
  document.addEventListener('keydown', (e) => {
    if (!settings.markdown) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const inp = findInput();
    if (!inp || !inp.contains(document.activeElement)) return;

    const key = (e.key || '').toLowerCase();
    const fmt = FORMATS.find((f) => f.key === key && !!f.shift === e.shiftKey);
    if (!fmt) return;

    e.preventDefault();
    e.stopPropagation();
    applyFormat(fmt);
  }, true);

  /* Ctrl+Shift+E toggles the emoji picker for the focused composer without
     touching the mouse. Shift distinguishes it from the markdown
     handler's own Ctrl+E (inline code) above — no FORMATS entry uses
     shift with the 'e' key, so the two can never collide. */
  document.addEventListener('keydown', (e) => {
    if (!settings.emoji) return;
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
    if ((e.key || '').toLowerCase() !== 'e') return;
    const inp = findInput();
    if (!inp || !inp.contains(document.activeElement)) return;
    const btn = qsa('.ce-emoji-btn').find((b) => b.dataset.ceFor === cidOf(inp));
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();
    togglePicker(btn);
  }, true);

  /* =========================================================================
     WIRING
     ========================================================================= */

  /* ======================== theme sampling ==============================
     Rather than hardcode Chatto's palette — which would drift the moment they
     restyle, and would be wrong outright for anyone on a different theme —
     read the real colours off the page and publish them as the CSS variables
     every .ce- rule already uses.

     Sampling the composer specifically, not <body>: it is the surface these
     controls actually sit against, and it is the one element we already know
     how to find reliably. */

  function parseRGB(str) {
    const m = /rgba?\(([^)]+)\)/.exec(str || '');
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).map(parseFloat).filter((n) => !isNaN(n));
    if (p.length < 3) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  /** Walk up until we find something actually painted. */
  function opaqueBackgroundOf(el) {
    let n = el;
    for (let i = 0; n && i < 25; i++, n = n.parentElement) {
      const c = parseRGB(getComputedStyle(n).backgroundColor);
      if (c && c.a >= 0.9) return c;
    }
    return null;
  }

  const luminance = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  const rgb = (c) => 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ')';
  const rgba = (c, a) => 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' +
                          Math.round(c.b) + ',' + a + ')';
  const shade = (c, d) => ({
    r: Math.max(0, Math.min(255, c.r + d)),
    g: Math.max(0, Math.min(255, c.g + d)),
    b: Math.max(0, Math.min(255, c.b + d)),
  });

  let themeKey = '';
  function syncTheme() {
    const inp = findInput();
    const anchor = inp || document.body;
    if (!anchor) return;

    const bg = opaqueBackgroundOf(anchor);
    const fg = parseRGB(getComputedStyle(anchor).color);
    if (!bg || !fg) return;

    const key = rgb(bg) + '|' + rgb(fg);
    if (key === themeKey) return;    // nothing changed; don't touch the DOM
    themeKey = key;

    // Panels step away from the page background, in whichever direction has
    // room. On a dark theme that means lighter; on a light theme, darker.
    const dir = luminance(bg) < 0.5 ? 1 : -1;
    const root = document.documentElement.style;
    root.setProperty('--ce-panel', rgb(shade(bg, 8 * dir)));
    root.setProperty('--ce-panel-2', rgb(shade(bg, 18 * dir)));
    root.setProperty('--ce-panel-3', rgb(shade(bg, 30 * dir)));
    root.setProperty('--ce-text', rgb(fg));
    root.setProperty('--ce-dim', rgba(fg, 0.55));
    root.setProperty('--ce-line', rgba(fg, 0.14));

    /* Accent: take it from a link, which is the one element guaranteed to be
       painted in the app's accent colour. Ignore it if it matches the body
       text — that means links are not distinctly coloured here and we would
       be sampling nothing. */
    const link = document.querySelector('a[href]');
    const ac = link && parseRGB(getComputedStyle(link).color);
    if (ac && (Math.abs(ac.r - fg.r) + Math.abs(ac.g - fg.g) + Math.abs(ac.b - fg.b)) > 60) {
      root.setProperty('--ce-accent', rgb(ac));
      root.setProperty('--ce-accent-dim', rgba(ac, 0.35));
    }

    if (window.__ceDebugOn) log('theme sampled:', { bg: rgb(bg), text: rgb(fg) });
  }

  function scan() {
    dropCache();
    if (inCall()) {
      if (settings.volume) {
        findCards().forEach(addSlider);
        ensureVolumeResetButton();
      }
      if (settings.nicknames) findCards().forEach(applyNickname);
      if (settings.pip) ensurePipButtons();
    } else if (settings.volume) {
      // Left the call (or only observing) — take the sliders back off.
      document.querySelectorAll('.ce-vol').forEach((v) => v.remove());
      document.querySelectorAll('.ce-card').forEach((c) => c.classList.remove('ce-card'));
      document.querySelectorAll('.ce-pip-btn').forEach((b) => b.remove());
      document.querySelectorAll('.ce-vol-reset-btn').forEach((b) => b.remove());
      mapping = Object.create(null);
      audioIds = [];
    }
    if (settings.emoji) addEmojiButton();
    if (settings.gif) addGifButton();
    if (settings.nicknames) {
      addRenameButtons();
      applyNicknamesEverywhere();
    }
    syncTheme();
    if (settings.markdown) {
      mdQueryMaybe();
      ensureMdBar();
    }
  }

  /* One scan per animation frame at most, rather than a 60 ms timer per
     mutation batch plus an unconditional 1.5 s sweep. The slow interval
     stays as a safety net — and as the only thing still running when the tab
     is backgrounded and rAF is throttled to zero. */
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    const run = () => { queued = false; scan(); applyVolumes(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  const mo = new MutationObserver(schedule);
  mo.observe(document.documentElement, { childList: true, subtree: true });

  const scanInterval = setInterval(() => { scan(); applyVolumes(); }, 3000);
  scan();

  function cleanup() {
    try { clearInterval(scanInterval); } catch (_) {}
    try { clearTimeout(saveTimer); } catch (_) {}
    try { clearTimeout(mdStateFrame); } catch (_) {}
    try { mo.disconnect(); } catch (_) {}
    try { closePicker(); } catch (_) {}
    try { closeGifPicker(); } catch (_) {}
    try { removeMdBars(); } catch (_) {}
    try { document.documentElement.classList.remove(DRAG_CLASS); } catch (_) {}
  }

  window.__ceIsoCleanup = cleanup;
  window.addEventListener('pagehide', cleanup, { once: true });
  window.addEventListener('beforeunload', cleanup, { once: true });

  /* ---------------------------------------------------------- diagnostics -- */

  /* Does the browser actually have an emoji font we can reach? Brave's
     fingerprinting protection restricts font access, and a restricted
     fallback chain renders emoji as empty boxes. Compare the width of a known
     emoji against a private-use codepoint, which is guaranteed to be the
     notdef/tofu glyph — equal widths mean no emoji font resolved. */
  function emojiFontAvailable() {
    try {
      const ctx = document.createElement('canvas').getContext('2d');
      if (!ctx) return null;
      ctx.font = '32px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla",emoji,sans-serif';
      const emo = ctx.measureText('\u{1F600}').width;
      const tofu = ctx.measureText('\u{E000}').width;
      if (!emo) return false;
      return Math.abs(emo - tofu) > 0.5;
    } catch (_) { return null; }
  }

  // Diagnostic helper. In DevTools, switch the console context dropdown from
  // "top" to "Chatto Enhancer", then run __ceDebug().
  /* Test hook: which composer would be acted on right now. */
  window.__ceActiveInput = findInput;
  /* Test hook: local-participant detection, exercised by
     test/local-card-detection.test.mjs against a minimal DOM shim. */
  window.__ceLocalCardTestHooks = {
    isLocalCard, nameOf, localUserName, remoteCards, findCards,
    addSlider, removeSlider, dropCache, inCall, stripTrailingDecoration,
  };
  window.__ceDebug = function () {
    window.__ceDebugOn = !window.__ceDebugOn;
    dropCache();
    log('debug logging', window.__ceDebugOn ? 'on' : 'off');
    log('browser:', IS_GECKO ? 'Gecko/Firefox' : 'Chromium-family',
        '· API:', PROMISE_API ? 'browser.* (promises)' : 'chrome.* (callbacks)');
    log('storage loaded:', ready);
    log('--- element lookup ---');
    log('winning strategy per target:', JSON.parse(JSON.stringify(strategyUsed)));
    const inputs = findInputs();
    log('composers found:', inputs.length, inputs);
    log('active composer:', findInput());
    inputs.forEach((el, i) => log('  composer ' + i + ' send button:', findSendButton(el)));
    log('composer shell:', findComposer());
    log('emoji button:', document.querySelector('.ce-emoji-btn'),
        '· anchored via:', (document.querySelector('.ce-emoji-btn') || {}).dataset);
    log('--- emoji ---');
    log('emoji groups loaded:', GROUPS.length,
        '· total emoji:', GROUPS.reduce((a, g) => a + g.e.length, 0));
    const font = emojiFontAvailable();
    log('emoji font reachable:', font === null ? 'could not test' : font,
        font === false ? '<-- THIS IS WHY EMOJI ARE BLANK. Install Noto Color Emoji, ' +
        'or lower Brave Shields font fingerprinting protection on this site.' : '');
    log('markdown formats:', FORMATS.map((f) => f.id).join(', '));
    log('markdown path:', mdBridge.editor
        ? 'DIRECT EDITOR ACCESS \u00b7 supported: ' +
          Object.keys(mdBridge.supported).filter((k) => mdBridge.supported[k]).join(', ')
        : 'typing fallback (editor instance not found' +
          (pageReady ? '' : '; page hook not ready') + ')');
    log('sampled theme:', themeKey || '(not sampled yet)');
    log('--- call ---');
    log('participant cards:', findCards().map(nameOf));
    log('in call:', inCall(), '· you are:', localUserName());
    log('page hook ready:', pageReady,
        pageReady ? '' : '<-- main-world.js is not running; volume will not work',
        '· fallback injected:', fallbackInjected);
    log('stream ids:', audioIds,
        '· ordering', orderConfirmed ? 'confirmed by a full sweep' : 'provisional');
    log('name -> element:', mapping);
    log('learned from voice:', voiceScore);
    send('query', {});
    return 'see output above (page element details arrive a moment later)';
  };

  // Emergency revert: put everyone back to full volume.
  window.__ceReset = function () {
    for (const id of audioIds) send('set', { id, factor: 1 });
    volumes = Object.create(null);
    saveSoon();
    dropCache();
    findCards().forEach(paintCard);
    return 'all participants back to 100%';
  };

  if (!GROUPS.length) {
    warn('emoji data did not load — the picker will open empty. Check emoji-data.js.');
  }
  log('loaded \u00b7', GROUPS.reduce((a, g) => a + g.e.length, 0), 'emoji ready \u00b7',
      IS_GECKO ? 'Firefox' : 'Chromium');
})();
