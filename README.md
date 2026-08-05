# Chatto Enhancer

A browser extension that adds quality-of-life features to Chatto.

## Features

- 🔊 Individual participant volume controls
- 😀 Emoji picker with recent emojis
- ✍️ Markdown formatting toolbar
- ⚡ Lightweight and fast
- 🌐 Chromium and Firefox support

## Screenshots

![Volume Controls](docs/images/volume-controls.png)

![Emoji Picker](docs/images/emoji-picker.png)

![Markdown Toolbar](docs/images/markdown-toolbar.png)

## Privacy

- No telemetry
- No analytics
- No tracking
- No remote scripts
- No runtime network requests
- Preferences are stored locally using the browser storage API

## Supported Servers

Chatto Enhancer is designed for Chatto.

Chatto is self-hosted, so the extension can be configured to work with any Chatto installation by updating the extension's host permissions before building.

## Installation

### Chromium

1. Download the latest release.
2. Extract the ZIP.
3. Open `chrome://extensions`
4. Enable Developer Mode.
5. Load unpacked.
6. Select the extracted folder.

### Firefox

1. Download the Firefox build.
2. Open `about:debugging`.
3. Select This Firefox.
4. Load Temporary Add-on.
5. Select `manifest.json`.

## Development

```bash
npm run check
npm run build
npm run package
```

## License

MIT. See [LICENSE](LICENSE).
