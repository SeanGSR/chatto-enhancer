/* ==========================================================================
   Chatto Enhancer — background service worker

   Exists for one reason: talking to Giphy's GIF API. A content script's
   fetch() runs inside the page's own JS realm and is subject to the page's
   CSP — Chatto's CSP is not something this extension controls or wants to
   fight. The background script's requests are made from the extension's own
   privileged context instead, gated only by the host_permissions this
   extension declares for *.giphy.com, and are unaffected by whatever CSP
   Chatto ships (or changes to later).

   GIPHY_API_KEY below is a placeholder, not a secret checked into this repo.
   Giphy issues one API key per *app* (unlike some providers, it is not
   meant to be issued per end user), so it is injected at build time from the
   GIPHY_API_KEY environment variable — see scripts/build.mjs — rather than
   collected from each installer. The real key exists only in the built
   dist/ and artifacts/ output, both gitignored; the source published on
   GitHub never contains it. Anyone who installs the finished extension can
   still extract the key from their own local copy by inspecting it — that
   is an inherent property of any client-side app key and is how Giphy
   expects its API to be embedded in client apps, not a gap specific to this
   extension. */

const GIPHY_API_KEY = '__GIPHY_API_KEY__';

const GIPHY_BASE = 'https://api.giphy.com/v1/gifs';
const MAX_QUERY_LEN = 200;
const PAGE_LIMIT = 24;

function hasKey() {
  return typeof GIPHY_API_KEY === 'string' && GIPHY_API_KEY.length > 0 &&
    GIPHY_API_KEY !== '__GIPHY_API_KEY__';
}

function isSafeGiphyUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url;
  try { url = new URL(value); } catch (_) { return false; }
  return url.protocol === 'https:' && /(^|\.)giphy\.com$/.test(url.hostname);
}

function toResult(item) {
  try {
    const images = item.images || {};
    const full = images.original;
    const preview = images.fixed_width_small || images.fixed_width || full;
    if (!full || !full.url) return null;
    return {
      id: String(item.id || ''),
      title: typeof item.title === 'string' ? item.title.slice(0, 200) : '',
      url: full.url,
      previewUrl: (preview && preview.url) || full.url,
      width: Number(full.width) || 0,
      height: Number(full.height) || 0,
    };
  } catch (_) { return null; }
}

async function giphySearch(query, offset) {
  if (!hasKey()) return { ok: false, error: 'no-key' };

  const q = typeof query === 'string' ? query.slice(0, MAX_QUERY_LEN) : '';
  const endpoint = q ? 'search' : 'trending';
  const off = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const params = new URLSearchParams({
    api_key: GIPHY_API_KEY,
    limit: String(PAGE_LIMIT),
    offset: String(off),
    rating: 'pg-13',
  });
  if (q) params.set('q', q);

  let resp;
  try {
    resp = await fetch(`${GIPHY_BASE}/${endpoint}?${params.toString()}`);
  } catch (_) {
    return { ok: false, error: 'network' };
  }
  if (resp.status === 401 || resp.status === 403) return { ok: false, error: 'bad-key' };
  if (!resp.ok) return { ok: false, error: 'http-' + resp.status };

  let data;
  try { data = await resp.json(); } catch (_) { return { ok: false, error: 'bad-response' }; }
  const results = Array.isArray(data.data) ? data.data.map(toResult).filter(Boolean) : [];

  const pagination = data.pagination || {};
  const seen = off + (Number(pagination.count) || results.length);
  const total = Number(pagination.total_count) || 0;
  const nextOffset = seen < total ? seen : null;

  return { ok: true, results, nextOffset };
}

async function giphyFetchBytes(url) {
  if (!isSafeGiphyUrl(url)) return { ok: false, error: 'bad-url' };
  let resp;
  try {
    resp = await fetch(url);
  } catch (_) {
    return { ok: false, error: 'network' };
  }
  if (!resp.ok) return { ok: false, error: 'http-' + resp.status };
  const type = resp.headers.get('content-type') || 'image/gif';
  if (!/^image\/gif/i.test(type)) return { ok: false, error: 'not-gif' };

  let buf;
  try { buf = await resp.arrayBuffer(); } catch (_) { return { ok: false, error: 'bad-body' }; }
  if (buf.byteLength > 15 * 1024 * 1024) return { ok: false, error: 'too-large' };

  // Structured-clone messaging handles ArrayBuffer fine in both browsers,
  // but base64 keeps this robust against any future move to JSON-only
  // transport and is simple to verify by eye while debugging.
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return { ok: true, base64: btoa(binary), type };
}

function handleMessage(msg, _sender, sendResponse) {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'gif-search') {
    giphySearch(msg.query, msg.offset).then(sendResponse);
    return true;
  }
  if (msg.type === 'gif-fetch') {
    giphyFetchBytes(msg.url).then(sendResponse);
    return true;
  }
  if (msg.type === 'notify-reload' && typeof msg.origin === 'string') {
    notifyTabsToReload(msg.origin);
    return false;
  }
  return false;
}

