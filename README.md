# Chatto Enhancer

<img src="chatto-enhancer.png" alt="Chatto Enhancer icon" width="128">

A browser extension that adds quality-of-life features to Chatto.

This is an unofficial, community-made extension built for [Chatto](https://github.com/chattocorp/chatto). It is not affiliated with the Chatto project or ChattoCorp.

For other community Chatto projects, see [awesome-chatto](https://github.com/nickk-/awesome-chatto), a list maintained by [nickk](https://github.com/nickk-).

## Features

- 🔊 Per-participant volume controls, with reset-all
- 😀 Emoji picker with recent emojis and `Ctrl+Shift+E`
- ✍️ Markdown formatting toolbar
- 🎞️ GIF picker with Giphy search and favorites
- 🖼️ Screen-share pop-out using Picture-in-Picture
- 🏷️ Local nicknames, visible only to you
- 🌍 "Enable here" for self-hosted Chatto servers
- ⚙️ Settings popup with feature toggles and data import/export
- 🌐 Chromium and Firefox support

## Screenshots

![Volume Controls](docs/images/volume-controls.png)

![Emoji Picker](docs/images/emoji-picker.png)

![GIF Picker](docs/images/gif-picker.png)

![Markdown Toolbar](docs/images/markdown-toolbar.png)

## Privacy

- No telemetry
- No analytics
- No tracking
- No remote scripts
- GIF search contacts Giphy only when you use the GIF picker
- Preferences, nicknames, favorite GIFs, recent emojis, and volume levels are stored locally
- Extra Chatto servers require explicit approval for that one site

## Settings

Click the extension icon to open settings. You can turn each feature on or off and export/import your local data. Reload the Chatto tab after changing settings.

## Using it on another Chatto server

The extension activates automatically on `chat.chatto.run`.

For another Chatto server, open that site, click the extension icon, then click "Enable here". Your browser will ask you to approve access for that one site. After approval, the extension loads there automatically.

## Installation

### Chromium

1. Download `chatto-enhancer-1.1-chromium.zip`.
2. Extract the ZIP.
3. Open `chrome://extensions`.
4. Enable Developer Mode.
5. Click Load unpacked.
6. Select the extracted folder.

To update, extract the new ZIP over the same folder, then click the reload icon on the extension card in `chrome://extensions`. Do not remove and re-add the extension unless you want to delete its local data.

### Firefox

1. Download `chatto-enhancer-1.1-firefox.zip`.
2. Extract the ZIP.
3. Open `about:debugging`.
4. Select "This Firefox".
5. Click "Load Temporary Add-on".
6. Select `manifest.json` from the extracted folder.

Temporary add-ons are removed whenever Firefox is closed or restarted.

## License

MIT. See [LICENSE](LICENSE).
