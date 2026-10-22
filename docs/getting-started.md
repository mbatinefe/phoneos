# Getting started

Two paths: a **simulator** (no Apple team, no cable — the fastest way to see an
agent drive a phone) or a **real iPhone**.

## Requirements

| Requirement | Notes |
|---|---|
| macOS + full Xcode | `xcode-select -p` must point at Xcode.app, not the Command Line Tools. |
| Node.js 22+ | TypeScript runs directly through `tsx`; no build step. |
| PostgreSQL 14+ | Only for the scheduler (`npm run db:up` starts one in Docker). The agent interface does not need it. |
| An Apple Developer team | Real devices only, for signing WebDriverAgent. A free Apple ID handles one device with weekly re-signing; a paid team is needed for a fleet. |

## Install

```sh
git clone <this-repo> phoneos && cd phoneos
npm install
cp .env.example .env
npm link          # optional: puts the `phone` command on your PATH
```

Without `npm link`, write `npm run phone -- <command>` wherever these docs say `phone <command>`.
File paths you give `phone` are relative to the folder you run it from.

## A. Simulator in one command

`npm run demo` does everything below and ends by reading the Settings screen. By hand:

```sh
npm run phone -- sim-create                   # creates + boots the newest iPhone Pro
npm run phone -- register-sim                 # writes it to devices.json
npm run wda:prepare -- --sim                  # patches + builds WebDriverAgent (unsigned), a few minutes once
npm run wda:service                           # keeps WDA running on it (leave this running)
npm run phone -- observe --screenshot shot.jpg
```

Then in Claude Code (this repo has a `.mcp.json`): "observe the phone", "open
Settings and turn on Airplane Mode", … The agent follows `AGENTS.md`.

## B. Real iPhone

1. **Xcode & pairing** (once per Mac): install the full Xcode, open it, accept the
   licence (`sudo xcodebuild -license accept`), add your Apple ID under Settings →
   Accounts and note the **Team ID**. Connect the iPhone, tap **Trust This
   Computer**, enable **Developer Mode** (Settings → Privacy & Security), and wait
   until Xcode → Window → Devices shows it as *Connected*.
