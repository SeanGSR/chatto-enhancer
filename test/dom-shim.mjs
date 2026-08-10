/* Minimal, dependency-free DOM shim used only to load src/content/index.js
   under Node for the local-card-detection tests. It implements just enough
   of the DOM (element tree, classList, dataset, a small CSS selector
   matcher, MutationObserver, storage/runtime stubs) for that one file to
   run start-to-finish without throwing. It is not a general-purpose DOM
   and should not be reused for anything beyond these tests. */

function parseCompound(token) {
  if (token === '*') return { any: true };
  if (token === ':scope') return { scope: true };
  const m = token.match(/^([a-zA-Z][a-zA-Z0-9-]*)?((?:\.[a-zA-Z0-9_-]+)*)((?:\[[^\]]+\])*)$/);
  if (!m) return { any: true };
  const [, tag, classPart, attrPart] = m;
  const classes = (classPart.match(/\.[a-zA-Z0-9_-]+/g) || []).map((c) => c.slice(1));
  const attrs = (attrPart.match(/\[[^\]]+\]/g) || []).map((raw) => {
    const body = raw.slice(1, -1);
    const eq = body.match(/^([a-zA-Z0-9_-]+)\s*([*^$]?=)\s*"?([^"]*)"?\s*i?$/);
    if (eq) return { name: eq[1], op: eq[2], value: eq[3] };
    return { name: body.trim(), op: null, value: null };
  });
  return { tag: tag ? tag.toUpperCase() : null, classes, attrs };
}

function matchesCompound(el, compound, scopeRoot) {
  if (compound.any) return true;
  if (compound.scope) return el === scopeRoot;
  if (compound.tag && el.tagName !== compound.tag) return false;
  for (const c of compound.classes) if (!el.classList.contains(c)) return false;
  for (const a of compound.attrs) {
    const val = el.getAttribute(a.name);
    if (val === null) return false;
    if (a.op === null) continue; // existence only
    if (a.op === '=' && val !== a.value) return false;
    if (a.op === '*=' && !val.includes(a.value)) return false;
  }
  return true;
}

function tokenizeSelector(sel) {
  // Split on whitespace, keeping '>' as its own token.
  return sel.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
}

function collectSubtree(el, out) {
  for (const c of el.children) { out.push(c); collectSubtree(c, out); }
}

function matchesChain(el, tokens, scopeRoot) {
  // Walk the token chain right-to-left against ancestors.
  let i = tokens.length - 1;
  if (!matchesCompound(el, parseCompound(tokens[i]), scopeRoot)) return false;
  let cur = el;
  i--;
  while (i >= 0) {
    if (tokens[i] === '>') {
      i--;
      cur = cur.parentElement;
      if (!cur) return false;
      if (!matchesCompound(cur, parseCompound(tokens[i]), scopeRoot)) return false;
      i--;
    } else {
      // Descendant combinator: any ancestor may match.
      let found = false;
      let anc = cur.parentElement;
      while (anc) {
        if (matchesCompound(anc, parseCompound(tokens[i]), scopeRoot)) { found = true; cur = anc; break; }
        anc = anc.parentElement;
      }
      if (!found) return false;
      i--;
    }
  }
  return true;
}

function queryAll(root, selector) {
  const groups = selector.split(',').map((s) => tokenizeSelector(s));
  const pool = [];
  collectSubtree(root, pool);
  const out = [];
  for (const el of pool) {
    for (const tokens of groups) {
      if (matchesChain(el, tokens, root)) { out.push(el); break; }
    }
  }
  return out;
}

class ClassList {
  constructor(el) { this.el = el; }
  add(...names) { for (const n of names) this.el._classes.add(n); }
  remove(...names) { for (const n of names) this.el._classes.delete(n); }
  toggle(name, force) {
    const has = this.el._classes.has(name);
    const want = force === undefined ? !has : force;
    if (want) this.el._classes.add(name); else this.el._classes.delete(name);
    return want;
  }
  contains(name) { return this.el._classes.has(name); }
}

