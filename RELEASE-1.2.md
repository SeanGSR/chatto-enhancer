# Chatto Enhancer v1.2

Feature and maintenance update for **Chatto Enhancer**, focused on themes, Firefox packaging, and more reliable local user handling.

## New Features

- 🎨 Theme selector with dark and light variants
- 🖤 OLED Dark and OLED Light themes
- ☕ Cappuccino, Midnight, Forest, Rose, Lilac, and Turquoise themes
- ✏️ Custom theme colors from the settings popup
- 🔁 Theme changes apply to open Chatto tabs automatically

## Bug Fixes

- Firefox package now uses `background.scripts` instead of `background.service_worker`
- Firefox manifest keeps Gecko and Gecko Android settings
- Volume and nickname data now prefer stable user IDs when Chatto exposes them
- Own user is excluded from volume controls when a stable local ID is available
- Theme styling now covers extension controls, scrollbars, and the markdown toolbar more consistently
- The settings popup no longer shows "Enable here" on `chat.chatto.run`, where the extension is enabled by default

## Installation

Download the appropriate package below:

- **Chromium** — `chatto-enhancer-1.2-chromium.zip`
- **Firefox** — `chatto-enhancer-1.2-firefox.zip`

See the project README for installation instructions and supported browsers.
