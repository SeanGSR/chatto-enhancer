# Security Review

## Confirmed Issues Fixed

- Page bridge messages now use a per-page token, strict type allowlists, origin/source checks, JSON size limits, and payload schema validation.
- Markdown link insertion now permits only `https:`, `http:`, and `mailto:` URLs and rejects unsafe or obfuscated schemes.
- Storage reads now validate volume and recent emoji values before use.
- Prototype-sensitive stored volume data is copied into `Object.create(null)`.
- Debug logging no longer reads composer `innerHTML`.

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

## Automated Validation Performed

Automated validation should include:

- `npm run check`
- `npm run build`
- `npm run package`

This environment does not currently provide Node.js or npm, so those npm commands must be run in a Node.js 20+ environment or CI before release.

## Manual Browser Testing Still Required

- Load unpacked build in Chromium.
- Load temporary add-on in Firefox.
- Verify volume controls, emoji picker, recent emoji storage, markdown formatting, URL validation, page reload behavior, extension reload behavior, malformed storage handling, and console errors.
