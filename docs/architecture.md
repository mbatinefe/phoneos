# Architecture — what does what

phoneos is a device driver for iPhones with three front-ends: an agent
interface (MCP + CLI), a scheduler for recurring pack tasks, and a dashboard.

```
  Claude Code / any MCP client ──stdio──▶ mcp-server ─┐
  terminal ───────────────────────────▶ phone CLI   ─┤        ┌── browser ──▶ web (Fastify + HTMX) :3000
  worker ──── pack tasks ─────────────────────────────┤        │
                                                      ▼        ▼
                                          ┌─────────────────────────────┐
                                          │ agent-interface / tools      │  observe · tap · swipe · type · open_app · macros
                                          │   observe/  ── snapshot      │  a11y tree → element list, screenshot → points
                                          │   humanize/ ── gestures      │  off-centre taps, Bézier swipes, pacing, seeds
                                          │   device/   ── DeviceDriver  │  one WdaClient per phone (+ identity, unlock)
                                          └──────────────┬──────────────┘
                                                         │ http 127.0.0.1:81xx (+ :91xx MJPEG)
                                          ┌──────────────┴──────────────┐
                                          │ wda-service                  │  xcodebuild test-without-building per device,
                                          │  (src/devices/wda/start.ts)  │  usbmux port forwarding, backoff, lock file
                                          └──────────────┬──────────────┘
                                                         │ USB (usbmuxd)  or  Simulator (shared loopback)
                                                      iPhone(s)
```

## Processes

| Process | Entry | Role |
|---|---|---|
| `wda-service` | `src/devices/wda-service.ts` | Keeps one WebDriverAgent per active device in `devices.json` running: builds nothing, launches the pre-built runner with `xcodebuild test-without-building`, forwards the phone's :8100/:9100 to local ports over usbmux (simulators need no forwarding), restarts with backoff. Reports per-device state over a Unix socket (`.wda/wda-service.sock`). |
| `mcp` | `src/agent-interface/mcp-server.ts` | MCP server on stdio. `.mcp.json` lets Claude Code discover it. Tools map 1:1 onto `AgentTools`. |
| `phone` | `bin/phone.js` → `src/agent-interface/cli.ts` | Same tools from a shell; also `doctor`, `demo`, `register`, `register-sim`, `sim-create`, `passcode` and `mcp`. |
| `web` | `src/api/server.ts` | Dashboard + JSON API: device registration wizard, live MJPEG screen with humanised manual control, schedules. |
| `worker` | `src/scheduler/worker.ts` | Runs due scheduled tasks (pg-boss, one queue per device). Each execution gets a `DeviceDriver` seeded by its id, so a run replays exactly. |

## Layers

- **`src/device/`** — `WdaClient` (typed HTTP client; sessionless routes, and a bare session, the running one joined, for `/wda/keys`, `/url`, `/wda/apps/*`), `DeviceDriver` (state / observe / act, every gesture through the humanizer), `DeviceFleet` (udid → driver from `devices.json`), `identity.ts` (ProductType → model name), `unlock.ts` (passcode via the SpringBoard tree, geometric fallback), `port-forward.ts`, `apps.ts` (installed apps via installation proxy / simctl; reinstall for `reset_app`), `media.ts` (Photos and app Documents), `recording.ts` (screen recording), `logs.ts` (app logs and crash reports), `simulator-controls.ts` (push, permissions, status bar).
- **`src/observe/`** — `tree.ts` flattens WDA's JSON element tree into visible, on-screen, meaningful elements with short ids; `diff.ts` keeps an element's id across observations and lists what changed; `marks.ts` draws ids onto screenshots; `a11y.ts` is the accessibility check; `render.ts` prints it all; `screenshot.ts` scales PNGs to points.
- **`src/humanize/`** — `Humanizer` with `precise` / `natural` / `relaxed` profiles and a seeded RNG: tap landing points inside the frame, Bézier swipe paths with ease-in/ease-out timing, log-normal pauses, typing bursts, optional idle nudges.
- **`src/agent-interface/`** — `AgentTools` (the behaviour), `mcp-server.ts`, `cli.ts`, `steps.ts` (`run_steps`), `report.ts` (run reports), `demo.ts`. Every action is appended to `.phoneos/sessions/<session>.jsonl`.
- **`apps/<pack>/`** — app packs (`pack.ts` exporting a `PhoneosPlugin` with `bundleId`, `GUIDE.md`, `macros`, tasks, checks, routes). Loaded automatically by `src/apps/loader.ts`.
- **`src/devices/`** — registry (`devices.json`), discovery (USB + booted simulators), registration wizard, wda-service, WDA build/launch scripts, `doctor.ts`, `simulators.ts`.
- **`src/scheduler/`, `src/database/`, `src/api/`** — scheduling, Postgres schema, dashboard/API.

## Observation format

```
state: unlocked · app=com.apple.Preferences "Settings" · 393×852pt @3x portrait · keyboard=no · alert=no
elements (31):
[e4]  Switch      "Airplane Mode" value="0" @ 340,214  51×31 (Table > Cell)
```

Coordinates are points. An element keeps its id across observations while it stays
on screen (a uniquely labelled one also when it only moved); what is new gets a new
id, and `observe changes=true` lists only what is new, changed or gone. When the
tree is empty or cannot be read (animation-heavy or custom-drawn apps, and a phone's
home screen, whose tree is not asked for), the screenshot comes instead and the agent
reads it. After a timeout the phone's agent goes on walking the tree and holds every
request behind it, so that screenshot is a frame of its video stream, which is served
apart from the request queue.

## Data & state

| Store | Contents |
|---|---|
| `devices.json` | Registered devices: `udid`, `name`, `kind`, model/iOS, ports, `humanProfile`, `passcode`, per-device `coordinates` overrides, `disabled`, `pluginData`. Git-ignored, `0600`. |
| `.env` | Host configuration (ports, database, signing). Never passcodes. |
| `.wda/` | wda-service socket + lock, per-device supervisor locks, `<udid>.log` (that device's xcodebuild/WDA output), `derived-data/` (the built WebDriverAgent runner). |
| `.phoneos/` (or `PHONEOS_STATE_DIR`) | `sessions/`: agent action logs (JSONL) and the last observation per device. `pulled/`, `recordings/`, `crashes/`: files copied off phones. `reports/`: run reports, one folder each with its steps, screenshots and `report.html`. `last-action-<udid>.json`: what each phone last did. |
| PostgreSQL `scheduler.*` / `pgboss.*` | Schedules, executions, attempts, logs, assets; job queue. |
| `.scheduler-data/` | Uploaded media for pack tasks. |

## WebDriverAgent

The source is the `appium-webdriveragent` 8.9.1 release: `wda:prepare` downloads
its tarball from the npm registry into `.wda/webdriveragent-8.9.1`, refuses it unless
it matches the pinned sha512 (only the Xcode sources are used, so the package's
own dependencies are never installed), applies the two patches in `Patches/` (absolute-coordinate touch paths + Photos import
routes, sessionless hardware buttons) and builds the runner into
`.wda/derived-data` — signed with your team for devices, unsigned for
simulators. WDA's own JSON tree (`/source?format=json`) and `/wda/screen` are
what make the driver model-agnostic.
