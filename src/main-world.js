/* ==========================================================================
   Chatto Enhancer — page-context hook
   ==========================================================================
   Runs in the PAGE's JavaScript world, not the extension's isolated world.
   It has to, because of how Chatto plays voice audio.

   In apps/frontend/src/lib/state/server/voiceCall.svelte.ts, on TrackSubscribed
   Chatto calls:

       track.attach();

   with no argument. LiveKit creates an <audio> element internally and never
   inserts it into the document — playback doesn't require that. So the element
   is unreachable from document.querySelectorAll('audio'); it only exists as a
   JS object held by LiveKit.

   v1.3 change — we now patch the `volume` accessor on HTMLMediaElement.prototype
   rather than monkey-patching document.createElement. That is strictly more
   reliable: it catches elements made by new Audio(), by cloneNode, by
   createElementNS, and elements that already existed before we loaded. The
   createElement hook is kept only as an early-discovery signal so the ordering
   is known before the first volume write.

   real volume = (whatever LiveKit asked for) x (our per-person factor)

   That survives Chatto re-asserting its own volume.
   applyRemoteParticipantAudioVolume() sets 0 or 1 depending on its local-mute
   state, and is called again on every track event. Because we intercept the
   write rather than fight it afterwards, its 1 becomes our 0.4 and its 0 stays
   0 — Chatto's own mute still wins, which is the correct precedence.
   ========================================================================== */
