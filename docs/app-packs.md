# App packs

An app pack teaches phoneos about one app: how it looks (for the agent), a
few deterministic flows (macros, exposed as tools), scheduled tasks, setup
checks and dashboard bits. `apps/settings/` is a small one for the built-in
Settings app, to copy from; your own app is the same shape.

```
apps/myapp/
  pack.ts       exports a PhoneosPlugin (default export)
  GUIDE.md      what the app looks like, screens, gotchas — the agent reads this when the app is in front
  …            anything else the pack needs
```

`src/apps/loader.ts` imports every `apps/*/pack.ts` automatically; external
packages listed in `PHONEOS_PLUGINS` load the same way.

## pack.ts

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { PhoneosPlugin } from 'phoneos';

const here = path.dirname(fileURLToPath(import.meta.url));

const pack: PhoneosPlugin = {
    id: 'com.example.myapp',          // lowercase, dots/hyphens
    version: '0.1.0',
    displayName: 'My App',
    bundleId: 'com.example.myapp',    // makes this an app pack: guide + macros surface when it is active
    shortId: 'myapp',                 // tool prefix → myapp_login
    guidePath: path.join(here, 'GUIDE.md'),
    humanProfile: 'relaxed',          // optional: the gesture profile this pack's macros and tasks use
    tasks: [],                        // scheduled tasks (see below)
    macros: [{
        name: 'login',
        description: 'Sign in with the account registered for this device.',
        input: z.object({ username: z.string().optional() }),
        async run({ driver, pluginData, log }, input) {
            const user = input.username ?? String(pluginData.username ?? '');
            await driver.openApp('com.example.myapp', { relaunch: true });
            await driver.wait(1500);
            await driver.tap({ text: 'Log in' });          // by accessibility label
            await driver.tap({ text: 'Email' });
            await driver.typeText(user);
            // …
            log(`signed in as ${user}`);
            return 'ok';
        },
    }],
    registrationChecks: [{
        id: 'installed', displayName: 'My App is installed',
        async run(device, pluginData, context) {
            const apps = await context?.driver?.listApps() ?? [];
            return apps.some((app) => app.bundleId === 'com.example.myapp')
                ? { status: 'passed', message: 'installed' }
                : { status: 'blocked', message: 'Install My App first' };
        },
    }],
};
export default pack;
```

### The driver inside a macro

`context.driver` is a `DeviceDriver`:

- `observe({ tree, screenshot, maxElements, treeTimeoutMs })`, `state()`, `screen()`, `screenshot()`, `rawScreenshot()`
- `tap({ elementId } | { text } | { x, y })`, `doubleTap`, `longPress(target, ms)`
- `swipe({ direction, amount })` / `swipe({ from, to })`, `scroll(direction, amount)`, `flickFeed('next' | 'previous')` for full-screen feeds
- `typeText(text, { submit })`, `pressButton('home' | 'lock' | 'volumeUp' | 'volumeDown')`, `home()`, `unlock()`
- `openApp(bundleId, { relaunch })`, `closeApp`, `openUrl`, `listApps()`, `acceptAlert`, `dismissAlert`, `dismissKeyboard`, `wait(ms)`
- `driver.humanizer` — `pause('think' | 'betweenTaps' | 'afterAction')`, `readTime(words)` for pacing inside long flows
- `driver.client` — the raw `WdaClient` when you need a route the driver doesn't wrap

Every gesture is already humanised; do not add jitter yourself. Prefer the
tree (`tap({ text })` / element ids from `observe`) over coordinates; if your
own app sets `accessibilityIdentifier`s, they show up as `#identifier` and
`findElements` matches them.

### Per-device configuration

`devices.json → pluginData[<pack id>]` is the pack's per-device config
(usernames, feature flags — never secrets that are not passcodes).
Macros get it as `context.pluginData`; the registration wizard can collect it
(`RegistrationUpdate.pluginData`).

### Named points

For an app that draws its controls instead of exposing them as elements, declare where
they sit as fractions of the screen, so they fit any iPhone:

```ts
points: { like: { fx: 0.92, fy: 0.47, label: 'Like button' } },
```

A macro or task gets one on the device's screen with `await context.point('like')`. A
device can override any of them (`devices.json` → `coordinates` → `"<shortId>.like"`, or
`PATCH /api/devices/:udid {"coordinates": …}`), and `GET /api/devices/:udid/coordinates`
lists every pack's points with their defaults and overrides. Prefer elements whenever the
app has them: a point is a guess that breaks when the layout moves.

### Scheduled tasks

A `TaskDefinition` has a `type`, a `displayName`, an integer `version`,
`validate(payload, context)`, `summarize`, `estimateDurationMs`, `retryPolicy`,
`supportsStop`, and `execute(context, payload)` where `context` carries `driver`,
`registeredDevice`, `devicePluginData`, `assets`, `signal`, `log` and `runProcess`
(a child process that gets `IOS_UDID`, `WDA_URL` and `MJPEG_URL` for the device). The version is stored with every
schedule, so an old schedule fails loudly instead of running new logic.

### Dashboard additions

`registerRoutes({ app, … })` adds HTTP routes to the dashboard's server (an endpoint
your own tools call, a task that needs uploaded files), and `navLinks` adds
links to its top bar. `devicePanels` (HTML fragments) appear on the plain device
page the server renders when it runs without the built-in dashboard theme.

### Guide

Write `GUIDE.md` for the agent, not for people: layout, what each tab is
called, sticky toggles, pop-ups, which macro to use for what, what is
irreversible. Keep it under a page — it is injected into the agent's context.

## Trust

Plugins and app packs are trusted code, not a sandbox. Loading one grants the
same filesystem, network, process, database and device access as the phoneos
services themselves, including passcodes in `devices.json` and every gesture
on every phone.

- Load only packs you wrote or reviewed. `apps/` is part of this repository on
  purpose; `PHONEOS_PLUGINS` packages should be pinned and vendored.
- A pack must not store credentials in `pluginData` (that file is readable by
  every process on the host). Passcodes belong in the device's `passcode` field.
- Macros run inside the agent-interface process: keep them bounded (timeouts,
  attempt limits) and never leave a phone on a payment sheet or a half-sent
  message when they fail.
- Task versions are contracts: bump `version` when the payload shape or the
  effect changes, keep the old version installed until its schedules are gone.