const API = (typeof browser !== 'undefined' && browser && browser.runtime) ? browser : chrome;
API.runtime.onMessage.addListener(handleMessage);

/* ---------------------------------------------------------------------
   "Enable here" persistence — reacts to a permission grant directly,
   rather than depending on the settings popup to run the registration
   itself after the browser's own permission prompt closes.

   Some browsers close the extension's popup the instant that native
   prompt appears, which kills any pending JavaScript in it — including
   whatever was supposed to run right after chrome.permissions.request()
   resolved. Registration was previously only ever attempted from the
   popup, so a closed popup meant the permission ended up granted but the
   content scripts never got registered, leaving the user needing to
   reopen the popup and click "Repair" by hand every time. Listening for
   the grant here instead means it happens the moment permission is
   approved, independent of whether the popup that triggered it is still
   open. popup.js still repeats this same attempt for whichever origin the
   user is looking at, so the two are redundant with each other rather
   than either being a single point of failure. */

function scriptIdsFor(origin) {
  return {
    mainId: `chatto-enhancer-main-${origin}`,
    contentId: `chatto-enhancer-content-${origin}`,
  };
}

async function registerScriptsForOrigin(origin) {
  const originPattern = `${origin}/*`;
  const { mainId, contentId } = scriptIdsFor(origin);
  try {
    await API.scripting.unregisterContentScripts({ ids: [mainId, contentId] });
  } catch (_) { /* nothing registered yet for this origin — fine */ }
  await API.scripting.registerContentScripts([
    {
      id: mainId,
      js: ['main-world.js'],
      matches: [originPattern],
      runAt: 'document_start',
      world: 'MAIN',
    },
    {
      id: contentId,
      js: ['theme-data.js', 'emoji-data.js', 'content/index.js'],
      css: ['styles.css'],
      matches: [originPattern],
      runAt: 'document_idle',
    },
  ]);
}

function originFromMatchPattern(pattern) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)\/\*$/i.exec(pattern);
  return m ? m[1] : null;
}

/* Runs inside the target page, not this file's own scope — must stay fully
   self-contained (no closures over anything outside it). A native OS
   notification would need its own icon and a new "notifications"
   permission for something this minor; an on-page banner needs neither and
   appears right where the user is already looking. */
function showEnableBanner() {
  if (document.getElementById('__chattoEnhancerEnableBanner')) return;
  const el = document.createElement('div');
  el.id = '__chattoEnhancerEnableBanner';
  el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);'
    + 'display:flex;align-items:center;gap:10px;padding:10px 10px 10px 14px;'
    + 'background:#272727;color:#eaeaef;border:1px solid rgba(255,255,255,0.1);'
    + 'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.45);'
    + 'font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;'
    + 'z-index:2147483647;';

  const text = document.createElement('span');
  text.textContent = 'Chatto Enhancer is enabled here — reload the page to activate it.';
  el.appendChild(text);

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload';
  reload.style.cssText = 'background:#2f9bf5;color:#fff;border:none;border-radius:6px;'
    + 'padding:6px 12px;font:600 12px inherit;cursor:pointer;flex-shrink:0;';
  reload.addEventListener('click', () => location.reload());
  el.appendChild(reload);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = '✕';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.style.cssText = 'background:transparent;color:#8b8b96;border:none;'
    + 'font:600 14px inherit;cursor:pointer;padding:0 2px;flex-shrink:0;';
  dismiss.addEventListener('click', () => el.remove());
  el.appendChild(dismiss);

  document.body.appendChild(el);
  setTimeout(() => el.remove(), 20000);
}

function notifyTabsToReload(origin) {
  API.tabs.query({ url: `${origin}/*` }).then((tabs) => {
    for (const tab of tabs || []) {
      if (tab.id == null) continue;
      API.scripting.executeScript({ target: { tabId: tab.id }, func: showEnableBanner }).catch(() => {
        // Some tabs (e.g. chrome://, or one mid-navigation) can't be
        // injected into — nothing to recover, the banner is a courtesy.
      });
    }
  }).catch(() => {});
}

if (API.permissions && API.permissions.onAdded) {
  API.permissions.onAdded.addListener((added) => {
    const origins = (added && added.origins) || [];
    for (const pattern of origins) {
      const origin = originFromMatchPattern(pattern);
      if (!origin) continue;
      let hostname;
      try { hostname = new URL(origin).hostname; } catch (_) { continue; }
      // The Giphy host permissions are declared up front, not granted
      // through "Enable here" — this listener only ever needs to act on a
      // newly approved Chatto domain.
      if (/(^|\.)giphy\.com$/i.test(hostname)) continue;
      registerScriptsForOrigin(origin)
        .then(() => notifyTabsToReload(origin))
        .catch(() => {
          // If this also fails, popup.js's own attempt (or its "Repair"
          // fallback, the next time it's opened) is what's left to recover.
        });
    }
  });
}
