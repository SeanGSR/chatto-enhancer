/* ==========================================================================
   Chatto Enhancer — settings popup

   This list, and cleanSettings()'s shape, must stay identical to the copy
   in src/content/index.js. They can't share code directly: this file runs
   in the extension's own popup page, the other inside Chatto's tab as a
   content script — two separate execution contexts, and this project has
   no bundler to join them into one module without adding a build
   dependency the rest of the project deliberately avoids. Small, deliberate
   duplication was judged cheaper than that.
   ========================================================================== */

const FEATURES = [
  { key: 'volume', label: 'Per-participant volume sliders' },
  { key: 'emoji', label: 'Emoji picker' },
  { key: 'gif', label: 'GIF picker' },
  { key: 'markdown', label: 'Markdown toolbar' },
  { key: 'pip', label: 'Screen-share pop-out button' },
  { key: 'nicknames', label: 'Local nicknames' },
];

const API = (typeof browser !== 'undefined' && browser && browser.storage) ? browser : chrome;
const PROMISE_API = (typeof browser !== 'undefined' && browser && browser.storage) ? true : false;

function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      if (PROMISE_API) API.storage.local.get(keys).then((r) => resolve(r || {}), () => resolve({}));
      else API.storage.local.get(keys, (r) => resolve(r || {}));
    } catch (_) { resolve({}); }
  });
}

function storageSet(obj) {
  try {
    const r = API.storage.local.set(obj);
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (_) { /* extension context can go away mid-edit; nothing to do */ }
}

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

async function init() {
  const r = await storageGet(['settings']);
  const settings = cleanSettings(r.settings);
  const container = document.getElementById('toggles');

  for (const f of FEATURES) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = settings[f.key];
    input.addEventListener('change', () => {
      settings[f.key] = input.checked;
      storageSet({ settings });
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(f.label));
    container.appendChild(label);
  }
}

/* --- export / import --------------------------------------------------
   Nothing here syncs across browsers or profiles on its own, so this is a
   plain-file way to carry it over: volumes, recent emoji, nicknames, GIF
   favorites, and these feature toggles.

   Import only checks that the file is valid JSON and copies through the
   known top-level keys — it does not re-validate what's inside each one
   (that every value is a real number, every name under the length limit,
   and so on). It doesn't need to: src/content/index.js already re-runs
   every value read from storage.local through its own cleanVolumes() /
   cleanNicknames() / cleanGifFavorites() / cleanSettings() the next time
   Chatto's tab loads, regardless of whether that data arrived via normal
   use or an import — the real validation gate already exists downstream,
   so duplicating it here (in a separate execution context, the same
   duplication problem noted for FEATURES above) would just be redundant. */
const DATA_KEYS = ['volumes', 'recents', 'nicknames', 'gifFavorites', 'settings'];

function setStatus(text) {
  document.getElementById('dataStatus').textContent = text;
}

async function exportData() {
  const data = await storageGet(DATA_KEYS);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'chatto-enhancer-data.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus('Exported.');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(String(reader.result));
    } catch (_) {
      setStatus('That file is not valid JSON.');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setStatus('That file does not look like exported data.');
      return;
    }
    const toWrite = {};
    let found = 0;
    for (const key of DATA_KEYS) {
      if (key in parsed) { toWrite[key] = parsed[key]; found++; }
    }
    if (!found) {
      setStatus('That file has none of the expected data.');
      return;
    }
    storageSet(toWrite);
    setStatus('Imported — reload Chatto\'s tab to apply.');
  };
  reader.onerror = () => setStatus('Could not read that file.');
  reader.readAsText(file);
}

/* --- enable on a new site -----------------------------------------------
   The extension only auto-activates on the two domains hardcoded into
   config/build.json's hostMatches. For any other domain, the user opts in
   here: we use activeTab (silently granted by the click that opened this
   popup) to peek at the current tab's URL and run a lightweight detection
   check in the page, then — only if that looks like Chatto — ask for a
   permanent host permission scoped to that one origin via
   chrome.permissions.request(). Once granted, we register the same content
   scripts the manifest declares statically for the built-in domains, but
   dynamically for this origin, so it activates on every future visit
   without another rebuild. Nothing here touches other tabs or origins. */

function detectChattoInPage() {
  try {
    if (document.querySelector('[data-testid="server-icon"]')) return true;
    if (document.querySelector('[data-testid="call-participants-list"]')) return true;
    if (document.querySelector('[data-testid="current-user-identity-text"]')) return true;
    try {
      if (window.localStorage.getItem('chatto:preferences') !== null) return true;
    } catch (_) { /* storage may be blocked; ignore */ }
    return false;
  } catch (_) {
    return false;
  }
}

