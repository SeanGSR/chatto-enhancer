/* ==========================================================================
   Chatto Enhancer — settings popup

   The feature toggle list mirrors src/content/index.js. Theme metadata is
   shared through src/theme-data.js so palettes and popup swatches cannot
   drift apart.
   ========================================================================== */

const FEATURES = [
  { key: 'volume', label: 'Per-participant volume sliders' },
  { key: 'emoji', label: 'Emoji picker' },
  { key: 'gif', label: 'GIF picker' },
  { key: 'markdown', label: 'Markdown toolbar' },
  { key: 'pip', label: 'Screen-share pop-out button' },
  { key: 'nicknames', label: 'Local nicknames' },
];

const THEME_DATA = window.__CHATTO_ENHANCER_THEME_DATA__ || {
  themes: [
    { id: 'default', label: 'Default', swatches: ['#272727', '#343434', '#eaeaef', '#2f9bf5'] },
    { id: 'custom', label: 'Custom', swatches: ['#211916', '#3a2a24', '#f5e7d4', '#c98a5b'] },
  ],
  groups: [
    { type: 'single', ids: ['default'] },
    { type: 'single', ids: ['custom'] },
  ],
  customFields: [
    { key: 'background', label: 'Back', value: '#211916' },
    { key: 'surface', label: 'Panel', value: '#2b211d' },
    { key: 'surface100', label: 'Item', value: '#3a2a24' },
    { key: 'text', label: 'Text', value: '#f5e7d4' },
    { key: 'muted', label: 'Muted', value: '#b99f8e' },
    { key: 'accent', label: 'Accent', value: '#c98a5b' },
  ],
};
const THEMES = THEME_DATA.themes;
const THEME_GROUPS = THEME_DATA.groups;
const CUSTOM_THEME_FIELDS = THEME_DATA.customFields;

const API = (typeof browser !== 'undefined' && browser && browser.storage) ? browser : chrome;
const PROMISE_API = (typeof browser !== 'undefined' && browser && browser.storage) ? true : false;
const BUILTIN_ORIGINS = new Set(['https://chat.chatto.run']);

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

function notifyReload(origin) {
  // Asks background.js to drop its on-page "reload to activate" banner
  // into any open tab on this origin. Kept in the background script rather
  // than duplicated here so there's one copy of the banner's own markup —
  // see src/background.js for why this exists at all (this popup can be
  // closed by the browser's own permission prompt before it gets to run
  // anything after the user approves it).
  try {
    const r = API.runtime.sendMessage({ type: 'notify-reload', origin });
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (_) { /* nothing to recover — purely a courtesy notice */ }
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

function cleanThemeId(value) {
  return THEMES.some((theme) => theme.id === value) ? value : 'default';
}

function themeById(id) {
  return THEMES.find((theme) => theme.id === id) || THEMES[0];
}

function svgIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const paths = name === 'sun'
    ? [
      ['circle', { cx: '12', cy: '12', r: '4' }],
      ['path', { d: 'M12 2v2' }],
      ['path', { d: 'M12 20v2' }],
      ['path', { d: 'm4.93 4.93 1.41 1.41' }],
      ['path', { d: 'm17.66 17.66 1.41 1.41' }],
      ['path', { d: 'M2 12h2' }],
      ['path', { d: 'M20 12h2' }],
      ['path', { d: 'm6.34 17.66-1.41 1.41' }],
      ['path', { d: 'm19.07 4.93-1.41 1.41' }],
    ]
    : name === 'pen'
      ? [
        ['path', { d: 'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' }],
        ['path', { d: 'm15 5 4 4' }],
      ]
    : [
      ['path', { d: 'M12 3a6 6 0 0 0 9 7.5A9 9 0 1 1 12 3Z' }],
    ];
  for (const [tag, attrs] of paths) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.appendChild(node);
  }
  return svg;
}

function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function defaultCustomTheme() {
  const out = {};
  for (const field of CUSTOM_THEME_FIELDS) out[field.key] = field.value;
  return out;
}

function cleanCustomTheme(value) {
  const out = defaultCustomTheme();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const field of CUSTOM_THEME_FIELDS) {
      if (isHexColor(value[field.key])) out[field.key] = value[field.key].toLowerCase();
    }
  }
  return out;
}

