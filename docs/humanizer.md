# The humanizer

Every gesture phoneos makes — from an agent, a macro, a scheduled task or the
dashboard — passes through `src/humanize/humanizer.ts`. Its job is to make
input look like a person's without anyone having to think about it.

## Profiles

| | `precise` | `natural` (default) | `relaxed` |
|---|---|---|---|
| Tap landing point | exact centre | 2-D gaussian around the centre (σ = frame/6), clamped to the inner 80 % of the frame; never the same pixel twice in a row | σ = frame/4, inner 90 % |
| Tap hold | 80 ms | log-normal 60–140 ms | 60–220 ms |
| Bare-coordinate jitter | 0 | σ 1.5 pt | σ 2.5 pt |
| Swipe path | straight, 6 segments | cubic Bézier with perpendicular control-point offsets (σ 5 % of length), 10–16 `pointerMove` segments, ease-in (flick) or ease-in-out (drag) timing, endpoint jitter σ 2.5 pt, 15 % overshoot | 12–18 segments, σ 8 %, 25 % overshoot |
| Swipe duration | 350 ms | log-normal 280–650 ms | 300–800 ms |
| Pauses (`think` / `betweenTaps` / `afterAction`) | none | 400–1500 / 150–500 / 200–700 ms log-normal | ×1.5 |
| Reading time | none | ≈ 40 ms per visible word, capped at 6 s | same |
| Typing | one burst at 20 cps | 2–5 character bursts at 3–5 cps with 80–300 ms pauses, breaking after spaces | 1–4 characters at 2–4 cps, 100–500 ms pauses |
| Feed swipe that does not commit (lifts and springs back) | never | 10 % | 18 % |
| Idle nudges while `wait`ing | no | no | a 6–12 pt scroll nudge, sometimes; never with a keyboard or alert up |

Feed swipes (`flick_feed`) come from one side, the side of the
hand holding the phone: each phone gets a hand (about 88 % right), fixed by its
udid so it never changes between runs.

`precise` exists for calibration and debugging. Set the profile per device
(`humanProfile` in `devices.json` / the registration wizard), per app pack
(`humanProfile` on the pack: used by that pack's macros and scheduled tasks), or
for a whole CLI/MCP session (`--precise`, `--relaxed`, `PHONEOS_HUMAN_PROFILE`),
which wins over both.

## Determinism

The humanizer draws from a seeded RNG (`mulberry32`), and so does everything else
that has to look human (the pause between keys, whether a feed session likes a video:
`Humanizer.next()`). Scheduled executions are seeded with their execution id and the
MCP/CLI drivers with the device udid + start time, so a run can be replayed exactly
and a bug reproduced. `Humanizer.describe()` returns the profile and seed; the
session log records every gesture's parameters.

## Where gestures go

Plans become W3C pointer actions (`src/device/gestures.ts`) for the patched
WebDriverAgent route `POST /wda/absolute-actions`, which synthesises the touch
path straight through XCTest's daemon: multiple `pointerMove`s after a
`pointerDown` trace the curve with per-segment durations, so speed varies
along the path just like a finger.
