# Security Review

## Confirmed Issues Fixed

- Page bridge messages now use a per-page token, strict type allowlists, origin/source checks, JSON size limits, and payload schema validation.
- Markdown link insertion now permits only `https:`, `http:`, and `mailto:` URLs and rejects unsafe or obfuscated schemes.
- Storage reads now validate volume and recent emoji values before use.
- Prototype-sensitive stored volume data is copied into `Object.create(null)`.
- Debug logging no longer reads composer `innerHTML`.
- The local participant no longer receives a volume slider. Detection (`isLocalCard()` in `src/content/index.js`) checks, in order of trust: (1) an explicit `data-local="true"` / `data-local-participant="true"` marker on the card itself; (2) if that marker is on a different card than the one being checked, a stable `data-call-participant-id` / `data-participant-id` / `data-participant-identity` shared between the marker and the card; (3) as a last resort, display-name equality against the resolved local username (`localUserName()`). Every animation-frame scan re-runs this check per card (`addSlider()` removes any slider a card already has as soon as it's recognized as local), so a card that starts unresolved, gets a slider by mistake, and is later confirmed local has that slider removed rather than left in place. This also covers cards recreated across reconnects/navigation, since detection is attribute- and id-based rather than tied to a specific DOM node.
- **Confirmed against a live call** that branches (1) and (2) above are currently dead code on at least one real Chatto deployment: no participant card carries `data-local`, `data-local-participant`, or any participant-id attribute. Detection therefore runs on branch (3) alone in practice.
- **Actual root cause of the first name-comparison fix still failing live:** `localUserName()` read the wrong DOM node, not a fundamentally decorated name. `[data-testid="current-user-identity-text"]` (the account panel shown at the bottom of the channel sidebar, reused for the in-call "you are" label) nests markup like `<span>` (name row) → `<span>{plain name}</span>` plus an optional sibling `<span title="{status}">` carrying a custom status emoji, one level deeper than the name. The original strategy read `el.firstElementChild.textContent`, which is the whole name-row span — so it concatenated the status emoji's text onto the name (observed live as `"Loading 🐑"` vs. the card's plain `"Loading"`). This was a real DOM-traversal bug, not a load-order race or an inherent decoration on the name itself.
- Fixed by adding a `testid-name-span` strategy to `localUserName()` that reads `el.firstElementChild.firstElementChild` — the innermost span holding only the plain name — ahead of the old (now demoted, kept as fallback) strategies. `isLocalCard()` also still applies `stripTrailingDecoration()` (strips a trailing run of whitespace/pictographic characters) as a second line of defense for the coarser fallback strategies or any future DOM shape Chatto ships. Covered by `test/local-card-detection.test.mjs`, which reproduces the exact nested-span/status-span structure rather than a flattened stand-in.

## New Feature: GIF Picker

