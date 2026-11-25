# Chatto Enhancer

<img src="chatto-enhancer.png" alt="Chatto Enhancer icon" width="128">

A private, local-first browser extension that adds personal productivity features to Chatto.

This is an unofficial community extension for [Chatto](https://github.com/chattocorp/chatto). It is not affiliated with ChattoCorp.

Version 1.3 targets **Chatto 0.6.0-beta.8**. Features that Chatto now provides natively—emoji, formatting, themes, participant volume controls, and call picture-in-picture—have been removed from the extension.

## Features

- 🔖 Private saved messages with search and jump-to-message links
- 📝 Reusable message templates with a native composer button
- 🎞️ Giphy search, recent GIFs, favorites, and custom collections
- 🏷️ Local nicknames, private user notes, and tags
- ⚙️ Native-style settings in Chatto's top bar
- 🔀 Independent feature switches that apply immediately
- 📦 Import/export for the complete Personal Library
- 🌍 Explicit per-site activation for self-hosted Chatto servers
- 🌐 Chromium and Firefox packages

## Privacy

- No telemetry, analytics, or tracking
- No remote executable code
- Saved messages, templates, local profiles, settings, and GIF metadata stay in extension-local storage
- GIF search sends the search query to Giphy only when the picker is used
- Self-hosted Chatto servers require explicit approval for that origin

## Settings

Click the Chatto Enhancer mascot in Chatto's top bar. The panel contains:

- **Settings** — feature switches
- **Saved** — private message bookmarks
- **Templates** — create and manage reusable messages
- **GIFs** — manage recent GIFs, favorites, and collections

The browser toolbar popup remains available for site permission and data import/export.

## Using It On Another Chatto Server

The extension activates automatically on `chat.chatto.run`.

For another server, open its Chatto page, click the browser extension icon, and choose **Enable here**. The browser asks for access to that origin only.

## Installation

### Chromium

1. Download `chatto-enhancer-1.3.0-chromium.zip` from the release.
2. Extract the ZIP.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted directory.

To update without deleting local data, extract the new package over the previous directory and click **Reload** on the extension card.

### Firefox

1. Download `chatto-enhancer-1.3.0-firefox.zip` from the release.
2. Extract the ZIP.
3. Open `about:debugging` and select **This Firefox**.
4. Click **Load Temporary Add-on**.
5. Select `manifest.json` from the extracted directory.

## Development

Node.js 20 or newer is required.

```sh
npm run check
npm test
npm run build
npm run package
```

Set `GIPHY_API_KEY` when building release packages to enable GIF search. The key is injected only into generated, gitignored artifacts.

## License

MIT. See [LICENSE](LICENSE).