async function init() {
  const r = await storageGet(['settings', 'theme', 'customTheme']);
  const settings = cleanSettings(r.settings);
  let selectedTheme = cleanThemeId(r.theme);
  const customTheme = cleanCustomTheme(r.customTheme);
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

  const themeChoices = document.getElementById('themeChoices');
  const customThemePanel = document.getElementById('customTheme');
  const themeButtons = new Map();
  const customSwatches = [];
  const paintCustomSwatches = () => {
    const values = [
      customTheme.background,
      customTheme.surface100,
      customTheme.text,
      customTheme.accent,
    ];
    customSwatches.forEach((swatch, index) => { swatch.style.background = values[index]; });
  };
  const paintThemeButtons = () => {
    for (const [id, button] of themeButtons) {
      button.setAttribute('aria-pressed', id === selectedTheme ? 'true' : 'false');
    }
    customThemePanel.style.display = selectedTheme === 'custom' ? 'grid' : 'none';
  };

  function themeButton(theme, mode) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-option';
    if (mode) button.classList.add('theme-option-' + mode);
    button.setAttribute('aria-pressed', 'false');
    const name = document.createElement('span');
    name.className = 'theme-name';
    if (mode) name.appendChild(svgIcon(mode));
    name.appendChild(document.createTextNode(theme.buttonLabel || theme.label));
    button.appendChild(name);
    const swatches = document.createElement('span');
    swatches.className = 'theme-swatches';
    for (const color of theme.swatches) {
      const swatch = document.createElement('span');
      swatch.className = 'theme-swatch';
      swatch.style.background = color;
      if (theme.id === 'custom') customSwatches.push(swatch);
      swatches.appendChild(swatch);
    }
    button.appendChild(swatches);
    button.addEventListener('click', () => {
      selectedTheme = theme.id;
      storageSet({ theme: selectedTheme });
      paintThemeButtons();
    });
    themeButtons.set(theme.id, button);
    return button;
  }

  for (const group of THEME_GROUPS) {
    if (group.type === 'pair') {
      const title = document.createElement('div');
      title.className = 'theme-family';
      title.textContent = group.name;
      themeChoices.appendChild(title);
    }
    const row = document.createElement('div');
    row.className = group.type === 'pair' ? 'theme-row theme-row-pair' : 'theme-row';
    if (group.ids.includes('custom')) row.classList.add('theme-row-custom');
    for (const id of group.ids) {
      const theme = themeById(id);
      const mode = id === 'custom' ? 'pen' : id.endsWith('-light') ? 'sun' : id === 'default' ? null : 'moon';
      row.appendChild(themeButton(theme, mode));
    }
    if (group.ids.includes('custom')) row.appendChild(customThemePanel);
    themeChoices.appendChild(row);
  }

  for (const field of CUSTOM_THEME_FIELDS) {
    const label = document.createElement('label');
    label.className = 'color-field';
    const text = document.createElement('span');
    text.textContent = field.label;
    const colorWrap = document.createElement('span');
    colorWrap.className = 'color-picker';
    const input = document.createElement('input');
    input.type = 'color';
    input.value = customTheme[field.key];
    const value = document.createElement('span');
    value.className = 'color-value';
    value.textContent = input.value;
    input.addEventListener('input', () => {
      customTheme[field.key] = input.value;
      value.textContent = input.value;
      selectedTheme = 'custom';
      storageSet({ theme: selectedTheme, customTheme });
      paintCustomSwatches();
      paintThemeButtons();
    });
    label.appendChild(text);
    colorWrap.appendChild(input);
    label.appendChild(colorWrap);
    label.appendChild(value);
    customThemePanel.appendChild(label);
    paintCustomSwatches();
  }
  paintThemeButtons();
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
const DATA_KEYS = ['volumes', 'recents', 'nicknames', 'nicknameUsers', 'gifFavorites', 'settings', 'theme', 'customTheme'];

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
  enableBtn.disabled = false;
  document.getElementById('enableProgress').style.display = 'none';
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

  if (BUILTIN_ORIGINS.has(origin)) {
    setSiteStatus('Enabled by default on this site.');
    return;
  }

  const already = await API.permissions.contains({ origins: [originPattern] });
  if (already) {
    const registered = await isFullyRegistered(origin);
    if (registered) {
      setSiteStatus('Already enabled on this site.');
      return;
    }
    // Permission exists but the scripts never actually registered — usually
    // because the permission prompt's own dialog closed this popup before
    // it got the chance, right after the user clicked Allow (the
    // background service worker normally handles this itself the instant
    // permission is granted; this is a fallback for whenever it doesn't).
    // Repair automatically rather than making the user notice and click a
    // button for something that isn't really a choice.
    try {
      await registerScriptsFor(origin);
      setSiteStatus('Enabled! Reload the page to activate it.');
      notifyReload(origin);
    } catch (_) {
      setSiteStatus('Permission is granted, but the scripts never registered.');
      enableBtn.textContent = 'Repair';
      enableBtn.dataset.origin = origin;
      enableBtn.dataset.mode = 'repair';
      enableBtn.style.display = 'block';
    }
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
  const progress = document.getElementById('enableProgress');
  const origin = enableBtn.dataset.origin;
  if (!origin) return;
  const originPattern = `${origin}/*`;

  // The whole flow (permission prompt, then registering the scripts, with
  // its own automatic retry below) can take a moment with nothing else
  // visibly happening — disable the button so a second click can't overlap
  // an in-flight one, and show a loading bar for the duration instead of
  // leaving the popup looking unresponsive.
  enableBtn.disabled = true;
  progress.style.display = 'block';
  setSiteStatus('Enabling…');

  if (enableBtn.dataset.mode !== 'repair') {
    let granted;
    try {
      granted = await API.permissions.request({ origins: [originPattern] });
    } catch (_) {
      setSiteStatus('Permission request failed.');
      enableBtn.disabled = false;
      progress.style.display = 'none';
      return;
    }
    if (!granted) {
      setSiteStatus('Permission was not granted.');
      enableBtn.disabled = false;
      progress.style.display = 'none';
      return;
    }
  }

  try {
    await registerScriptsFor(origin);
  } catch (_) {
    // A freshly granted optional permission is sometimes not yet visible to
    // the scripting subsystem on the very next call — retrying once, after
    // giving the browser a moment to catch up, is all "Repair" ever did
    // manually. Only surface an error if it still fails after that.
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      await registerScriptsFor(origin);
    } catch (e) {
      const detail = (e && e.message) ? e.message : 'unknown error';
      setSiteStatus(`Permission granted, but registering scripts failed: ${detail}`);
      enableBtn.disabled = false;
      progress.style.display = 'none';
      return;
    }
  }

  progress.style.display = 'none';
  setSiteStatus('Enabled! Reload the page to activate it.');
  enableBtn.style.display = 'none';
  notifyReload(origin);
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
