# Security Review

## Confirmed Issues Fixed

- Page bridge messages now use a per-page token, strict type allowlists, origin/source checks, JSON size limits, and payload schema validation.
- Markdown link insertion now permits only `https:`, `http:`, and `mailto:` URLs and rejects unsafe or obfuscated schemes.
- Storage reads now validate volume and recent emoji values before use.
- Prototype-sensitive stored volume data is copied into `Object.create(null)`.
- Debug logging no longer reads composer `innerHTML`.
- The local participant no longer receives a volume slider. Detection (`isLocalCard()` in `src/content/index.js`) checks, in order of trust: (1) an explicit `data-local="true"` / `data-local-participant="true"` marker on the card itself; (2) if that marker is on a different card than the one being checked, a stable `data-call-participant-id` / `data-participant-id` / `data-participant-identity` shared between the marker and the card; (3) as a last resort, display-name equality against the resolved local username (`localUserName()`). Every animation-frame scan re-runs this check per card (`addSlider()` removes any slider a card already has as soon as it's recognized as local), so a card that starts as an unmarked "Loading" placeholder, gets a slider by mistake, and is later marked local has that slider removed rather than left in place. This also covers cards recreated across reconnects/navigation, since detection is attribute- and id-based rather than tied to a specific DOM node.

## Defense-In-Depth Improvements

- Chromium and Firefox manifests are generated from a shared source and keep browser-specific keys separated.
- Build checks scan extension sources for dangerous executable patterns and remote script URLs.
- Release packages include only the expected extension files.
- Lifecycle cleanup disconnects the main content observer and clears extension-owned intervals/timers on page unload where practical.

## Unconfirmed Concerns

- Chatto DOM selectors are fragile by nature because the extension augments a third-party page.
- Voice participant matching depends on LiveKit and Chatto behavior observed by the current implementation.
- Browser behavior has not been manually verified in this environment.

## Residual Risks

- Same-origin page scripts are not a trust boundary. A hostile Chatto page script can interact with page-world objects and observe bridge messages. The bridge is designed to keep forged messages bounded and non-privileged, but it cannot make the page world private.
- `main-world.js` remains web-accessible because it is required for fallback page-world injection in browsers that do not honor `world: "MAIN"` consistently.
- The extension stores settings by participant display name, which can collide if multiple participants share the same name.
- Local-user detection falls back to display-name matching when Chatto exposes neither a `data-local`/`data-local-participant` marker nor a stable participant id on a given card. In that fallback case, a remote participant who happens to share the local user's exact display name will also be denied a slider (verified in `test/local-card-detection.test.mjs`, "known limitation" case). This is a false negative for that one remote card, not a privacy or correctness issue for the local user, and is resolved automatically whenever Chatto supplies either signal.
- Chatto's LiveKit integration never attaches inbound audio `<audio>` elements to the document (`track.attach()` is called with no argument), so there is no DOM media element to key slider association off of directly; volume routing instead goes through the existing `main-world.js` bridge and participant-to-stream mapping, which is unrelated to local-user detection.

## Automated Validation Performed

Automated validation should include:

- `npm run test` (dependency-free `node --test` suite in `test/`, including `test/local-card-detection.test.mjs` for the local-participant volume-slider fix)
- `npm run check`
- `npm run build`
- `npm run package`

All four were run against Node.js 24.18.0 as part of the local-participant volume-slider fix and passed.

## Manual Browser Testing Still Required

- Load unpacked build in Chromium.
- Load temporary add-on in Firefox.
- Verify volume controls, emoji picker, recent emoji storage, markdown formatting, URL validation, page reload behavior, extension reload behavior, malformed storage handling, and console errors.
- Local-participant slider fix, in both Chromium and Firefox:
  - The local user's own card never shows a volume slider, including immediately after joining while the card still reads "Loading".
  - Every remote participant still gets a slider, and it controls only that participant's audio.
  - Remote volume settings persist across reloads; leaving and rejoining the call does not duplicate sliders on any card.
  - Renaming the local user, or a delayed identity resolution, never leaves a slider exposed on the local card.
  - Two participants with the same display name are each handled correctly when Chatto exposes a stable participant id for both.
