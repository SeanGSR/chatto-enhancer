import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createDocument, createWindow, createChromeStub, FakeMutationObserver } from './dom-shim.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'index.js'), 'utf8');

/* Loads a fresh instance of src/content/index.js against a fresh fake DOM.
   Returns { window, document } so a test can build participant cards and
   drive window.__ceLocalCardTestHooks. Each call is fully isolated: nothing
   is shared with a previous load. */
export function loadContentScript() {
  const document = createDocument();
  const window = createWindow(document);
  const chrome = createChromeStub();
  const sandbox = {
    window,
    document,
    chrome,
    navigator: window.navigator,
    MutationObserver: FakeMutationObserver,
    getComputedStyle: window.getComputedStyle,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
  };
  window.window = window;
  sandbox.self = window;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'index.js' });
  return { window, document };
}

/* index.js starts a setInterval safety-net sweep on load. Without clearing
   it via its own exposed cleanup hook, each loaded instance would keep the
   test process alive forever. */
export function unloadContentScript(window) {
  try { if (typeof window.__ceIsoCleanup === 'function') window.__ceIsoCleanup(); } catch (_) {}
}