(() => {
  'use strict';

  const CHANNEL_OUT = 'ce-main';   // page      -> extension
  const CHANNEL_IN = 'ce-iso';     // extension -> page
  const ALLOWED_IN_TYPES = new Set(['init', 'md-query', 'md-state', 'md-format', 'set', 'query']);
  const ALLOWED_MD_IDS = new Set([
    'bold', 'italic', 'strike', 'code', 'heading', 'bullet',
    'ordered', 'quote', 'block', 'link',
  ]);
  const MAX_BRIDGE_JSON = 10000;
  const SAFE_LINK_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);
  let bridgeToken = '';

  /* Loaded twice? The manifest declares this as a MAIN-world content script,
     and content.js also injects it as a <script> if that never took effect
     (older Firefox, or a browser that ignores `world`). Whichever arrives
     second must not re-patch, but it must still answer the handshake or the
     extension will keep waiting for a hook that is already installed. */
  if (window.__ceMainWorld) {
    return;
  }
  window.__ceMainWorld = true;

  const nativeVolume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  if (!nativeVolume || !nativeVolume.set || !nativeVolume.get) return;   // nothing to hook

  const records = [];              // { id, el, base, factor }
  const byId = new Map();
  const byEl = new WeakMap();
  let seq = 0;

  const clamp = (v) => Math.max(0, Math.min(1, v));

  /* Everything crossing the world boundary goes as a JSON string. Firefox puts
     an Xray wrapper on objects passed between a content script and the page,
     and reading nested arrays/objects through it behaves differently than in
     Chromium. A string has no such problem in any engine. */
  const post = (type, payload) => {
    if (!bridgeToken) return;
    try {
      window.postMessage({
        source: CHANNEL_OUT,
        token: bridgeToken,
        type,
        json: JSON.stringify(payload),
      }, window.location.origin);
    } catch (_) {}
  };

  function isAudioId(value) {
    return typeof value === 'string' && /^a\d+$/.test(value) && value.length <= 32;
  }

  function normalizeHref(raw) {
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

  function exactKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const allowed = new Set(keys);
    return Object.keys(value).every((key) => allowed.has(key));
  }

  function cleanInbound(type, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
    if (type === 'init' || type === 'md-query' || type === 'md-state' || type === 'query') {
      return exactKeys(payload, []) ? {} : null;
    }
    if (type === 'set') {
      if (!exactKeys(payload, ['id', 'factor'])) return null;
      const factor = Number(payload.factor);
      return isAudioId(payload.id) && Number.isFinite(factor)
        ? { id: payload.id, factor: clamp(factor) }
        : null;
    }
    if (type === 'md-format') {
      if (!exactKeys(payload, ['seq', 'id', 'href'])) return null;
      const seq = Number(payload.seq);
      if (!Number.isInteger(seq) || seq < 1 || !ALLOWED_MD_IDS.has(payload.id)) return null;
      const out = { seq, id: payload.id };
      if (payload.id === 'link') {
        const href = normalizeHref(payload.href);
        if (!href) return null;
        out.href = href;
      }
      return out;
    }
    return null;
  }

  function readInbound(e) {
    if (e.source !== window || e.origin !== window.location.origin) return null;
    const d = e.data;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    if (d.source !== CHANNEL_IN || !ALLOWED_IN_TYPES.has(d.type)) return null;
    if (d.type === 'init') {
      if (typeof d.token !== 'string' || d.token.length < 16 || d.token.length > 128) return null;
      bridgeToken = d.token;
    } else if (d.token !== bridgeToken || !bridgeToken) {
      return null;
    }
    if (typeof d.json !== 'string' || d.json.length > MAX_BRIDGE_JSON) return null;
    let payload = {};
    try { payload = d.json ? JSON.parse(d.json) : {}; } catch (_) { return null; }
    payload = cleanInbound(d.type, payload);
    return payload ? { type: d.type, payload } : null;
  }

  /* --- which elements are still carrying someone -------------------------
     Elements stay in `records` after a participant leaves, so anything that
     counts them has to ignore the dead ones. */
  function isLive(rec) {
    try {
      const s = rec.el.srcObject;
      if (!s || typeof s.getAudioTracks !== 'function') return false;
      return s.getAudioTracks().some((t) => t.readyState !== 'ended');
    } catch (_) { return false; }
  }
  const liveRecords = () => records.filter(isLive);

  let announceTimer = null;
  function announce() {
    // srcObject is set just after creation, so wait a beat before reporting.
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      post('elements', { ids: liveRecords().map((r) => r.id) });
    }, 200);
  }

  /* --- burst detection ---------------------------------------------------
     A run of volume writes landing within a few milliseconds is Chatto
     looping over participants. But there are TWO such loops in
     voiceCall.svelte.ts:

       applyAllParticipantAudioVolumes()  — every participant
       applyParticipantAudioVolume(id)    — one participant (local mute)

     Only the first tells us the ordering. The second produces a burst of
     length one, and taking that as the ordering collapses the mapping to a
     single person. So we mark a burst "complete" only when it touched every
     live element, and the extension ignores the rest. */
  let burst = [];
  let burstTimer = null;

  function noteWrite(rec) {
    if (!burst.includes(rec.id)) burst.push(rec.id);
    clearTimeout(burstTimer);
    burstTimer = setTimeout(() => {
      const live = liveRecords().length;
      if (burst.length) {
        post('order', { ids: burst.slice(), complete: live > 0 && burst.length >= live });
      }
      burst = [];
    }, 90);
  }

  function apply(rec) {
    try { nativeVolume.set.call(rec.el, clamp(rec.base * rec.factor)); } catch (_) {}
  }

  /* Registers an element the first time we see it. `base` starts at whatever
     the element's real volume already is, so an element we meet late is not
     jolted to a different level. */
  function recFor(el) {
    let rec = byEl.get(el);
    if (rec) return rec;
    let base = 1;
    try { base = clamp(Number(nativeVolume.get.call(el))); } catch (_) {}
    rec = { id: 'a' + (seq++), el, base: Number.isFinite(base) ? base : 1, factor: 1 };
    byEl.set(el, rec);
    byId.set(rec.id, rec);
    records.push(rec);
    post('audio', { id: rec.id, count: records.length });
    announce();
    return rec;
  }

  /* The single hook that matters. Every media element in the page now reads
     and writes its volume through here, however it was constructed. */
  Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
    configurable: true,
    enumerable: true,
    // Report back what the caller set, so LiveKit's own bookkeeping stays
    // consistent and it never reads a value it did not write.
    get() {
      try { return recFor(this).base; } catch (_) { return nativeVolume.get.call(this); }
    },
    set(v) {
      try {
        const rec = recFor(this);
        const n = Number(v);
        rec.base = Number.isFinite(n) ? clamp(n) : 1;
        noteWrite(rec);
        apply(rec);
      } catch (_) {
        try { nativeVolume.set.call(this, v); } catch (__) {}
      }
    },
  });

  /* Early discovery only — registers a new <audio> before anyone writes to it,
     so the ordering is known from the first frame rather than the first volume
     write. Not load-bearing: the prototype hook above catches it either way. */
  const origCreateElement = Document.prototype.createElement;
  Document.prototype.createElement = function (tagName, ...rest) {
    const el = origCreateElement.call(this, tagName, ...rest);
    try {
      if (typeof tagName === 'string' && tagName.toLowerCase() === 'audio') recFor(el);
    } catch (_) {}
    return el;
  };

  // Anything already created before we loaded.
  try { document.querySelectorAll('audio, video').forEach(recFor); } catch (_) {}

  /* --- measuring who is actually making noise ----------------------------
     Matching a stream to a person by position is fragile: someone who joined
     without a working microphone has a participant card but no audio stream,
     and every position after them is then off by one. That produces exactly
     the "works sometimes" behaviour.

     So we also measure each stream's loudness. The extension compares that
     against which card Chatto is showing as speaking, and once the two agree
     a few times in a row it knows for certain who is who.

     The analyser is a measuring tap only — it is never connected to the
     output, so it cannot affect what you hear. */
  let ac = null;
  const taps = new Map();   // id -> { src, an, data }

  function audioCtx() {
    if (ac) return ac;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ac = new AC(); } catch (_) { return null; }
    return ac;
  }

  function tap(rec) {
    if (taps.has(rec.id)) return taps.get(rec.id);
    const ctx = audioCtx();
    if (!ctx || !rec.el.srcObject) return null;
    try {
      const src = ctx.createMediaStreamSource(rec.el.srcObject);
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      src.connect(an);            // deliberately NOT connected to destination
      const t = { src, an, data: new Uint8Array(an.frequencyBinCount) };
      taps.set(rec.id, t);
      return t;
    } catch (_) { return null; }
  }

  // An AudioContext may start suspended until the user interacts.
  const wake = () => { const c = audioCtx(); if (c && c.state === 'suspended') c.resume().catch(() => {}); };
  window.addEventListener('click', wake, true);
  window.addEventListener('keydown', wake, true);

  const levelInterval = setInterval(() => {
    const live = liveRecords();
    if (!live.length) return;
    const levels = {};
    for (const rec of live) {
      const t = tap(rec);
      if (!t) continue;
      t.an.getByteFrequencyData(t.data);
      let sum = 0;
      for (let i = 0; i < t.data.length; i++) sum += t.data[i];
      levels[rec.id] = sum / t.data.length / 255;
    }
    if (Object.keys(levels).length) post('levels', { levels });
  }, 220);

  function cleanup() {
    try { clearInterval(levelInterval); } catch (_) {}
    try { clearTimeout(announceTimer); } catch (_) {}
    try { clearTimeout(burstTimer); } catch (_) {}
    try { window.removeEventListener('click', wake, true); } catch (_) {}
    try { window.removeEventListener('keydown', wake, true); } catch (_) {}
  }

  window.addEventListener('pagehide', cleanup, { once: true });
  window.addEventListener('beforeunload', cleanup, { once: true });

  /* --- composer bridge (markdown) ----------------------------------------
     Chatto's message box is TipTap, and TipTap stores its Editor instance on
     the editor's own DOM element: `document.querySelector('.ProseMirror').editor`
     (packages/core/src/Editor.ts, createView). That property is a page-world
     expando, invisible from the extension's isolated world — which is exactly
     why formatting used to be done by simulating keystrokes and hoping the
     editor's input rules fired.

     From here we can call the editor's real command API instead. One
     transaction, atomic, proper toggling, no caret games. The isolated side
     marks the composer it means with a `data-ce-md-target` attribute
     (attributes cross worlds; JS expandos do not) and asks by message.

     Everything is feature-detected: a command that this Chatto build did not
     register simply reports `unsupported`, and the extension falls back to
     its old typing path for that one format. */

  function tiptapOf(el) {
    const ed = el && el.editor;
    return (ed && ed.commands && ed.state && ed.view && typeof ed.chain === 'function') ? ed : null;
  }

  function findEditor() {
    const seen = [];
    const target = document.querySelector('[data-ce-md-target]');
    if (target) {
      seen.push(target);
      if (target.closest) seen.push(target.closest('.ProseMirror'));
      if (target.querySelector) seen.push(target.querySelector('.ProseMirror'));
    }
    document.querySelectorAll('.ProseMirror').forEach((el) => seen.push(el));
    for (const el of seen) {
      const ed = tiptapOf(el);
      if (ed) return ed;
    }
    return null;
  }

  /* Command name per format id, so support can be tested with a property
     check before anything runs. */
  const MD_COMMAND = {
    bold: 'toggleBold', italic: 'toggleItalic', strike: 'toggleStrike',
    code: 'toggleCode', heading: 'toggleHeading', bullet: 'toggleBulletList',
    ordered: 'toggleOrderedList', quote: 'toggleBlockquote',
    block: 'toggleCodeBlock', link: 'setLink',
  };

  function mdSupported(ed) {
    const out = {};
    for (const id of Object.keys(MD_COMMAND)) {
      out[id] = typeof ed.commands[MD_COMMAND[id]] === 'function';
    }
    return out;
  }

  function mdActive(ed) {
    const out = {};
    try {
      out.bold = ed.isActive('bold');
      out.italic = ed.isActive('italic');
      out.strike = ed.isActive('strike');
      out.code = ed.isActive('code');
      out.heading = ed.isActive('heading', { level: 2 });
      out.bullet = ed.isActive('bulletList');
      out.ordered = ed.isActive('orderedList');
      out.quote = ed.isActive('blockquote');
      out.block = ed.isActive('codeBlock');
      out.link = ed.isActive('link');
    } catch (_) {}
    return out;
  }

  /* --- block formats act on one line, not the whole message --------------
     Chatto's composer keeps the entire message in a SINGLE paragraph, with
     Shift+Enter inserting hardBreak nodes rather than starting new blocks.
     Heading / list / quote are block formats, so ProseMirror correctly
     applies them to the whole paragraph — which from the user's side looks
     like selecting one line and having every line reformatted.

     Fix: before applying a block format, split the selected line(s) out into
     their own paragraph, then format just that. Verified against a real
     TipTap editor across first / middle / last line, multi-line selections,
     a collapsed caret, and toggling back off. */

  const BLOCK_FORMATS = { heading: 1, bullet: 1, ordered: 1, quote: 1, block: 1 };

  /** The line (between hardBreaks) containing the selection, or null when
      splitting is unnecessary or unsafe. */
  function lineRangeAround(ed, from, to) {
    const $from = ed.state.doc.resolve(from);
    const parent = $from.parent;
    // A code block's line breaks are content, not structure — never split it.
    if (!parent.isTextblock || parent.type.name === 'codeBlock') return null;

    const start = $from.start();
    const end = $from.end();

    const breaks = [];
    parent.forEach((node, offset) => {
      if (node.type.name === 'hardBreak') breaks.push(start + offset);
    });
    if (!breaks.length) return null;             // single line — nothing to do

    let lineStart = start;
    let lineEnd = end;
    for (const b of breaks) if (b < from) lineStart = b + 1;
    for (const b of breaks) if (b >= to) { lineEnd = b; break; }

    // Selection already covers every line: the whole block IS the target.
    if (lineStart === start && lineEnd === end) return null;
    return { start, end, lineStart, lineEnd };
  }

  /** Splits the selected line into its own block. Returns the selection to
      use afterwards, or null if no split was needed. */
  function splitSelectedLine(ed, from, to) {
    const r = lineRangeAround(ed, from, to);
    if (!r) return null;

    let tr = ed.state.tr;

    /* Trailing boundary first: it sits at a higher position, so handling it
       before the leading one leaves the leading positions untouched. */
    if (r.lineEnd < r.end) {
      tr = tr.delete(r.lineEnd, r.lineEnd + 1);
      tr = tr.split(r.lineEnd);
    }

    /* Positions are computed rather than mapped through the transaction.
       tr.mapping.map() needs an association bias at a point that was both
       deleted and split, and the correct bias differs between a collapsed
       caret and a range — getting it wrong silently formats the neighbouring
       line instead. The arithmetic has no such ambiguity: removing the break
       costs one position, the new block boundary adds two, so everything
       after the split shifts by exactly +1. */
    let delta = 0;
    if (r.lineStart > r.start) {
      const b = r.lineStart - 1;
      tr = tr.delete(b, b + 1);
      tr = tr.split(b);
      delta = 1;
    }

    ed.view.dispatch(tr);
    const limit = ed.state.doc.content.size;
    const clamp = (n) => Math.max(0, Math.min(n, limit));
    return { from: clamp(from + delta), to: clamp(to + delta) };
  }

  function mdRun(ed, id, payload) {
    /* Splitting only makes sense when turning a format ON. Toggling off acts
       on a block that is already its own, so there is nothing to separate. */
    if (BLOCK_FORMATS[id]) {
      let active = false;
      try {
        active = id === 'heading' ? ed.isActive('heading', { level: 2 })
               : id === 'bullet'  ? ed.isActive('bulletList')
               : id === 'ordered' ? ed.isActive('orderedList')
               : id === 'quote'   ? ed.isActive('blockquote')
               : ed.isActive('codeBlock');
      } catch (_) {}
      if (!active) {
        const s = ed.state.selection;
        let next = null;
        try { next = splitSelectedLine(ed, s.from, s.to); } catch (_) { next = null; }
        if (next) {
          try { ed.commands.setTextSelection(next); } catch (_) {}
        }
      }
    }

    const c = ed.chain().focus();
    switch (id) {
      case 'bold':    return c.toggleBold().run();
      case 'italic':  return c.toggleItalic().run();
      case 'strike':  return c.toggleStrike().run();
      case 'code':    return c.toggleCode().run();
      case 'heading': return c.toggleHeading({ level: 2 }).run();
      case 'bullet':  return c.toggleBulletList().run();
      case 'ordered': return c.toggleOrderedList().run();
      case 'quote':   return c.toggleBlockquote().run();
      case 'block':   return c.toggleCodeBlock().run();
      case 'link':
        // Toggling an existing link removes it; otherwise apply the given
        // href across the whole mark range, the way every editor's link
        // button behaves.
        if (ed.isActive('link') && !payload.href) {
          return c.extendMarkRange('link').unsetLink().run();
        }
        return c.extendMarkRange('link')
                .setLink({ href: String(payload.href || 'https://') }).run();
    }
    return false;
  }

  window.addEventListener('message', (e) => {
    const msg = readInbound(e);
    if (!msg) return;
    const d = { type: msg.type };
    const payload = msg.payload;

    if (d.type === 'init') {
      post('ready', {});
      announce();
    } else if (d.type === 'md-query') {
      const ed = findEditor();
      post('md-info', ed ? { editor: true, supported: mdSupported(ed) }
                         : { editor: false, supported: {} });
    } else if (d.type === 'md-state') {
      const ed = findEditor();
      post('md-active', ed ? { editor: true, active: mdActive(ed) } : { editor: false });
    } else if (d.type === 'md-format') {
      const ed = findEditor();
      if (!ed) { post('md-result', { seq: payload.seq, id: payload.id, ok: false, editor: false }); return; }
      if (typeof ed.commands[MD_COMMAND[payload.id]] !== 'function') {
        post('md-result', { seq: payload.seq, id: payload.id, ok: false, editor: true, unsupported: true });
        return;
      }
      let ok = false;
      try { ok = !!mdRun(ed, payload.id, payload); } catch (_) { ok = false; }
      post('md-result', { seq: payload.seq, id: payload.id, ok, editor: true, active: mdActive(ed) });
    } else if (d.type === 'set') {
      const rec = byId.get(payload.id);
      if (!rec) return;
      const f = Number(payload.factor);
      rec.factor = clamp(Number.isFinite(f) ? f : 1);
      apply(rec);
    } else if (d.type === 'query') {
      post('state', {
        live: liveRecords().map((r) => r.id),
        elements: records.map((r) => ({
          live: isLive(r),
          id: r.id,
          base: r.base,
          factor: r.factor,
          effective: clamp(r.base * r.factor),
          hasStream: !!r.el.srcObject,
          inDocument: r.el.isConnected,
          tracks: (() => {
            try { return r.el.srcObject ? r.el.srcObject.getAudioTracks().length : 0; }
            catch (_) { return 0; }
          })(),
          paused: r.el.paused,
        })),
      });
    }
  });
})();