- Adds a GIF button beside the emoji button that searches Giphy and, on pick, uploads the result as a real file rather than pasting its URL — a bare GIF link was confirmed (by hand) to sit static in Chatto rather than animate, while an uploaded `.gif` file plays normally.
- **API key handling:** Giphy issues one API key per *app*, not per end user (unlike Tenor, whose public developer program was found to be closed to new applicants as of Jan 2026 — the reason this feature targets Giphy rather than Tenor). Collecting a per-installer key was therefore never the right model here; the key is instead the maintainer's own, injected into `src/background.js` at build time from a `GIPHY_API_KEY` environment variable (see `scripts/build.mjs`). `src/background.js` as committed to the repository — what anyone browsing GitHub sees — contains only the literal placeholder `__GIPHY_API_KEY__`; the real key exists only in the gitignored `dist/` and `artifacts/` build output on the maintainer's machine. Building without the environment variable set produces a working extension with GIF search cleanly disabled (`no-key` error path), rather than failing the whole build.
- **This does not make the key un-extractable, and isn't meant to.** Anyone who installs the finished, built extension can still find the real key by inspecting their own local copy — that is an inherent property of any client-side app key, and is how Giphy expects its API to be embedded in client applications (its own rate limiting is designed around this). What the build-time injection actually achieves is narrower and specific: the key never appears in the git history or the public GitHub source, so it can't be found by browsing the repository, scraped by automated secret-scanning of the source, or reused by someone who never installed the extension at all.
- **Why a background service worker exists at all** (this extension previously had none): a content script's `fetch()` runs inside the page's own JavaScript realm and is bound by the page's CSP, which this extension does not control and should not need to work around. All Giphy requests (search and fetching the actual GIF bytes) are made from `src/background.js` instead, in the extension's own privileged context, scoped by the `https://api.giphy.com/*` and `https://*.giphy.com/*` entries newly added to `host_permissions`. This is the first host permission this extension has ever requested beyond Chatto's own origins, and the first time any user-generated content (the GIF search query) leaves the extension to a third party other than Chatto.
- **Fetch relay is domain-locked, not a general proxy:** `background.js`'s `gif-fetch` handler (`isSafeGiphyUrl()`) only fetches URLs whose scheme is `https:` and whose host ends in `.giphy.com` — the content script cannot use it to fetch arbitrary attacker-controlled URLs even if a hostile page script could somehow reach it (it cannot: `sendBg()` messages originate only from the extension's own picker UI, never from data the page controls).
- **Response validation:** fetched GIF bytes are capped at 15 MB and rejected unless the response's `Content-Type` is `image/gif`, before ever being handed to the content script or turned into a `File`.
- **Search query handling:** the query string is length-capped (200 chars) and passed to Giphy via `URLSearchParams` (proper encoding, no string concatenation into the request URL).
- **Favorites** are a new locally-stored preference (`gifFavorites` in `chrome.storage.local`, alongside the existing `volumes`/`recents` keys), validated on read the same way those already are: `cleanGifFavorites()` caps the list at 200 entries, dedupes by id, and — since favorited GIFs are rendered as `<img src>` directly from stored data without passing through `background.js`'s fetch relay the way inserting one does — `isGiphyMediaUrl()` restricts both `url` and `previewUrl` to `https://*.giphy.com` before they are ever used as an image source. An `<img src>` can't execute script even if this were bypassed, so this is defense-in-depth rather than a response to a demonstrated exploit path.

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
- Local-user detection falls back to display-name matching when Chatto exposes neither a `data-local`/`data-local-participant` marker nor a stable participant id on a given card — which, per the live evidence above, is true for every card on this Chatto build today. In that fallback case, a remote participant who happens to share the local user's exact display name (after stripping trailing decoration) will also be denied a slider (verified in `test/local-card-detection.test.mjs`, "known limitation" case). This is a false negative for that one remote card, not a privacy or correctness issue for the local user, and would be resolved automatically if Chatto ever supplies a marker or id.
- `localUserName()`'s primary strategy assumes the account-panel markup keeps its current two-level nesting (name row → name span, with any status as a separate sibling subtree). If Chatto restructures that markup, resolution falls back to the older, coarser strategies, which rely on `stripTrailingDecoration()` — itself limited to stripping a *trailing* run of pictographic characters, so a prefixed or embedded decoration, or a non-pictographic decoration character, could still cause a mismatch in that fallback path.
- Chatto's LiveKit integration never attaches inbound audio `<audio>` elements to the document (`track.attach()` is called with no argument), so there is no DOM media element to key slider association off of directly; volume routing instead goes through the existing `main-world.js` bridge and participant-to-stream mapping, which is unrelated to local-user detection.
- **Unverified: the GIF-as-upload mechanism.** A chosen GIF is inserted by dispatching a synthetic `paste` `ClipboardEvent` at the composer, carrying the fetched GIF as a `File` inside a `DataTransfer` — the same technique `writeText()` already uses (successfully, confirmed live) for text, just with a `File` instead of a text string. Whether Chatto's editor treats a pasted image the way most chat apps do (upload it as an attachment) has not been confirmed against the live app; if it doesn't, `insertGif()` warns to the console (`"pasting the GIF into the composer did not seem to work"`) rather than failing silently, but does not have a second fallback mechanism. This is the one part of the feature that needs live confirmation before it can be considered working.
- **Unverified: Firefox's `background.service_worker` support.** The manifest declares an MV3 `background.service_worker`, which Firefox supports from a fairly recent version (this project's `strict_min_version` is already past that point), but this has not been confirmed against a real Firefox install. If it does not register, GIF search fails entirely on Firefox (with no other feature affected, since the background script is not used for anything else).
- **Whoever runs `npm run build` for a real release controls the Giphy key**, and must set `GIPHY_API_KEY` in their own environment (see `.env.example`) rather than committing it anywhere. There is currently no automated check preventing a future contributor from accidentally hardcoding a real key into `src/background.js` in place of the placeholder — `scripts/check.mjs`'s forbidden-filename scan guards against committing a *file* that looks like a secret, but does not scan file *contents* for an API-key-shaped string.

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
  - The local user's own card never shows a volume slider, including immediately after joining while the card is still resolving its identity.
  - Every remote participant still gets a slider, and it controls only that participant's audio.
  - Remote volume settings persist across reloads; leaving and rejoining the call does not duplicate sliders on any card.
  - Renaming the local user, or a delayed identity resolution, never leaves a slider exposed on the local card.
  - Two participants with the same display name are each handled correctly when Chatto exposes a stable participant id for both.
- GIF picker, in both Chromium and Firefox (requires building with `GIPHY_API_KEY` set — see `.env.example`):
  - Background service worker registers and responds (check `chrome://extensions` / `about:debugging` for a running/errored service worker).
  - Opening the GIF picker loads trending GIFs immediately (no key-entry step for installers — the key is baked in at build time).
  - Picking a GIF actually uploads and animates in the sent message — the specific thing not yet confirmed live (see Residual Risks above). If it doesn't, check the console for the "did not seem to work" warning and inspect what Chatto's paste handler actually did with the synthetic event.
  - Searching, scrolling to load more results, and closing the picker (Escape, clicking away, clicking the GIF button again) all behave like the emoji picker does today.
  - Building with `GIPHY_API_KEY` unset shows "GIF search isn't configured for this build" in the picker rather than a stuck loading state or a crash.
  - Clicking a GIF's star favorites it without inserting it; the Favorites tab shows it, and it persists after closing/reopening the picker and reloading the page.
  - Un-favoriting from the Favorites tab removes that tile immediately rather than leaving a stale entry.
