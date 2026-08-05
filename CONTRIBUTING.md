# Contributing

## Development

Use Node.js 20 or newer.

```sh
npm run check
npm run build
npm run package
```

Do not add runtime dependencies. Development dependencies should be proposed only when a dependency-free approach is not practical.

## Security Rules

- Do not add telemetry, analytics, tracking, or remote executable code.
- Do not broaden permissions or host matches without a documented reason.
- Do not commit secrets, browser profiles, cookies, tokens, `.env` files, or local private paths.
- Build output in `dist/` and `artifacts/` is generated and should not be committed by default.

## Pull Requests

Keep changes scoped. Include:

- what changed
- why it changed
- checks run
- browser/manual testing performed, if any

Manual browser testing should be clearly distinguished from automated validation.
