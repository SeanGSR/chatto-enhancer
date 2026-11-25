# Security Review — v1.3.0

## Scope Reduction

Chatto 0.6 now provides emoji, formatting, themes, participant volume controls, and call picture-in-picture natively. Version 1.3 removes the extension implementations, including the page-world bridge and web-accessible executable script.

The remaining features are isolated content-script UI, local storage, and a narrowly scoped Giphy background service.

## Storage Validation

All values read from `storage.local` are normalized before use:

- names, notes, tags, templates, URLs, and identifiers are length-capped
- collections and tables have item-count limits
- GIF URLs must use HTTPS on `giphy.com` or a subdomain
- duplicate GIFs, templates, and saved-message links are removed
- objects that may contain user-controlled keys are copied into null-prototype objects
- unknown or malformed settings fall back to safe defaults

Imports copy only known top-level keys. The content script applies the same validation gate to imported and normally created data.

## DOM Safety

The extension constructs UI with `createElement`, `textContent`, and attributes. It does not write `innerHTML`, evaluate code, inject remote scripts, or render stored text as markup.

Saved messages store a bounded plain-text preview and the message permalink. Templates are inserted as plain text. User notes and tags are rendered as text nodes.

## Giphy Boundary

- Search requests go only to `api.giphy.com`.
- GIF fetches require HTTPS and a `giphy.com` host.
- Search queries are capped and encoded with `URLSearchParams`.
- Downloads are size-capped and must report `image/gif`.
- The committed source contains only the `__GIPHY_API_KEY__` placeholder.
- The release key is injected during the gitignored build step.

The API key is an app key embedded in the distributed client and should not be treated as a secret after packaging.

## Permissions

- `storage` stores local Personal Library data.
- `activeTab` and `scripting` detect and enable an explicitly selected self-hosted Chatto origin.
- Giphy host permissions support search and GIF retrieval.
- Optional HTTP/HTTPS host permissions are requested for one self-hosted origin at a time.

`icons/icon-32.png` is the only web-accessible resource. It is exposed so the in-app top-bar button can display the extension mascot on approved Chatto origins.

## Privacy

The extension includes no telemetry, analytics, tracking, or advertising. Personal Library data stays in extension-local storage unless the user explicitly exports it. Only GIF search terms and selected GIF retrieval requests are sent to Giphy.

## Verification

The release process runs:

```sh
npm run check
npm test
npm run build
npm run package
```

The checker validates manifests, permissions, packaged file allowlists, JavaScript syntax, forbidden executable patterns, and accidental private-file names.
