# Chatto Enhancer

A browser extension that adds quality-of-life features to Chatto.

This is an unofficial, community-made extension built for [Chatto](https://github.com/chattocorp/chatto). It is not affiliated with the Chatto project or ChattoCorp.

## Features

- 🔊 Individual participant volume controls, with a perceptual (not linear) curve so the middle of the slider actually sounds like "half as loud", plus a one-click button to reset everyone back to 100%
- 😀 Emoji picker with recent emojis — toggle it from any composer with `Ctrl+Shift+E`
- ✍️ Markdown formatting toolbar, docked above the message box
- 🎞️ GIF picker (Giphy search) with favorites
- 🖼️ Screen-share pop-out button — pops a shared screen into its own floating (Picture-in-Picture) window
- 🏷️ Local nicknames — rename anyone for yourself only, purely visual, never touches their real name or anyone else's view
- 🌍 One-click "Enable here" for any self-hosted Chatto instance, not just the domains this extension ships with
- ⚙️ Settings popup to turn any feature off if you don't want it, plus export/import of your data
- ⚡ Lightweight and fast
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
- The GIF picker sends search queries and fetches images from Giphy (`api.giphy.com`) when you use it — no other runtime network requests are made
- Preferences, nicknames, and favorited GIFs are stored locally using the browser storage API
- The extension ships with access to nothing beyond Chatto's own known domains and Giphy — it never requests broad access to every site you visit. Enabling it on another domain (see below) always requires you to explicitly approve that one specific site

## Settings

Click the extension's icon in your browser toolbar to open its settings popup. Each feature (volume sliders, emoji picker, GIF picker, markdown toolbar, screen-share pop-out, local nicknames) can be turned off independently. A feature that's off never builds its UI and never runs its background work — for example, turning off the GIF picker means no requests to Giphy are ever made. Reload Chatto's tab after changing a setting for it to take effect.

## Using it on another Chatto server

The extension only activates automatically on the domains it was built for. If you run your own Chatto instance elsewhere, open its tab, click the extension's icon, and — if it's confirmed as a Chatto server — click "Enable here". Your browser will ask you to confirm access to that one site; after you approve it, the extension activates on that domain automatically from then on, the same as it does on the domains it ships with. It never requests broad access to every site up front.

## Installation

### Chromium

1. Download the latest release.
2. Extract the ZIP.
3. Open `chrome://extensions`
4. Enable Developer Mode.
5. Click Load unpacked.
6. Select the extracted folder.

**Updating to a newer version:** extract the new ZIP over the same folder (overwrite the files in place), then click the reload icon on the extension's card in `chrome://extensions`. Do **not** click Remove and load it again from scratch — removing an extension deletes its locally stored data, including saved volume levels, recent emoji, GIF favorites, and nicknames. Reloading in place keeps that data; removing and re-adding does not.

### Firefox (Development)

1. Open `about:debugging`
2. Select "This Firefox"
3. Click "Load Temporary Add-on"
4. Select `manifest.json`

Temporary add-ons are removed whenever Firefox is closed or restarted.

### Firefox (Permanent installation)

Permanent installation requires a signed extension.

Once Chatto Enhancer is published on Mozilla Add-ons (AMO), users will be able to install it permanently with normal Firefox updates.

Until then, use the temporary installation above for testing.

## License

MIT. See [LICENSE](LICENSE).
