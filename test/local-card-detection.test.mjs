import test from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScript, unloadContentScript } from './load-content-script.mjs';

/* These tests exercise the real production logic in src/content/index.js
   (via window.__ceLocalCardTestHooks) against a minimal fake DOM — see
   test/dom-shim.mjs. They are not a general DOM-compat suite; they exist to
   pin the local-participant volume-control behavior described in
   SECURITY-REVIEW.md so a future change can't silently regress it.

   The card() and sidebarIdentity() fixtures below mirror the markup
   captured from a live Chatto call. Participant cards carry no data-local,
   data-local-participant, or any participant-id attribute at all — only a
   plain `title` attribute holding the raw display name.

   [data-testid="current-user-identity-text"] (the account panel, reused for
   the in-call "you are" label) nests the plain name in an inner span, with
   an optional sibling span carrying a custom status emoji + tooltip one
   level deeper than the name. Reading the outer wrapper's combined text
   (the original strategy) swept the status emoji in with the name, which
   was the actual cause of local-card detection permanently failing on live
   Chatto — not a loading race. sidebarIdentity() reproduces that exact
   nesting so the tests exercise the real traversal, not a simplified
   stand-in. Names used below are arbitrary placeholders, not tied to any
   specific account or session. */

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
  if (name) el.setAttribute('title', name); // matches the live card markup
  return el;
}

/* Reproduces the real current-user-identity-text markup:
   <div data-testid="current-user-identity-text">
     <span>                          <- "name row"
       <span>{name}</span>           <- plain name, no decoration
       <span title="{status}">       <- optional custom status, own subtree
         <span>{emoji}</span>
       </span>
     </span>
     <span>@{handle}</span>
   </div> */
function sidebarIdentity(document, { name, status, handle } = {}) {
  const container = document.createElement('div');
  container.setAttribute('data-testid', 'current-user-identity-text');

  const nameRow = document.createElement('span');
  const nameSpan = document.createElement('span');
  nameSpan.textContent = name;
  nameRow.appendChild(nameSpan);

  if (status) {
    const statusSpan = document.createElement('span');
    statusSpan.setAttribute('title', status);
    statusSpan.setAttribute('aria-label', status);
    const emojiSpan = document.createElement('span');
    emojiSpan.setAttribute('aria-hidden', 'true');
    emojiSpan.textContent = status.split(' ')[0];
    statusSpan.appendChild(emojiSpan);
    nameRow.appendChild(statusSpan);
  }
  container.appendChild(nameRow);

  const handleSpan = document.createElement('span');
  handleSpan.textContent = '@' + (handle || name);
  container.appendChild(handleSpan);

  document.body.appendChild(container);
  return container;
}

function setup(t) {
  const { window, document } = loadContentScript();
  t.after(() => unloadContentScript(window));
  return { window, document, hooks: window.__ceLocalCardTestHooks };
}

test('confirmed live shape: a custom status next to the sidebar name does not leak into the comparison', (t) => {
  const { document, hooks } = setup(t);
  sidebarIdentity(document, { name: 'Guest-482', status: '\u{1F411} Just sheeping around' });
  const me = card(document, { name: 'Guest-482' });      // no marker/id, as observed live
  const remote = card(document, { name: 'Guest-119' });
  panelWith(document, [me, remote]);

  assert.equal(hooks.localUserName(), 'Guest-482', 'the status emoji subtree must not be swept into the name');

  hooks.dropCache();
  hooks.addSlider(me);
  hooks.addSlider(remote);

  assert.equal(me.querySelector('.ce-vol'), null, 'local card must not get a slider');
  assert.notEqual(remote.querySelector('.ce-vol'), null, 'remote card must get a slider');
});

test('local user with no custom status set is still detected correctly', (t) => {
  const { document, hooks } = setup(t);
  sidebarIdentity(document, { name: 'Guest-482' }); // no status span at all
  const me = card(document, { name: 'Guest-482' });
  panelWith(document, [me]);

  assert.equal(hooks.localUserName(), 'Guest-482');
  hooks.dropCache();
  hooks.addSlider(me);
  assert.equal(me.querySelector('.ce-vol'), null);
});

test('stripTrailingDecoration remains a defensive fallback for coarser/older DOM shapes', (t) => {
  const { hooks } = setup(t);
  assert.equal(hooks.stripTrailingDecoration('Guest-482 \u{1F411}'), 'Guest-482');
  assert.equal(hooks.stripTrailingDecoration('Alex'), 'Alex');
  assert.equal(hooks.stripTrailingDecoration('Team \u{1F600}\u{1F600}'), 'Team');
  assert.equal(hooks.stripTrailingDecoration(''), '');
  assert.equal(hooks.stripTrailingDecoration(null), null);
});

test('sidebar identity resolving asynchronously removes a slider added while unresolved', (t) => {
  const { document, hooks } = setup(t);
  // Identity hasn't hydrated yet: no sidebar element exists, so
  // localUserName() is null and the card is indistinguishable from remote.
  const me = card(document, { name: 'Guest-482' });
  panelWith(document, [me]);
  hooks.dropCache();
  hooks.addSlider(me);
  assert.notEqual(me.querySelector('.ce-vol'), null, 'sanity: slider was added while identity was unknown');

  // Hydration completes and the sidebar label appears (with its status).
  sidebarIdentity(document, { name: 'Guest-482', status: '\u{1F411} Just sheeping around' });
  hooks.dropCache();
  hooks.addSlider(me); // what the per-frame scan() does on every pass

  assert.equal(me.querySelector('.ce-vol'), null, 'slider must be removed once identity resolves to local');
  assert.equal(me.classList.contains('ce-card'), false);
});

test('forward-looking: an explicit data-local marker is trusted immediately if Chatto ever adds one', (t) => {
  const { document, hooks } = setup(t);
  const me = card(document, { name: 'Guest-482', local: true });
  const remote = card(document, { name: 'Bob' });
  panelWith(document, [me, remote]);

  hooks.dropCache();
  hooks.addSlider(me);
  hooks.addSlider(remote);

  assert.equal(me.querySelector('.ce-vol'), null);
  assert.notEqual(remote.querySelector('.ce-vol'), null);
});

test('forward-looking: duplicate display names are disambiguated by a stable participant id, if present', (t) => {
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

test('known limitation: duplicate names with no marker/id/sidebar mismatch fall back to name matching', (t) => {
  const { document, hooks } = setup(t);
  sidebarIdentity(document, { name: 'Sam' });
  const me = card(document, { name: 'Sam' });      // matches live shape: no marker, no id
  const remote = card(document, { name: 'Sam' });  // same display name, also no id
  panelWith(document, [me, remote]);

  hooks.dropCache();
  hooks.addSlider(me);
  hooks.addSlider(remote);

  assert.equal(me.querySelector('.ce-vol'), null);
  // Documented residual limitation (see SECURITY-REVIEW.md): without any id
  // or marker on either card, name-based fallback cannot distinguish the
  // remote participant from the local one and also suppresses its slider.
  assert.equal(remote.querySelector('.ce-vol'), null);
});

test('local card recreated across a re-render stays free of a slider', (t) => {
  const { document, hooks } = setup(t);
  sidebarIdentity(document, { name: 'Guest-482', status: '\u{1F411} Just sheeping around' });
  const panel = panelWith(document, []);
  let me = card(document, { name: 'Guest-482' });
  panel.appendChild(me);
  hooks.dropCache();
  hooks.addSlider(me);
  assert.equal(me.querySelector('.ce-vol'), null);

  panel.removeChild(me);
  me = card(document, { name: 'Guest-482' }); // brand-new element, same identity
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
