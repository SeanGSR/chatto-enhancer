import test from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScript, unloadContentScript } from './load-content-script.mjs';

/* These tests exercise the real production logic in src/content/index.js
   (via window.__ceLocalCardTestHooks) against a minimal fake DOM — see
   test/dom-shim.mjs. They are not a general DOM-compat suite; they exist to
   pin the local-participant volume-control behavior described in
   SECURITY-REVIEW.md so a future change can't silently regress it. */

function panelWith(document, cards) {
  const panel = document.createElement('div');
  panel.setAttribute('data-testid', 'call-participant-panel');
  document.body.appendChild(panel);
  for (const c of cards) panel.appendChild(c);
  return panel;
}

function card(document, { name, local, id } = {}) {
  const el = document.createElement('div');
  el.setAttribute('data-testid', 'call-participant-card');
  if (local) el.setAttribute('data-local', 'true');
  if (id) el.setAttribute('data-call-participant-id', id);
  if (name) {
    const span = document.createElement('span');
    span.textContent = name;
    el.appendChild(span);
  }
  return el;
}

function setup(t) {
  const { window, document } = loadContentScript();
  t.after(() => unloadContentScript(window));
  return { window, document, hooks: window.__ceLocalCardTestHooks };
}

test('local participant with a direct marker gets no slider; remote does', (t) => {
  const { document, hooks } = setup(t);
  const me = card(document, { name: 'Loading', local: true });
  const remote = card(document, { name: 'Bob' });
  panelWith(document, [me, remote]);

  hooks.dropCache();
  hooks.addSlider(me);
  hooks.addSlider(remote);

  assert.equal(me.querySelector('.ce-vol'), null, 'local card must not get a slider');
  assert.notEqual(remote.querySelector('.ce-vol'), null, 'remote card must get a slider');
});

test('slider injected before local marker resolves is removed once it does', (t) => {
  const { document, hooks } = setup(t);
  // Card starts as an unmarked "Loading" placeholder — indistinguishable
  // from a remote card at this point, so a slider is (unavoidably) added.
  const me = card(document, { name: 'Loading' });
  panelWith(document, [me]);
  hooks.dropCache();
  hooks.addSlider(me);
  assert.notEqual(me.querySelector('.ce-vol'), null, 'sanity: slider was added while identity was unknown');

  // Identity resolves: Chatto marks the card as local.
  me.setAttribute('data-local', 'true');
  hooks.dropCache();
  hooks.addSlider(me); // this is what the per-frame scan() does on every pass

  assert.equal(me.querySelector('.ce-vol'), null, 'slider must be removed once the card is recognized as local');
  assert.equal(me.classList.contains('ce-card'), false);
});

test('duplicate display names are disambiguated by stable participant id', (t) => {
  const { document, hooks } = setup(t);
  const me = card(document, { name: 'Sam', local: true, id: 'user-1' });
  const remote = card(document, { name: 'Sam', id: 'user-2' });
  panelWith(document, [me, remote]);

  hooks.dropCache();
  hooks.addSlider(me);
  hooks.addSlider(remote);

  assert.equal(me.querySelector('.ce-vol'), null);
  assert.notEqual(remote.querySelector('.ce-vol'), null,
    'a remote participant sharing the local display name must still get a slider when ids differ');
});

test('known limitation: duplicate names with no stable id fall back to name matching', (t) => {
  const { document, hooks } = setup(t);
  const me = card(document, { name: 'Sam', local: true });
  const remote = card(document, { name: 'Sam' }); // no id exposed by Chatto
  panelWith(document, [me, remote]);

  hooks.dropCache();
  hooks.addSlider(me);
  hooks.addSlider(remote);

  assert.equal(me.querySelector('.ce-vol'), null);
  // Documented residual limitation (see SECURITY-REVIEW.md): without any id
  // or marker on the remote card, name-based fallback cannot tell it apart
  // from the local user and also suppresses its slider.
  assert.equal(remote.querySelector('.ce-vol'), null);
});

test('local card recreated across a re-render stays marker-free of a slider', (t) => {
  const { document, hooks } = setup(t);
  const panel = panelWith(document, []);
  let me = card(document, { name: 'Loading', local: true });
  panel.appendChild(me);
  hooks.dropCache();
  hooks.addSlider(me);
  assert.equal(me.querySelector('.ce-vol'), null);

  panel.removeChild(me);
  me = card(document, { name: 'Alice', local: true }); // brand-new element/identity
  panel.appendChild(me);
  hooks.dropCache();
  hooks.addSlider(me);
  assert.equal(me.querySelector('.ce-vol'), null, 'a freshly recreated local card must still get no slider');
});

test('remote reconnect does not duplicate its slider', (t) => {
  const { document, hooks } = setup(t);
  const panel = panelWith(document, []);
  const remote = card(document, { name: 'Bob', id: 'user-2' });
  panel.appendChild(remote);
  hooks.dropCache();
  hooks.addSlider(remote);
  hooks.dropCache();
  hooks.addSlider(remote); // simulates the next animation-frame scan
  assert.equal(remote.querySelectorAll('.ce-vol').length, 1);
});

test('malformed/missing participant metadata does not throw and is treated as remote', (t) => {
  const { document, hooks } = setup(t);
  const remote = card(document, {}); // no name, no id, no local marker
  panelWith(document, [remote]);
  hooks.dropCache();
  assert.doesNotThrow(() => hooks.addSlider(remote));
  assert.notEqual(remote.querySelector('.ce-vol'), null);
});