async function getActiveTab() {
  const tabs = PROMISE_API
    ? await API.tabs.query({ active: true, currentWindow: true })
    : await new Promise((resolve) => API.tabs.query({ active: true, currentWindow: true }, resolve));
  return (tabs && tabs[0]) || null;
}

function setSiteStatus(text) {
  document.getElementById('siteStatus').textContent = text;
}

function scriptIdsFor(origin) {
  return {
    mainId: `chatto-enhancer-main-${origin}`,
    contentId: `chatto-enhancer-content-${origin}`,
  };
}

async function registerScriptsFor(origin) {
  const originPattern = `${origin}/*`;
  const { mainId, contentId } = scriptIdsFor(origin);

  // Clear any previous registration for this origin first. Without this, a
  // retry (e.g. after this popup's own past bugs, or clicking twice) hits a
  // "Duplicate script ID" error that used to be silently swallowed here,
  // aborting the *entire* registerContentScripts call — including whichever
  // of the two scripts had never actually registered. That silent failure
  // is exactly what caused permission to show as granted while nothing
  // actually ran on the page.
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
      js: ['emoji-data.js', 'content/index.js'],
      css: ['styles.css'],
      matches: [originPattern],
      runAt: 'document_idle',
    },
  ]);
}

async function isFullyRegistered(origin) {
  const { mainId, contentId } = scriptIdsFor(origin);
  let registered;
  try {
    registered = await API.scripting.getRegisteredContentScripts({ ids: [mainId, contentId] });
  } catch (_) {
    return false;
  }
  return Array.isArray(registered) && registered.length === 2;
}

async function checkThisSite() {
  const enableBtn = document.getElementById('enableHereBtn');
  enableBtn.style.display = 'none';
  enableBtn.textContent = 'Enable here';
  delete enableBtn.dataset.origin;
  delete enableBtn.dataset.mode;

  const tab = await getActiveTab();
  if (!tab || !tab.url || !/^https?:\/\//.test(tab.url) || tab.id == null) {
    setSiteStatus('Open a Chatto tab to check it.');
    return;
  }

  let origin;
  try { origin = new URL(tab.url).origin; } catch (_) {
    setSiteStatus('Open a Chatto tab to check it.');
    return;
  }
  const originPattern = `${origin}/*`;

  const already = await API.permissions.contains({ origins: [originPattern] });
  if (already) {
    const registered = await isFullyRegistered(origin);
    if (registered) {
      setSiteStatus('Already enabled on this site.');
      return;
    }
    // Permission exists but the scripts never actually registered — a
    // stuck state a past version of this popup could leave behind. Offer a
    // one-click fix rather than requiring a permission re-grant.
    setSiteStatus('Permission is granted, but the scripts never registered.');
    enableBtn.textContent = 'Repair';
    enableBtn.dataset.origin = origin;
    enableBtn.dataset.mode = 'repair';
    enableBtn.style.display = 'block';
    return;
  }

  let injection;
  try {
    injection = await API.scripting.executeScript({
      target: { tabId: tab.id },
      func: detectChattoInPage,
    });
  } catch (_) {
    setSiteStatus("Can't check this page (browser pages and some sites block this).");
    return;
  }
  const looksLikeChatto = Array.isArray(injection) && injection[0] && injection[0].result === true;
  if (!looksLikeChatto) {
    setSiteStatus("This doesn't look like a Chatto server.");
    return;
  }

  setSiteStatus('This looks like a Chatto server.');
  enableBtn.dataset.origin = origin;
  enableBtn.dataset.mode = 'enable';
  enableBtn.style.display = 'block';
}

async function enableHere() {
  const enableBtn = document.getElementById('enableHereBtn');
  const origin = enableBtn.dataset.origin;
  if (!origin) return;
  const originPattern = `${origin}/*`;

  if (enableBtn.dataset.mode !== 'repair') {
    let granted;
    try {
      granted = await API.permissions.request({ origins: [originPattern] });
    } catch (_) {
      setSiteStatus('Permission request failed.');
      return;
    }
    if (!granted) {
      setSiteStatus('Permission was not granted.');
      return;
    }
  }

  try {
    await registerScriptsFor(origin);
  } catch (e) {
    const detail = (e && e.message) ? e.message : 'unknown error';
    setSiteStatus(`Permission granted, but registering scripts failed: ${detail}`);
    return;
  }

  setSiteStatus('Enabled! Reload the page to activate it.');
  enableBtn.style.display = 'none';
}

document.getElementById('enableHereBtn').addEventListener('click', enableHere);
checkThisSite();

document.getElementById('exportBtn').addEventListener('click', exportData);
document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});
document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) importData(file);
  e.target.value = '';
});

init();
