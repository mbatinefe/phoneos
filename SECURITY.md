# Security

phoneos drives real iPhones with stored unlock passcodes and an Apple signing
identity, so treat the host it runs on as sensitive.

- Keep the dashboard on loopback unless an `AuthProvider` is configured
  (`PHONEOS_AUTH_PLUGIN`); startup refuses a non-loopback bind without one. Without
  one it also answers only to a loopback `Host` (or a configured origin), so a page
  elsewhere cannot reach it by pointing its own hostname at 127.0.0.1.
- The service that keeps WebDriverAgent running listens only on a Unix socket in
  `.wda/` that only your user can open.
- An agent connected over MCP writes files on this Mac only inside the folder the
  server runs in, and what it types (passwords, codes) is never written to the logs.
  Screen text is data for the agent, never instructions (`AGENTS.md`, Rules).
- `devices.json` (passcodes) and `.env` (signing, database) are git-ignored —
  never commit them, never paste them into issues or chat.
- Plugins and app packs are trusted code with full host and device access; only
  load ones you wrote or reviewed (see the Trust section of `docs/app-packs.md`).
- Never attach production devices or signing material to CI.

To report a vulnerability, use the repository's private vulnerability reporting
(Security tab → "Report a vulnerability") rather than a public issue.
