/* Chatto Enhancer 1.3 — personal library and compatibility layer for
   Chatto 0.6.0-beta.8. Native Chatto features stay native; this script adds
   private saved messages, templates, GIF collections and local profiles. */
(() => {
  'use strict';

  try { window.__ceIsoCleanup?.(); } catch (_) {}

  const API = typeof browser !== 'undefined' && browser?.storage ? browser : chrome;
  const PROMISE_API = typeof browser !== 'undefined' && !!browser?.storage;
  const MAX_NAME_LEN = 160;
  const MAX_GIF_FAVORITES = 200;
  const MAX_LIBRARY_ITEMS = 500;
  const FEATURES = ['gif', 'saved', 'templates', 'nicknames'];
  const log = (...args) => console.log('%c[Chatto Enhancer]', 'color:#2f9bf5;font-weight:600', ...args);
  const warn = (...args) => console.warn('%c[Chatto Enhancer]', 'color:#f5a02f;font-weight:600', ...args);
  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  let settings = { gif: true, saved: true, templates: true, nicknames: true };
  let nicknames = Object.create(null);
  let nicknameUsers = Object.create(null);
  let gifFavorites = [];
  let gifRecent = [];
  let gifCollections = Object.create(null);
  let savedMessages = [];
  let templates = [];
  let userNotes = Object.create(null);
  let ready = false;

  function cleanName(value) {
    if (typeof value !== 'string') return null;
    const name = value.trim();
    return name && name.length <= MAX_NAME_LEN ? name : null;
  }

  function cleanId(value) {
    if (typeof value !== 'string') return null;
    const id = value.trim();
    return id && id.length <= 160 && /^[A-Za-z0-9._:@-]+$/.test(id) ? id : null;
  }

  function cleanSettings(value) {
    const out = { gif: true, saved: true, templates: true, nicknames: true };
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of FEATURES) if (typeof value[key] === 'boolean') out[key] = value[key];
    }
    return out;
  }

  function cleanNicknames(value) {
    const out = Object.create(null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [key, raw] of Object.entries(value).slice(0, 500)) {
      const name = cleanName(key);
      const nickname = cleanName(raw);
      if (name && nickname) out[name] = nickname;
    }
    return out;
  }

  function cleanNicknameUsers(value) {
    const out = Object.create(null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [key, row] of Object.entries(value).slice(0, 500)) {
      const id = cleanId(key);
      const nickname = row && cleanName(row.nickname);
      if (id && nickname) out[id] = { name: cleanName(row.name) || '', nickname };
    }
    return out;
  }

  function isGiphyUrl(value) {
    if (typeof value !== 'string' || value.length > 2048) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && /(^|\.)giphy\.com$/.test(url.hostname);
    } catch (_) { return false; }
  }

  function cleanGif(item) {
    if (!item || typeof item !== 'object' || !isGiphyUrl(item.url)) return null;
    const id = typeof item.id === 'string' && item.id.length <= 64 ? item.id : '';
    if (!id) return null;
    return {
      id,
      title: typeof item.title === 'string' ? item.title.slice(0, 200) : '',
      url: item.url,
      previewUrl: isGiphyUrl(item.previewUrl) ? item.previewUrl : item.url,
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
    };
  }

  function cleanGifs(value) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(value)) return out;
    for (const raw of value) {
      const item = cleanGif(raw);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
      if (out.length >= MAX_GIF_FAVORITES) break;
    }
    return out;
  }

  function cleanText(value, max = 500) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, max);
  }

  function cleanSavedMessages(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of value) {
      const eventId = cleanId(raw?.eventId);
      const url = cleanText(raw?.url, 2048);
      if (!eventId || !/^https?:\/\//.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({
        eventId, url,
        text: cleanText(raw.text, 600),
        author: cleanText(raw.author, 120),
        room: cleanText(raw.room, 120),
        savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : Date.now(),
      });
      if (out.length >= MAX_LIBRARY_ITEMS) break;
    }
    return out;
  }

  function cleanTemplates(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of value) {
      const id = cleanId(raw?.id);
      const text = cleanText(raw?.text, 4000);
      if (!id || !text || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: cleanText(raw.name, 80) || 'Untitled', text });
      if (out.length >= 200) break;
    }
    return out;
  }

  function cleanUserNotes(value) {
    const out = Object.create(null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [rawName, raw] of Object.entries(value).slice(0, 500)) {
      const name = cleanName(rawName);
      if (!name || !raw || typeof raw !== 'object') continue;
      const note = cleanText(raw.note, 1000);
      const tags = Array.isArray(raw.tags)
        ? [...new Set(raw.tags.map((tag) => cleanText(tag, 24)).filter(Boolean))].slice(0, 8)
        : [];
      if (note || tags.length) out[name] = { note, tags };
    }
    return out;
  }

  function cleanGifCollections(value) {
    const out = Object.create(null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [rawName, items] of Object.entries(value).slice(0, 30)) {
      const name = cleanText(rawName, 40);
      if (name) out[name] = cleanGifs(items).slice(0, 100);
    }
    return out;
  }


  function storageGet(keys) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value && typeof value === 'object' ? value : {});
      };
      const timer = setTimeout(() => finish({}), 2000);
      try {
        if (PROMISE_API) API.storage.local.get(keys).then(finish, () => finish({}));
        else API.storage.local.get(keys, (value) => finish(API.runtime.lastError ? {} : value));
      } catch (_) { finish({}); }
    });
  }

  function storageSet(value) {
    try {
      const result = API.storage.local.set(value);
      if (result?.catch) result.catch(() => {});
    } catch (_) {}
  }

  function sendBackground(message) {
    return new Promise((resolve) => {
      try {
        if (PROMISE_API) {
          API.runtime.sendMessage(message).then(
            (result) => resolve(result || { ok: false, error: 'no-response' }),
            () => resolve({ ok: false, error: 'unreachable' }),
          );
        } else {
          API.runtime.sendMessage(message, (result) => {
            resolve(API.runtime.lastError ? { ok: false, error: 'unreachable' } :
              (result || { ok: false, error: 'no-response' }));
          });
        }
      } catch (_) { resolve({ ok: false, error: 'unreachable' }); }
    });
  }

  function svgIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7' })) {
      svg.setAttribute(key, value);
    }
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of [
      ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }],
      ['circle', { cx: '8.5', cy: '8.5', r: '1.5' }],
      ['polyline', { points: '21 15 16 10 5 21' }],
    ]) {
      const node = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      svg.appendChild(node);
    }
    return svg;
  }

  function element(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) node.appendChild(child);
    return node;
  }

  /* ------------------------------ in-app settings --------------------- */

  let settingsPopover = null;
  let settingsButton = null;
  let activeLibraryTab = 'settings';

  function featureSwitch(key, title, description) {
    const copy = element('span', { class: 'ce-setting-copy' }, [
      element('span', { class: 'ce-setting-title', text: title }),
      element('span', { class: 'ce-setting-description', text: description }),
    ]);
    const track = element('span', { class: 'ce-switch-track', 'aria-hidden': 'true' }, [
      element('span', { class: 'ce-switch-thumb' }),
    ]);
    const row = element('button', {
      type: 'button', class: 'ce-setting-row', role: 'switch',
      'aria-checked': String(settings[key]), 'data-ce-feature': key,
    }, [copy, track]);
    row.addEventListener('click', () => {
      settings[key] = !settings[key];
      row.setAttribute('aria-checked', String(settings[key]));
      storageSet({ settings });
      applyFeatureState();
    });
    return row;
  }

  function syncSettingsSwitches() {
    if (!settingsPopover) return;
    qa('.ce-setting-row[data-ce-feature]', settingsPopover).forEach((row) => {
      row.setAttribute('aria-checked', String(settings[row.dataset.ceFeature]));
    });
  }

  function emptyState(text) {
    return element('p', { class: 'ce-library-empty', text });
  }

  function renderSettingsTab(content) {
    content.replaceChildren(
      featureSwitch('gif', 'GIF picker', 'Search and insert GIFs from the composer'),
      featureSwitch('saved', 'Saved messages', 'Add private bookmarks to message menus'),
      featureSwitch('templates', 'Message templates', 'Insert reusable text from the composer'),
      featureSwitch('nicknames', 'Local profiles', 'Nicknames, private notes and tags'),
    );
  }

  function renderSavedTab(content) {
    const search = element('input', {
      type: 'search', class: 'ce-library-search', placeholder: 'Search saved messages',
      'aria-label': 'Search saved messages',
    });
    const list = element('div', { class: 'ce-library-list' });
    const paint = () => {
      const query = search.value.trim().toLowerCase();
      const matches = savedMessages.filter((item) =>
        !query || `${item.author} ${item.room} ${item.text}`.toLowerCase().includes(query));
      list.replaceChildren();
      if (!matches.length) {
        list.appendChild(emptyState(query ? 'No matching messages' : 'No saved messages yet'));
        return;
      }
      for (const item of matches) {
        const link = element('a', { class: 'ce-library-item', href: item.url, title: 'Open message' }, [
          element('span', { class: 'ce-library-item-title', text: item.author || 'Message' }),
          element('span', { class: 'ce-library-item-text', text: item.text || 'Attachment or empty message' }),
          element('span', { class: 'ce-library-item-meta', text: item.room || new URL(item.url).hostname }),
        ]);
        link.addEventListener('click', () => closeSettingsPopover());
        const remove = element('button', {
          type: 'button', class: 'ce-library-remove', title: 'Remove saved message',
          'aria-label': 'Remove saved message', text: '×',
        });
        remove.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          savedMessages = savedMessages.filter((saved) => saved.url !== item.url);
          storageSet({ savedMessages });
          paint();
        });
        const row = element('div', { class: 'ce-library-item-row' }, [link, remove]);
        list.appendChild(row);
      }
    };
    search.addEventListener('input', paint);
    content.replaceChildren(search, list);
    paint();
  }

  function renderTemplatesTab(content) {
    const name = element('input', { type: 'text', class: 'ce-library-input', placeholder: 'Template name', maxlength: '80' });
    const text = element('textarea', { class: 'ce-library-textarea', placeholder: 'Message text', maxlength: '4000', rows: '3' });
    const add = element('button', { type: 'button', class: 'ce-library-primary', text: 'Save template' });
    const form = element('div', { class: 'ce-template-form' }, [name, text, add]);
    const list = element('div', { class: 'ce-library-list' });
    const paint = () => {
      list.replaceChildren();
      if (!templates.length) list.appendChild(emptyState('No templates yet'));
      for (const item of templates) {
        const copy = element('span', { class: 'ce-setting-copy' }, [
          element('span', { class: 'ce-library-item-title', text: item.name }),
          element('span', { class: 'ce-library-item-text', text: item.text }),
        ]);
        const insert = element('button', { type: 'button', class: 'ce-library-insert', text: 'Insert' });
        insert.addEventListener('click', () => {
          if (insertTemplateText(item.text)) closeSettingsPopover();
          else navigator.clipboard?.writeText(item.text).catch(() => {});
        });
        const remove = element('button', {
          type: 'button', class: 'ce-library-remove', title: 'Delete template',
          'aria-label': 'Delete template', text: '×',
        });
        remove.addEventListener('click', () => {
          templates = templates.filter((template) => template.id !== item.id);
          storageSet({ templates });
          paint();
        });
        list.appendChild(element('div', { class: 'ce-template-row' }, [copy, insert, remove]));
      }
    };
    add.addEventListener('click', () => {
      const templateText = cleanText(text.value, 4000);
      if (!templateText) { text.focus(); return; }
      templates.unshift({
        id: `template-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: cleanText(name.value, 80) || templateText.slice(0, 32), text: templateText,
      });
      templates = cleanTemplates(templates);
      storageSet({ templates });
      name.value = '';
      text.value = '';
      paint();
    });
    content.replaceChildren(form, list);
    paint();
  }

  function renderGifLibraryTab(content) {
    const input = element('input', {
      type: 'text', class: 'ce-library-input', placeholder: 'New collection name', maxlength: '40',
    });
    const add = element('button', { type: 'button', class: 'ce-library-primary ce-library-add', text: 'Add' });
    const creator = element('div', { class: 'ce-collection-create' }, [input, add]);
    const list = element('div', { class: 'ce-library-list' });
    const paint = () => {
      list.replaceChildren(
        element('div', { class: 'ce-collection-row' }, [
          element('span', { text: 'Recent GIFs' }), element('span', { class: 'ce-count', text: String(gifRecent.length) }),
        ]),
        element('div', { class: 'ce-collection-row' }, [
          element('span', { text: 'Favorites' }), element('span', { class: 'ce-count', text: String(gifFavorites.length) }),
        ]),
      );
      for (const [collectionName, items] of Object.entries(gifCollections)) {
        const remove = element('button', {
          type: 'button', class: 'ce-library-remove', title: `Delete ${collectionName}`,
          'aria-label': `Delete ${collectionName}`, text: '×',
        });
        remove.addEventListener('click', () => {
          delete gifCollections[collectionName];
          storageSet({ gifCollections });
          paint();
        });
        list.appendChild(element('div', { class: 'ce-collection-row' }, [
          element('span', { text: collectionName }),
          element('span', { class: 'ce-count', text: String(items.length) }), remove,
        ]));
      }
    };
    const create = () => {
      const collectionName = cleanText(input.value, 40);
      if (!collectionName || gifCollections[collectionName]) { input.focus(); return; }
      gifCollections[collectionName] = [];
      storageSet({ gifCollections });
      input.value = '';
      paint();
    };
    add.addEventListener('click', create);
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') create(); });
    content.replaceChildren(creator, list, element('p', {
      class: 'ce-library-hint', text: 'Choose a collection from the GIF picker before adding GIFs.',
    }));
    paint();
  }

  function renderLibraryTab(tab = activeLibraryTab) {
    if (!settingsPopover) return;
    activeLibraryTab = tab;
    qa('.ce-settings-tab', settingsPopover).forEach((button) => {
      button.setAttribute('aria-selected', String(button.dataset.ceTab === tab));
    });
    const content = q('.ce-settings-content', settingsPopover);
    if (!content) return;
    content.className = 'ce-settings-content menu-section ce-settings-' + tab;
    if (tab === 'saved') renderSavedTab(content);
    else if (tab === 'templates') renderTemplatesTab(content);
    else if (tab === 'gifs') renderGifLibraryTab(content);
    else renderSettingsTab(content);
    positionSettingsPopover();
  }

  function buildSettingsPopover() {
    const logo = element('img', {
      class: 'ce-settings-logo', src: API.runtime.getURL('icons/icon-32.png'), alt: '',
    });
    const heading = element('div', { class: 'ce-settings-heading' }, [
      element('strong', { text: 'Chatto Enhancer' }),
      element('span', { text: 'Enhancements for Chatto 0.6' }),
    ]);
    const tabs = element('div', { class: 'ce-settings-tabs menu-section', role: 'tablist' });
    for (const [tab, label] of [['settings', 'Settings'], ['saved', 'Saved'], ['templates', 'Templates'], ['gifs', 'GIFs']]) {
      const button = element('button', {
        type: 'button', class: 'ce-settings-tab', role: 'tab', text: label,
        'data-ce-tab': tab, 'aria-selected': String(tab === activeLibraryTab),
      });
      button.addEventListener('click', () => renderLibraryTab(tab));
      tabs.appendChild(button);
    }
    return element('div', {
      class: 'ce-settings-popover menu overlay-enter', role: 'dialog',
      'aria-label': 'Chatto Enhancer settings',
    }, [
      element('div', { class: 'ce-settings-header menu-section' }, [logo, heading]),
      tabs,
      element('div', { class: 'ce-settings-content menu-section' }),
    ]);
  }

  function positionSettingsPopover() {
    if (!settingsPopover || !settingsButton) return;
    const rect = settingsButton.getBoundingClientRect();
    const width = settingsPopover.offsetWidth || 300;
    const height = settingsPopover.offsetHeight || 190;
    const edge = 8;
    settingsPopover.style.left = Math.max(edge, Math.min(rect.left, innerWidth - width - edge)) + 'px';
    settingsPopover.style.top = Math.max(edge, Math.min(rect.bottom + 4, innerHeight - height - edge)) + 'px';
  }

  function closeSettingsPopover() {
    settingsPopover?.remove();
    settingsPopover = null;
    settingsButton?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onSettingsOutside, true);
    window.removeEventListener('resize', positionSettingsPopover, true);
    window.removeEventListener('scroll', positionSettingsPopover, true);
  }

  function onSettingsOutside(event) {
    if (settingsPopover && !settingsPopover.contains(event.target) && !settingsButton?.contains(event.target)) {
      closeSettingsPopover();
    }
  }

  function toggleSettingsPopover() {
    if (settingsPopover) { closeSettingsPopover(); return; }
    settingsPopover = buildSettingsPopover();
    document.body.appendChild(settingsPopover);
    settingsButton?.setAttribute('aria-expanded', 'true');
    renderLibraryTab(activeLibraryTab);
    positionSettingsPopover();
    requestAnimationFrame(() => document.addEventListener('pointerdown', onSettingsOutside, true));
    window.addEventListener('resize', positionSettingsPopover, true);
    window.addEventListener('scroll', positionSettingsPopover, true);
  }

  function ensureSettingsButton() {
    const header = q('.app-header');
    const leading = header?.firstElementChild;
    if (!leading) return;
    if (settingsButton?.isConnected) return;
    if (settingsPopover) closeSettingsPopover();
    const logo = element('img', {
      class: 'ce-header-logo', src: API.runtime.getURL('icons/icon-32.png'), alt: '',
    });
    settingsButton = element('button', {
      type: 'button', class: 'app-header-icon ce-settings-trigger',
      title: 'Chatto Enhancer', 'aria-label': 'Chatto Enhancer settings',
      'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    }, [logo]);
    settingsButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleSettingsPopover();
    });
    const nativeSettings = q('a[href*="preferences"]', leading);
    if (nativeSettings) nativeSettings.insertAdjacentElement('afterend', settingsButton);
    else leading.appendChild(settingsButton);
  }

  /* ----------------------------- Chatto 0.6 composers ------------------ */

  let composerSequence = 0;
  function composerId(editor) {
    if (!editor.dataset.ceCid) editor.dataset.ceCid = String(++composerSequence);
    return editor.dataset.ceCid;
  }

  function visible(node) {
    return !!node && node.isConnected && node.getAttribute('contenteditable') !== 'false' && node.offsetParent !== null;
  }

  function editors() {
    const found = qa(
      '[data-testid="message-input"][contenteditable="true"], ' +
      '[data-testid="thread-reply-input"][contenteditable="true"], ' +
      '[data-composer-editor] [contenteditable="true"]',
    ).filter(visible);
    return [...new Set(found)];
  }

  function composerFor(editor) {
    return editor.closest('[data-testid="message-composer"]') || editor.closest('form') || editor.parentElement;
  }

  function sendButton(editor) {
    const composer = composerFor(editor);
    const toolbar = composer && q('[data-testid="composer-action-toolbar"]', composer);
    const buttons = toolbar ? qa('button', toolbar).filter((button) => !button.classList.contains('ce-gif-btn')) : [];
    return buttons.at(-1) || null;
  }

  function createGifButton() {
    const wrapper = element('div', {
      class: 'pill-button-group pill-button-group-compact pill-button-group-hover-bevel pill-button-group-touch w-auto shrink-0 ce-gif-native-wrap',
    });
    const button = element('button', {
      type: 'button', class: 'pill-button ce-gif-btn', title: 'Insert GIF', 'aria-label': 'Insert GIF',
      'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    });
    button.appendChild(svgIcon());
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleGifPicker(button);
    });
    wrapper.appendChild(button);
    button.__ceWrapper = wrapper;
    return button;
  }

  function ensureGifButtons() {
    const live = new Set(editors().map(composerId));
    qa('.ce-gif-btn').forEach((button) => {
      if (!live.has(button.dataset.ceFor)) (button.closest('.ce-gif-native-wrap') || button).remove();
    });
    for (const editor of editors()) {
      const id = composerId(editor);
      if (qa('.ce-gif-btn').some((button) => button.dataset.ceFor === id)) continue;
      const button = createGifButton();
      button.dataset.ceFor = id;
      const wrapper = button.__ceWrapper;
      const toolbar = q('[data-testid="composer-action-toolbar"]', composerFor(editor));
      const insertionGroup = toolbar && q(':scope > div', toolbar);
      const send = sendButton(editor);
      const sendWrapper = send?.closest('.pill-button-group') || send?.parentElement;
      // GIF is an insertion tool, so it belongs with attachment, emoji, and
      // timestamp—not inside or beside the Send action group.
      if (insertionGroup) insertionGroup.appendChild(wrapper);
      else if (sendWrapper?.parentElement) sendWrapper.parentElement.insertBefore(wrapper, sendWrapper);
      else {
        const composer = composerFor(editor);
        if (!composer) continue;
        composer.classList.add('ce-composer');
        wrapper.classList.add('ce-gif-float');
        composer.appendChild(wrapper);
      }
    }
  }

  /* ------------------------------------ message templates ------------- */

  let templatePicker = null;
  let templatePickerFor = null;

  function insertTemplateText(text, composerKey = templatePickerFor) {
    const editor = editors().find((item) => composerId(item) === composerKey) || editors()[0];
    if (!editor || !text) return false;
    editor.focus();
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, text); } catch (_) {}
    if (!inserted) {
      try {
        const transfer = new DataTransfer();
        transfer.setData('text/plain', text);
        inserted = editor.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: transfer, bubbles: true, cancelable: true,
        }));
      } catch (_) {}
    }
    closeTemplatePicker();
    return true;
  }

  function buildTemplatePicker() {
    const search = element('input', {
      type: 'search', class: 'ce-library-search', placeholder: 'Search templates',
      'aria-label': 'Search templates',
    });
    const list = element('div', { class: 'ce-template-picker-list' });
    const manage = element('button', { type: 'button', class: 'ce-template-manage', text: 'Manage templates' });
    const picker = element('div', {
      class: 'ce-template-picker menu overlay-enter', role: 'dialog', 'aria-label': 'Message templates',
    }, [
      element('div', { class: 'menu-section ce-template-search' }, [search]),
      element('div', { class: 'menu-section ce-template-picker-body' }, [list]),
      element('div', { class: 'menu-section ce-template-manage-wrap' }, [manage]),
    ]);
    const paint = () => {
      const query = search.value.trim().toLowerCase();
      const matches = templates.filter((item) =>
        !query || `${item.name} ${item.text}`.toLowerCase().includes(query));
      list.replaceChildren();
      if (!matches.length) list.appendChild(emptyState(query ? 'No matching templates' : 'No templates yet'));
      for (const item of matches) {
        const button = element('button', { type: 'button', class: 'ce-template-choice' }, [
          element('span', { class: 'ce-library-item-title', text: item.name }),
          element('span', { class: 'ce-library-item-text', text: item.text }),
        ]);
        button.addEventListener('click', () => insertTemplateText(item.text));
        list.appendChild(button);
      }
    };
    search.addEventListener('input', paint);
    picker.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeTemplatePicker(); });
    manage.addEventListener('click', () => {
      closeTemplatePicker();
      activeLibraryTab = 'templates';
      if (!settingsPopover) toggleSettingsPopover();
      else renderLibraryTab('templates');
    });
    paint();
    setTimeout(() => search.focus(), 0);
    return picker;
  }

  function positionTemplatePicker(button) {
    if (!templatePicker) return;
    const rect = button.getBoundingClientRect();
    const width = templatePicker.offsetWidth || 320;
    const height = templatePicker.offsetHeight || 300;
    const edge = 8;
    const above = rect.top - height - 4;
    templatePicker.style.left = Math.max(edge, Math.min(rect.right - width, innerWidth - width - edge)) + 'px';
    templatePicker.style.top = Math.max(edge, above >= edge ? above : rect.bottom + 4) + 'px';
  }

  function closeTemplatePicker() {
    templatePicker?.remove();
    templatePicker = null;
    templatePickerFor = null;
    qa('.ce-template-btn[aria-expanded="true"]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
    document.removeEventListener('pointerdown', onTemplateOutside, true);
  }

  function onTemplateOutside(event) {
    if (templatePicker && !templatePicker.contains(event.target) && !event.target.closest?.('.ce-template-btn')) {
      closeTemplatePicker();
    }
  }

  function toggleTemplatePicker(button) {
    if (templatePicker) { closeTemplatePicker(); return; }
    templatePickerFor = button.dataset.ceFor;
    templatePicker = buildTemplatePicker();
    document.body.appendChild(templatePicker);
    button.setAttribute('aria-expanded', 'true');
    positionTemplatePicker(button);
    requestAnimationFrame(() => document.addEventListener('pointerdown', onTemplateOutside, true));
  }

  function createTemplateButton() {
    const wrapper = element('div', {
      class: 'pill-button-group pill-button-group-compact pill-button-group-hover-bevel pill-button-group-touch w-auto shrink-0 ce-template-native-wrap',
    });
    const button = element('button', {
      type: 'button', class: 'pill-button ce-template-btn', title: 'Message templates',
      'aria-label': 'Message templates', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    }, [element('span', { class: 'iconify icon-[uil--clipboard-notes] ce-template-icon', 'aria-hidden': 'true' })]);
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleTemplatePicker(button);
    });
    wrapper.appendChild(button);
    button.__ceWrapper = wrapper;
    return button;
  }

  function ensureTemplateButtons() {
    const live = new Set(editors().map(composerId));
    qa('.ce-template-btn').forEach((button) => {
      if (!live.has(button.dataset.ceFor)) (button.closest('.ce-template-native-wrap') || button).remove();
    });
    for (const editor of editors()) {
      const id = composerId(editor);
      if (qa('.ce-template-btn').some((button) => button.dataset.ceFor === id)) continue;
      const button = createTemplateButton();
      button.dataset.ceFor = id;
      const toolbar = q('[data-testid="composer-action-toolbar"]', composerFor(editor));
      const insertionGroup = toolbar && q(':scope > div', toolbar);
      if (insertionGroup) insertionGroup.appendChild(button.__ceWrapper);
    }
  }

  /* ----------------------------------------- Giphy picker -------------- */

  let gifPicker = null;
  let gifPickerFor = null;
  let nextOffset = null;
  let searchSequence = 0;
  let currentQuery = '';
  let activeGifCollection = 'Favorites';

  function gifCollectionItems(name = activeGifCollection) {
    return name === 'Favorites' ? gifFavorites : (gifCollections[name] || []);
  }

  function gifInCollection(id, name = activeGifCollection) {
    return gifCollectionItems(name).some((item) => item.id === id);
  }

  function toggleGifCollection(item, name = activeGifCollection) {
    const clean = cleanGif(item);
    if (!clean) return false;
    const items = gifCollectionItems(name);
    const index = items.findIndex((saved) => saved.id === clean.id);
    if (index >= 0) items.splice(index, 1);
    else items.unshift(clean);
    if (name === 'Favorites') {
      gifFavorites = items.slice(0, MAX_GIF_FAVORITES);
      storageSet({ gifFavorites });
    } else {
      gifCollections[name] = items.slice(0, 100);
      storageSet({ gifCollections });
    }
    return index < 0;
  }

  function gifCard(item) {
    const button = element('div', {
      class: 'ce-gif-item', title: item.title || 'Insert GIF', role: 'button', tabindex: '0',
      'aria-label': item.title || 'Insert GIF',
    });
    button.dataset.url = item.url;
    button.dataset.result = JSON.stringify(item);
    const image = element('img', { src: item.previewUrl, alt: '', loading: 'lazy' });
    const star = element('button', {
      type: 'button', class: 'ce-gif-star' + (gifInCollection(item.id) ? ' ce-gif-star-on' : ''),
      title: `Add to ${activeGifCollection}`, 'aria-label': `Toggle in ${activeGifCollection}`, text: '★',
    });
    star.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      star.classList.toggle('ce-gif-star-on', toggleGifCollection(item));
    });
    button.append(image, star);
    button.addEventListener('click', () => insertGif(item.url, button));
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        insertGif(item.url, button);
      }
    });
    return button;
  }

  function renderGifResults(body, items, append = false) {
    let grid = q('.ce-gif-grid', body);
    if (!append) {
      body.replaceChildren();
      grid = null;
    }
    if (!grid) {
      grid = element('div', { class: 'ce-gif-grid' });
      body.appendChild(grid);
    }
    for (const item of items) grid.appendChild(gifCard(item));
    if (!grid.children.length) body.appendChild(element('p', { class: 'ce-gif-empty', text: 'No GIFs found.' }));
  }

  function buildGifPicker() {
    const searchTab = element('button', { type: 'button', class: 'ce-gif-tab ce-active', text: 'GIFs' });
    const recentTab = element('button', { type: 'button', class: 'ce-gif-tab', text: 'Recent' });
    const libraryTab = element('button', { type: 'button', class: 'ce-gif-tab', text: 'Library' });
    const search = element('input', { type: 'search', placeholder: 'Search GIPHY', 'aria-label': 'Search GIPHY' });
    const collection = element('select', { class: 'ce-gif-collection', 'aria-label': 'GIF collection' });
    collection.appendChild(element('option', { value: 'Favorites', text: 'Favorites' }));
    for (const name of Object.keys(gifCollections)) collection.appendChild(element('option', { value: name, text: name }));
    if (!gifCollections[activeGifCollection] && activeGifCollection !== 'Favorites') activeGifCollection = 'Favorites';
    collection.value = activeGifCollection;
    const body = element('div', { class: 'ce-gif-body' });
    const controls = element('div', { class: 'ce-gif-search menu-section' }, [search, collection]);
    const picker = element('div', { class: 'ce-gif-picker menu overlay-enter', role: 'dialog', 'aria-label': 'GIF picker' }, [
      element('div', { class: 'ce-gif-tabs menu-section' }, [searchTab, recentTab, libraryTab]),
      controls,
      element('div', { class: 'ce-gif-results menu-section' }, [body]),
      element('div', { class: 'ce-gif-credit', text: 'Powered by GIPHY' }),
    ]);

    let tab = 'search';
    let debounce = 0;
    const renderLocal = () => {
      const query = search.value.trim().toLowerCase();
      const items = tab === 'recent' ? gifRecent : gifCollectionItems();
      renderGifResults(body, items.filter((item) => !query || item.title.toLowerCase().includes(query)));
    };
    const setTab = (next) => {
      tab = next;
      searchTab.classList.toggle('ce-active', tab === 'search');
      recentTab.classList.toggle('ce-active', tab === 'recent');
      libraryTab.classList.toggle('ce-active', tab === 'library');
      collection.style.display = tab === 'library' ? 'block' : 'none';
      search.placeholder = tab === 'search' ? 'Search GIPHY' : tab === 'recent' ? 'Search recent GIFs' : 'Search collection';
      if (tab !== 'search') renderLocal();
      else searchGifs(search.value.trim(), body);
    };
    searchTab.addEventListener('click', () => setTab('search'));
    recentTab.addEventListener('click', () => setTab('recent'));
    libraryTab.addEventListener('click', () => setTab('library'));
    collection.addEventListener('change', () => {
      activeGifCollection = collection.value;
      renderLocal();
    });
    search.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => tab === 'search' ? searchGifs(search.value.trim(), body) : renderLocal(), 250);
    });
    body.addEventListener('scroll', () => {
      if (tab === 'search' && nextOffset !== null && body.scrollTop + body.clientHeight > body.scrollHeight - 180) {
        searchGifs(currentQuery, body, true);
      }
    });
    picker.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeGifPicker();
    });
    searchGifs('', body);
    collection.style.display = 'none';
    setTimeout(() => search.focus(), 0);
    return picker;
  }

  async function searchGifs(query, body, append = false) {
    const sequence = ++searchSequence;
    currentQuery = query;
    if (!append) body.replaceChildren(element('p', { class: 'ce-gif-empty', text: 'Loading…' }));
    const result = await sendBackground({ type: 'gif-search', query, offset: append ? nextOffset : 0 });
    if (sequence !== searchSequence || !gifPicker) return;
    if (!result.ok) {
      if (!append) body.replaceChildren(element('p', { class: 'ce-gif-empty', text: 'GIF search unavailable.' }));
      return;
    }
    nextOffset = result.nextOffset;
    renderGifResults(body, result.results || [], append);
  }

  function positionPicker(button) {
    if (!gifPicker) return;
    const rect = button.getBoundingClientRect();
    const width = gifPicker.offsetWidth || 330;
    const height = gifPicker.offsetHeight || 420;
    const edge = 8;
    const gap = 4;
    const above = rect.top - height - gap;
    const below = rect.bottom + gap;
    const top = above >= edge ? above : Math.min(below, innerHeight - height - edge);
    gifPicker.style.left = Math.max(edge, Math.min(rect.right - width, innerWidth - width - edge)) + 'px';
    gifPicker.style.top = Math.max(edge, top) + 'px';
  }

  function closeGifPicker() {
    gifPicker?.remove();
    gifPicker = null;
    gifPickerFor = null;
    searchSequence++;
    qa('.ce-gif-btn.ce-open').forEach((button) => {
      button.classList.remove('ce-open');
      button.setAttribute('aria-expanded', 'false');
    });
    document.removeEventListener('pointerdown', onGifOutside, true);
    window.removeEventListener('resize', onGifReflow, true);
    window.removeEventListener('scroll', onGifReflow, true);
  }

  function onGifOutside(event) {
    if (gifPicker && !gifPicker.contains(event.target) && !event.target.closest('.ce-gif-btn')) closeGifPicker();
  }

  function onGifReflow() {
    const button = q('.ce-gif-btn.ce-open');
    if (button) positionPicker(button);
  }

  function toggleGifPicker(button) {
    if (gifPicker) { closeGifPicker(); return; }
    gifPickerFor = button.dataset.ceFor;
    gifPicker = buildGifPicker();
    document.body.appendChild(gifPicker);
    button.classList.add('ce-open');
    button.setAttribute('aria-expanded', 'true');
    positionPicker(button);
    requestAnimationFrame(() => document.addEventListener('pointerdown', onGifOutside, true));
    window.addEventListener('resize', onGifReflow, true);
    window.addEventListener('scroll', onGifReflow, true);
  }

  function base64Bytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  async function insertGif(url, button) {
    const editor = editors().find((item) => composerId(item) === gifPickerFor);
    if (!editor) return;
    button.classList.add('ce-loading');
    const result = await sendBackground({ type: 'gif-fetch', url });
    button.classList.remove('ce-loading');
    if (!result.ok) { warn('GIF fetch failed:', result.error); return; }
    try {
      const file = new File([base64Bytes(result.base64)], 'giphy.gif', { type: result.type || 'image/gif' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      try {
        const item = cleanGif(JSON.parse(button.dataset.result || 'null'));
        if (item) {
          gifRecent = [item, ...gifRecent.filter((saved) => saved.id !== item.id)].slice(0, 50);
          storageSet({ gifRecent });
        }
      } catch (_) {}
      closeGifPicker();
      editor.focus();
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    } catch (error) { warn('GIF insertion failed:', error); }
  }

  /* -------------------------------- private saved messages ------------ */

  let lastMessageSnapshot = null;
  let lastMessageInteractionAt = 0;

  function snapshotMessage(article) {
    const eventId = cleanId(article?.dataset.eventId);
    if (!eventId) return null;
    const stack = q('.message-content-stack', article);
    const body = stack && Array.from(stack.children).find((node) =>
      node.classList?.contains('pointer-fine:select-text'));
    const authorNode = q('.font-semibold bdi:not(.ce-nick-label)', article);
    const roomPane = article.closest('[data-testid="room-main-pane"]');
    const roomNode = roomPane && q('h1 bdi', roomPane);
    const url = new URL(location.href);
    url.searchParams.set('highlight', eventId);
    url.hash = '';
    return {
      eventId,
      url: url.href,
      text: cleanText(body?.innerText || article.innerText, 600),
      author: cleanText(authorNode?.textContent, 120),
      room: cleanText(roomNode?.textContent, 120),
      savedAt: Date.now(),
    };
  }

  function rememberMessageInteraction(event) {
    const target = event.target instanceof Element ? event.target : null;
    const article = target?.closest('[role="article"][data-event-id]');
    if (!article) return;
    lastMessageSnapshot = snapshotMessage(article);
    lastMessageInteractionAt = Date.now();
  }

  document.addEventListener('pointerdown', rememberMessageInteraction, true);
  document.addEventListener('contextmenu', rememberMessageInteraction, true);

  function isMessageSaved(item) {
    return !!item && savedMessages.some((saved) => saved.url === item.url);
  }

  function toggleSavedMessage(item) {
    if (!item) return false;
    const index = savedMessages.findIndex((saved) => saved.url === item.url);
    if (index >= 0) savedMessages.splice(index, 1);
    else savedMessages.unshift(item);
    savedMessages = cleanSavedMessages(savedMessages);
    storageSet({ savedMessages });
    return index < 0;
  }

  function addSaveMessageActions() {
    if (!lastMessageSnapshot || Date.now() - lastMessageInteractionAt > 5000) return;
    for (const menu of qa('[popover].menu.min-w-72')) {
      const actionContainer = q('[data-menu-presentation]', menu) || menu;
      const hasMessageLinkAction = qa('.iconify', menu).some((icon) =>
        icon.classList.contains('icon-[uil--link]'));
      if (!hasMessageLinkAction) continue;
      if (q('.ce-save-message-section', actionContainer)) continue;
      const section = element('div', { class: 'menu-section ce-save-message-section' });
      const icon = element('span', {
        class: 'iconify menu-entry-leading self-start menu-entry-leading-floating icon-[uil--clipboard-notes]',
        'aria-hidden': 'true',
      });
      const label = element('span', {
        class: 'min-w-0 flex-1',
        text: isMessageSaved(lastMessageSnapshot) ? 'Remove saved message' : 'Save message',
      });
      const button = element('button', {
        type: 'button', class: 'menu-entry ce-save-message-btn',
      }, [icon, label]);
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const saved = toggleSavedMessage(lastMessageSnapshot);
        label.textContent = saved ? 'Remove saved message' : 'Save message';
        renderLibraryTab(activeLibraryTab);
      });
      section.appendChild(button);
      actionContainer.appendChild(section);
    }
  }

  /* -------------------------------------- local nicknames -------------- */

  const ID_ATTRS = ['data-user-id', 'data-author-id', 'data-member-id', 'data-profile-user-id'];
  function userId(node) {
    for (let current = node, depth = 0; current && depth < 6; current = current.parentElement, depth++) {
      for (const attr of ID_ATTRS) {
        const id = cleanId(current.getAttribute?.(attr));
        if (id) return id;
      }
    }
    return null;
  }

  function nicknameFor(name, id) {
    return (id && nicknameUsers[id]?.nickname) || nicknames[name] || null;
  }

  function swapName(node, realName, id = null) {
    if (!node || !realName) return;
    const nickname = nicknameFor(realName, id);
    const label = node.parentElement && q(':scope > .ce-nick-label', node.parentElement);
    if (!nickname) {
      node.classList.remove('ce-name-hidden');
      label?.remove();
      return;
    }
    node.classList.add('ce-name-hidden');
    const replacement = label || document.createElement(node.tagName.toLowerCase());
    const replacementClass = node.className.replace(/\bce-name-hidden\b/g, '').trim() + ' ce-nick-label';
    if (replacement.className !== replacementClass) replacement.className = replacementClass;
    if (replacement.textContent !== nickname) replacement.textContent = nickname;
    const title = `Local nickname for ${realName}`;
    if (replacement.title !== title) replacement.title = title;
    if (!label) node.insertAdjacentElement('afterend', replacement);
  }

  function profileMenus() {
    return qa('[popover].menu[role="dialog"]').filter((menu) =>
      q('.menu-section .font-semibold bdi', menu) && q('.menu-entry', menu));
  }

  function renderUserNote(menu, realName) {
    const existing = q('.ce-user-note-section', menu);
    const entry = userNotes[realName];
    if (!entry) { existing?.remove(); return; }
    const signature = JSON.stringify(entry);
    if (existing?.dataset.ceNote === signature) return;
    existing?.remove();
    const children = [];
    if (entry.tags.length) {
      children.push(element('div', { class: 'ce-user-tags' }, entry.tags.map((tag) =>
        element('span', { class: 'ce-user-tag', text: tag }))));
    }
    if (entry.note) children.push(element('p', { class: 'ce-user-note', text: entry.note }));
    const section = element('div', { class: 'menu-section ce-user-note-section' }, children);
    section.dataset.ceNote = signature;
    const header = q('.menu-section', menu);
    header?.insertAdjacentElement('afterend', section);
  }

  function profileActionButton(anchor, labelText) {
    return element('button', {
      type: 'button', class: anchor.className + ' ce-profile-action', 'aria-label': labelText,
    }, [
      element('span', {
        class: 'iconify menu-entry-leading self-start menu-entry-leading-floating icon-[uil--edit]',
        'aria-hidden': 'true',
      }),
      element('span', { class: 'min-w-0 flex-1', text: labelText }),
    ]);
  }

  function addRenameButtons() {
    for (const menu of profileMenus()) {
      const nameNode = q('.menu-section .font-semibold bdi', menu);
      const realName = cleanName(nameNode?.textContent);
      const anchor = q('.menu-section .menu-entry', menu);
      if (!realName || !anchor?.parentElement) continue;
      renderUserNote(menu, realName);
      if (q('.ce-rename-btn', menu)) continue;
      const button = profileActionButton(anchor, 'Edit nickname');
      button.classList.add('ce-rename-btn');
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        q('.ce-profile-editor', menu)?.remove();
        q('.ce-rename-field', menu)?.remove();
        const input = element('input', {
          type: 'text',
          class: 'ce-rename-input',
          'aria-label': 'Nickname',
        });
        input.value = nicknameFor(realName, userId(menu)) || '';
        input.maxLength = MAX_NAME_LEN;
        const save = element('button', { type: 'button', class: 'ce-rename-save', text: 'Save' });
        const row = element('div', { class: 'ce-rename-field' }, [input, save]);
        // Keep interaction inside the injected editor from being interpreted
        // as a selection or outside click by Chatto's context-menu handlers.
        row.addEventListener('pointerdown', (rowEvent) => rowEvent.stopPropagation());
        row.addEventListener('click', (rowEvent) => rowEvent.stopPropagation());
        let committed = false;
        const commit = () => {
          if (committed) return;
          committed = true;
          const nickname = cleanName(input.value);
          const id = userId(menu);
          // Most Chatto account-name views do not expose a user ID in their
          // DOM. Always keep the display-name fallback so the nickname can be
          // applied there, while retaining the ID entry where one is known.
          if (nickname) nicknames[realName] = nickname;
          else delete nicknames[realName];
          if (id) {
            if (nickname) nicknameUsers[id] = { name: realName, nickname };
            else delete nicknameUsers[id];
          }
          storageSet({ nicknames, nicknameUsers });
          row.remove();
          applyNicknames();
        };
        save.addEventListener('click', commit);
        input.addEventListener('keydown', (keyEvent) => {
          if (keyEvent.key === 'Enter') {
            keyEvent.preventDefault();
            keyEvent.stopPropagation();
            commit();
          }
          if (keyEvent.key === 'Escape') {
            keyEvent.preventDefault();
            keyEvent.stopPropagation();
            row.remove();
            button.focus();
          }
        });
        button.insertAdjacentElement('afterend', row);
        input.focus();
        input.select();
      });
      anchor.insertAdjacentElement('afterend', button);

      const notesButton = profileActionButton(anchor, 'Edit private note');
      notesButton.classList.add('ce-user-note-btn');
      notesButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        q('.ce-rename-field', menu)?.remove();
        q('.ce-profile-editor', menu)?.remove();
        const current = userNotes[realName] || { note: '', tags: [] };
        const noteLabel = element('label', { class: 'ce-profile-field' }, [
          element('span', { text: 'Private note' }),
        ]);
        const note = element('textarea', {
          class: 'ce-profile-textarea', rows: '3', maxlength: '1000', 'aria-label': 'Private note',
        });
        note.value = current.note;
        noteLabel.appendChild(note);
        const tagsLabel = element('label', { class: 'ce-profile-field' }, [
          element('span', { text: 'Tags, separated by commas' }),
        ]);
        const tags = element('input', {
          type: 'text', class: 'ce-profile-tags-input', maxlength: '240', 'aria-label': 'Tags',
        });
        tags.value = current.tags.join(', ');
        tagsLabel.appendChild(tags);
        const save = element('button', { type: 'button', class: 'ce-rename-save', text: 'Save' });
        const editor = element('div', { class: 'ce-profile-editor' }, [noteLabel, tagsLabel, save]);
        editor.addEventListener('pointerdown', (editorEvent) => editorEvent.stopPropagation());
        editor.addEventListener('click', (editorEvent) => editorEvent.stopPropagation());
        const commit = () => {
          const entry = cleanUserNotes({
            [realName]: {
              note: note.value,
              tags: tags.value.split(',').map((tag) => tag.trim()),
            },
          })[realName];
          if (entry) userNotes[realName] = entry;
          else delete userNotes[realName];
          storageSet({ userNotes });
          editor.remove();
          renderUserNote(menu, realName);
        };
        save.addEventListener('click', commit);
        editor.addEventListener('keydown', (keyEvent) => {
          if (keyEvent.key === 'Escape') {
            keyEvent.preventDefault();
            keyEvent.stopPropagation();
            editor.remove();
            notesButton.focus();
          }
          if (keyEvent.key === 'Enter' && (keyEvent.ctrlKey || keyEvent.metaKey)) {
            keyEvent.preventDefault();
            commit();
          }
        });
        notesButton.insertAdjacentElement('afterend', editor);
        note.focus();
      });
      button.insertAdjacentElement('afterend', notesButton);
    }
  }

  function applyNicknames() {
    // AccountName is Chatto's shared component for message authors, member
    // lists, profiles, replies, reactions, calls, search and autocomplete.
    // Target its stable beta.8 structure rather than maintaining a brittle
    // list of individual screens. Never process our own replacement node.
    const accountNames = [
      'span.inline-flex.max-w-full.min-w-0.gap-1.align-baseline > bdi.min-w-0.truncate:not(.ce-nick-label)',
      '[data-event-id] button.font-semibold bdi:not(.ce-nick-label)',
      '[data-event-id] strong.font-semibold > bdi:not(.ce-nick-label)',
      '[data-testid="reaction-tooltip-users"] > bdi:not(.ce-nick-label)',
    ];
    qa(accountNames.join(',')).forEach((node) => {
      const realName = cleanName(node.textContent);
      if (realName) swapName(node, realName, userId(node));
    });
  }

  /* ------------------------------------------------ lifecycle ---------- */

  function applyFeatureState() {
    if (!settings.gif) {
      closeGifPicker();
      qa('.ce-gif-native-wrap').forEach((node) => node.remove());
    }
    if (!settings.nicknames) {
      qa('.ce-rename-btn, .ce-rename-field, .ce-user-note-btn, .ce-profile-editor, .ce-user-note-section, .ce-nick-label').forEach((node) => node.remove());
      qa('.ce-name-hidden').forEach((node) => node.classList.remove('ce-name-hidden'));
    }
    if (!settings.saved) qa('.ce-save-message-section').forEach((node) => node.remove());
    if (!settings.templates) {
      closeTemplatePicker();
      qa('.ce-template-native-wrap').forEach((node) => node.remove());
    }
    scan();
  }

  function scan() {
    ensureSettingsButton();
    if (settings.templates) ensureTemplateButtons();
    if (settings.saved) addSaveMessageActions();
    if (settings.gif) ensureGifButtons();
    if (settings.nicknames) {
      addRenameButtons();
      applyNicknames();
    }
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
  const interval = setInterval(scan, 3000);

  function onStorageChanged(changes, areaName) {
    if (areaName !== 'local') return;
    if (changes.nicknames) nicknames = cleanNicknames(changes.nicknames.newValue);
    if (changes.nicknameUsers) nicknameUsers = cleanNicknameUsers(changes.nicknameUsers.newValue);
    if (changes.gifFavorites) gifFavorites = cleanGifs(changes.gifFavorites.newValue);
    if (changes.gifRecent) gifRecent = cleanGifs(changes.gifRecent.newValue).slice(0, 50);
    if (changes.gifCollections) gifCollections = cleanGifCollections(changes.gifCollections.newValue);
    if (changes.savedMessages) savedMessages = cleanSavedMessages(changes.savedMessages.newValue);
    if (changes.templates) templates = cleanTemplates(changes.templates.newValue);
    if (changes.userNotes) userNotes = cleanUserNotes(changes.userNotes.newValue);
    if (settingsPopover && (changes.savedMessages || changes.templates || changes.gifFavorites || changes.gifRecent || changes.gifCollections)) {
      renderLibraryTab(activeLibraryTab);
    }
    if (templatePicker && changes.templates) closeTemplatePicker();
    if (changes.settings) {
      settings = cleanSettings(changes.settings.newValue);
      syncSettingsSwitches();
      applyFeatureState();
    } else if (changes.nicknames || changes.nicknameUsers || changes.gifFavorites || changes.userNotes) schedule();
  }
  API.storage.onChanged?.addListener(onStorageChanged);

  storageGet([
    'nicknames', 'nicknameUsers', 'gifFavorites', 'gifRecent', 'gifCollections',
    'savedMessages', 'templates', 'userNotes', 'settings',
  ]).then((stored) => {
    nicknames = cleanNicknames(stored.nicknames);
    nicknameUsers = cleanNicknameUsers(stored.nicknameUsers);
    let migratedNickname = false;
    for (const entry of Object.values(nicknameUsers)) {
      if (entry.name && !nicknames[entry.name]) {
        nicknames[entry.name] = entry.nickname;
        migratedNickname = true;
      }
    }
    if (migratedNickname) storageSet({ nicknames });
    gifFavorites = cleanGifs(stored.gifFavorites);
    gifRecent = cleanGifs(stored.gifRecent).slice(0, 50);
    gifCollections = cleanGifCollections(stored.gifCollections);
    savedMessages = cleanSavedMessages(stored.savedMessages);
    templates = cleanTemplates(stored.templates);
    userNotes = cleanUserNotes(stored.userNotes);
    settings = cleanSettings(stored.settings);
    ready = true;
    applyFeatureState();
  });

  window.__ceDebug = () => ({
    version: '1.3.0', target: 'Chatto 0.6.0-beta.8', ready, settings,
    editors: editors().length, gifButtons: qa('.ce-gif-btn').length,
    templateButtons: qa('.ce-template-btn').length, savedMessages: savedMessages.length,
    templates: templates.length, profileMenus: profileMenus().length,
  });

  window.__ceIsoCleanup = () => {
    observer.disconnect();
    clearInterval(interval);
    API.storage.onChanged?.removeListener(onStorageChanged);
    document.removeEventListener('pointerdown', rememberMessageInteraction, true);
    document.removeEventListener('contextmenu', rememberMessageInteraction, true);
    closeSettingsPopover();
    closeGifPicker();
    closeTemplatePicker();
    qa('.ce-settings-trigger, .ce-gif-native-wrap, .ce-template-native-wrap, .ce-save-message-section, .ce-rename-btn, .ce-rename-field, .ce-user-note-btn, .ce-profile-editor, .ce-user-note-section, .ce-nick-label').forEach((node) => node.remove());
    qa('.ce-name-hidden').forEach((node) => node.classList.remove('ce-name-hidden'));
  };

  window.addEventListener('pagehide', window.__ceIsoCleanup, { once: true });
  log('loaded for Chatto 0.6.0-beta.8');
})();