2. **Configure `.env`**: `XCODE_ORG_ID` (Team ID), `WDA_BUNDLE_ID` (a bundle id you
   control), `IOS_PLATFORM_VERSION` (the phone's iOS major.minor).
3. **Register from the dashboard**: `npm run web` → http://127.0.0.1:3000/devices/register.
   The wizard checks host tooling, USB pairing, signing, Developer Mode, builds and
   starts WDA, verifies video + touch, then runs each app pack's own checks, which are advisory: they say what a
   pack needs and never hold up registration. Enter the unlock passcode there — it is stored only
   in `devices.json`.
4. `npm run wda:service` must be running for anything to talk to the phone.

`wda:prepare` signs with the certificate in your **login keychain**, so run it from a
graphical session (Terminal.app), not a bare SSH shell.

## Driving a phone

- **From Claude Code / any MCP client**: `.mcp.json` starts `npm run mcp`. Tools: `list_devices`, `observe`, `tap`, `swipe`, `scroll`, `type_text`, `open_app`, … plus pack macros such as `settings_open`. Read `AGENTS.md`.
- **From a shell**: `npm run phone -- devices`, `npm run phone -- observe`, `npm run phone -- tap e7`, `npm run phone -- open Settings`, `npm run phone -- type "hello" --submit`. `-d <name|udid>` picks a device; `--precise` / `--relaxed` override the gesture profile. `phone --help` lists every command, including the set-up ones: `register` (a USB iPhone into `devices.json`), `passcode` (its unlock passcode, typed hidden), `keep-awake` (Auto-Lock → Never) and `macros` (the app-pack macros).
- **From the dashboard**: live screen with humanised tap/swipe, hardware buttons, unlock.

## Using it from other agents

Any MCP client that starts a local (stdio) server can drive the phones. Point it at
`node /absolute/path/to/phoneos/bin/phone.js mcp`, which works from any folder. After
`npm link`, the command is just `phone mcp`.

| Client | Where |
|---|---|
| Claude Code, in this repo | Nothing to do: `.mcp.json` is picked up. Elsewhere: `claude mcp add phoneos -- node /path/to/phoneos/bin/phone.js mcp` |
| Codex CLI / IDE | `codex mcp add phoneos -- node /path/to/phoneos/bin/phone.js mcp` (stored in `~/.codex/config.toml`) |
| Cursor | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json`: `{"mcpServers": {"phoneos": {"command": "node", "args": ["/path/to/phoneos/bin/phone.js", "mcp"]}}}` |
| OpenCode | `opencode.json`: `{"mcp": {"phoneos": {"type": "local", "command": ["node", "/path/to/phoneos/bin/phone.js", "mcp"]}}}` |
| Claude Desktop | `claude_desktop_config.json`: same `mcpServers` entry as Cursor |
| VS Code | `.vscode/mcp.json`: `{"servers": {"phoneos": {"type": "stdio", "command": "node", "args": ["/path/to/phoneos/bin/phone.js", "mcp"]}}}` |

Agents that run shell commands can also use the `phone` CLI directly; it mirrors every tool.
Services that only call remote MCP servers over HTTP (such as xAI's API) cannot reach
phoneos yet: it speaks stdio only.

## Sending files to a phone

- **Photos** (images, videos): `npm run phone -- photos-add ./a.jpg ./b.mp4` or the `add_to_photos` tool. Simulators go through `simctl addmedia`; real phones through the patched WDA route, which needs a one-time "Allow WebDriverAgentRunner to add to Photos" tap on the phone.
- **Documents** (anything else): `npm run phone -- file-add <app> ./report.pdf --dir reports` or `add_file`. The file lands in that app's Documents folder — visible under Files → On My iPhone → *App* — for apps that enable file sharing (`UIFileSharingEnabled`, e.g. your own app, VLC, Documents by Readdle). Over USB (house arrest/AFC) for real phones; direct copy for simulators. `phone files <app>` lists what is there.

Getting things back: `phone photos-get 5 -o ./pulled` (newest camera-roll items) and
`phone file-get <app> exports/report.pdf -o ./report.pdf`.

## More device controls

- **Wait for the UI**: `phone wait-for "Done" --timeout 30000`, `phone wait-for "Loading" --gone`.
- **Screen recording** (iOS 17+): `phone record-start` … `phone record-stop -o run.mov`.
- **Clipboard**: `phone clipboard "long text"`, `phone clipboard --image ./pic.png`, `phone clipboard` (read).
- **Appearance / rotation / zoom**: `phone appearance dark`, `phone rotate landscape`, `phone pinch 2`.
- **Apps**: `phone app-install ./MyApp.app` (simulator or devicectl) / `./MyApp.ipa` (phone, signed for it), `phone app-uninstall com.example.myapp`.
- **Fleet health**: `phone fleet` (or `fleet_status`, `GET /api/fleet/health`) — battery, thermal, storage, WDA state, last action, warnings per phone.

## Scheduling pack tasks

```sh
npm run db:up && npm run db:migrate
npm run worker
```

The dashboard's **Tasks** page runs a pack task (the Settings pack's `about`, which logs
the iOS version and free storage) now, once, daily or weekly. A task that needs files
is created through its pack's own API. A device page's **Activity** tab and
`GET /api/executions/:id` show the logs.

## Devices and secrets

`devices.json` (git-ignored, `0600`):

```json
[
  {
    "name": "Phone A",
    "udid": "00008030-000000000000000E",
    "modelName": "iPhone 14 Pro",
    "osVersion": "17.5",
    "wdaLocalPort": 8100,
    "mjpegLocalPort": 9100,
    "humanProfile": "natural",
    "passcode": "123456",
    "coordinates": { "like": { "x": 355, "y": 420 } },
    "pluginData": {}
  }
]
```

- `humanProfile`: `precise` | `natural` | `relaxed` — how gestures are humanised.
- `coordinates`: optional per-device named-point overrides that app packs consult (set with `PATCH /api/devices/:udid {"coordinates": …}`).
- `passcode`: never returned by the API (`hasPasscode` is). Set it in the wizard, `PATCH /api/devices/:udid {"passcode":"…"}`, or by editing the file.
- `disabled: true` keeps the entry but stops supervising it.

## Troubleshooting

Start with `npm run doctor`. It checks Node, Xcode, the WebDriverAgent build, the
service and every registered device, and prints the command that fixes each problem.

| Symptom | Check |
|---|---|
| `list_devices` says "WDA not ready" | Is `npm run wda:service` running? `cat .wda/wda-service.log`. |
| `observe` says "the tree is unavailable (timeout)" | Expected on animation-heavy apps (feeds, games, some shopping and travel apps). The screenshot comes instead: tap by coordinates read off it, or use the pack's macros. The phone's agent finishes the walk it started first, so the next action can wait up to a minute. |
| `Device is still locked after entering the passcode` | Wrong passcode in `devices.json`, or the keypad wasn't readable. Unlock by hand once, check the passcode, retry. |
| `wda: error … stale or corrupted` | `npm run wda:prepare` again; delete `.wda/derived-data` if it keeps producing an empty `.app`. |
| Simulator: WDA never becomes ready | `xcrun simctl list devices booted` — is it booted? Re-run `wda:prepare -- --sim` after an Xcode update. |