function toDatasetKey(attr) {
  return attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
function toAttrName(key) {
  return 'data-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

export class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this._attrs = new Map();
    this._classes = new Set();
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this._text = '';
    this.classList = new ClassList(this);
    this.tabIndex = -1;
    this._listeners = new Map();
    const self = this;
    this.dataset = new Proxy({}, {
      get(_, key) { return self._attrs.get(toAttrName(String(key))); },
      set(_, key, value) { self._attrs.set(toAttrName(String(key)), String(value)); return true; },
      has(_, key) { return self._attrs.has(toAttrName(String(key))); },
    });
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get isConnected() {
    let n = this;
    while (n.parentElement) n = n.parentElement;
    return n === this.ownerDocument.documentElement || n === this.ownerDocument.body;
  }
  get clientHeight() { return 1; }
  setAttribute(name, value) { this._attrs.set(name, String(value)); }
  getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null; }
  removeAttribute(name) { this._attrs.delete(name); }
  hasAttribute(name) { return this._attrs.has(name); }
  appendChild(child) {
    if (child.parentElement) child.parentElement.removeChild(child);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentElement = null;
  }
  insertAdjacentElement(position, el) {
    if (!this.parentElement || position === 'beforebegin' || position === 'afterend') {
      if (!this.parentElement) return null;
      if (el.parentElement) el.parentElement.removeChild(el);
      const siblings = this.parentElement.children;
      const i = siblings.indexOf(this);
      const at = position === 'beforebegin' ? i : i + 1;
      el.parentElement = this.parentElement;
      siblings.splice(at, 0, el);
      return el;
    }
    if (position === 'afterbegin') {
      if (el.parentElement) el.parentElement.removeChild(el);
      el.parentElement = this;
      this.children.unshift(el);
      return el;
    }
    if (position === 'beforeend') return this.appendChild(el);
    return null;
  }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  get firstElementChild() { return this.children[0] || null; }
  querySelector(sel) { const r = queryAll(this, sel); return r[0] || null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
  closest(sel) {
    let n = this;
    while (n) {
      if (queryAll(n.parentElement || n, sel).includes(n) || matchesGroupSelf(n, sel)) return n;
      n = n.parentElement;
    }
    return null;
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    const s = this._listeners.get(type);
    if (s) s.delete(fn);
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  contains(other) {
    let n = other;
    while (n) { if (n === this) return true; n = n.parentElement; }
    return false;
  }
}

function matchesGroupSelf(el, selector) {
  const groups = selector.split(',').map((s) => tokenizeSelector(s));
  return groups.some((tokens) => matchesChain(el, tokens, el));
}

export function createDocument() {
  const doc = {};
  doc.documentElement = new FakeElement('html', doc);
  doc.head = new FakeElement('head', doc);
  doc.body = new FakeElement('body', doc);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.createElement = (tag) => new FakeElement(tag, doc);
  doc.createElementNS = (_ns, tag) => new FakeElement(tag, doc);
  doc.querySelector = (sel) => doc.documentElement.querySelector(sel);
  doc.querySelectorAll = (sel) => doc.documentElement.querySelectorAll(sel);
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  return doc;
}

export function createWindow(doc) {
  const listeners = new Map();
  const win = {
    document: doc,
    location: { origin: 'https://chat.example' },
    navigator: { userAgent: 'NodeTestShim/1.0' },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { const s = listeners.get(type); if (s) s.delete(fn); },
    postMessage() {},
    getComputedStyle: () => ({ display: 'block', backgroundColor: '', color: '' }),
  };
  return win;
}

export class FakeMutationObserver {
  constructor(cb) { this.cb = cb; }
  observe() {}
  disconnect() {}
}

export function createChromeStub() {
  return {
    storage: { local: { get: (_keys, cb) => cb({}), set: (_obj, cb) => cb && cb() } },
    runtime: { getURL: (p) => 'chrome-extension://fake/' + p },
  };
}
