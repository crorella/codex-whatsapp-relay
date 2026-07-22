# Agent Notes

This is a security-reduced fork of `abuiles/codex-whatsapp-relay`.

- Keep the plugin limited to QR authentication, chat metadata lookup, and text sending.
- Do not add phone-to-Codex control, background daemons, message-history reading,
  media downloads, voice execution, or persisted message bodies.
- Keep URL previews disabled with `linkPreview: null` on every send path.
- Pin direct dependencies exactly, commit `package-lock.json`, and install with
  `npm ci --ignore-scripts`.
- Keep authentication state at mode `0600` inside directories at mode `0700`.
- Run `npm run check`, `npm test`, and `npm audit --package-lock-only --ignore-scripts`
  before publishing changes.
