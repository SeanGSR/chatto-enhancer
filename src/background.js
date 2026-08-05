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
  return false;
}

const API = (typeof browser !== 'undefined' && browser && browser.runtime) ? browser : chrome;
API.runtime.onMessage.addListener(handleMessage);
