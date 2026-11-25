import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/content/index.js', import.meta.url), 'utf8');

test('content script starts, validates stored library data, and cleans up', async () => {
  const document = {
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const window = { addEventListener: () => {}, removeEventListener: () => {} };
  const storageListeners = new Set();
  const chrome = {
    storage: {
      local: {
        get: (_keys, callback) => callback({
          savedMessages: [{
            eventId: 'message-1',
            url: 'https://chat.chatto.run/chat/-/room?highlight=message-1',
            text: 'Saved message',
          }],
          templates: [{ id: 'template-1', name: 'Welcome', text: 'Welcome!' }],
        }),
        set: () => {},
      },
      onChanged: {
        addListener: (listener) => storageListeners.add(listener),
        removeListener: (listener) => storageListeners.delete(listener),
      },
    },
    runtime: {
      lastError: null,
      getURL: (path) => `chrome-extension://test/${path}`,
      sendMessage: (_message, callback) => callback({ ok: false }),
    },
  };
  class MutationObserver {
    observe() {}
    disconnect() {}
  }

  const context = {
    window,
    document,
    chrome,
    MutationObserver,
    URL,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    requestAnimationFrame: (callback) => callback(),
    innerWidth: 1280,
    innerHeight: 720,
  };
  window.window = window;
  vm.runInNewContext(source, context, { filename: 'src/content/index.js' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const debug = window.__ceDebug();
  assert.equal(debug.version, '1.3.0');
  assert.equal(debug.savedMessages, 1);
  assert.equal(debug.templates, 1);
  assert.equal(storageListeners.size, 1);

  window.__ceIsoCleanup();
  assert.equal(storageListeners.size, 0);
});
