import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { loadAllPlugins } from '../apps/loader.js';
import { DeviceFleet } from '../device/fleet.js';
import { discoverAll } from '../devices/discovery.js';
import { runDoctor } from '../devices/doctor.js';
import { allocateDevicePorts } from '../devices/registration.js';
import { loadRegisteredDevices, mutateRegisteredDevices } from '../devices/registry.js';
import { createSimulator, registerSimulator } from '../devices/simulators.js';
import { PRIVACY_SERVICES, type PrivacyService } from '../device/simulator-controls.js';
import { isHumanProfile, type HumanProfile } from '../humanize/humanizer.js';
import { addVideoMetadataSchema } from '../media/video-metadata.js';
import { normalizeVideoSchema } from '../media/video-normalize.js';
import { MAX_STEPS, runSteps, stepSchema } from './steps.js';
import { AgentTools, macroToolName, type ToolResult } from './tools.js';

const USAGE = `phone — drive an iPhone from the terminal (same tools as the MCP server)

usage: phone [-d <device>] [--precise|--relaxed] <command> [args]

  demo                             set up a simulator an agent can drive, from scratch
  doctor                           check the setup; says how to fix each problem
  devices                          registered phones with state
  fleet                            health: battery, thermal, storage, WDA, warnings
  state                            lock / app / screen / alert / battery
  observe [--screenshot file.jpg] [--no-marks] [--changes] [--max N] [--tree-timeout ms]
                                   ids drawn on the screenshot unless --no-marks;
                                   --changes lists only what changed since the last observe
  screenshot -o file.jpg
  find <text>
  a11y [--screenshot file.jpg]     accessibility check of the screen in front
  apps
  tap <e7 | "text" | x,y> [--spread N]   e… ids from observe; with x,y: land up to N points from it.
                                   double-tap / long-press take the same target
  tap-keys "<text>"                write lower-case letters and spaces by tapping the on-screen keyboard's keys one at a time
  swipe <up|down|left|right> [amount]
  swipe <x1,y1> <x2,y2>            drag from one point to another (a strip the direction swipe does not reach)
  scroll <up|down|left|right> [amount]
  feed [next|previous]             one item on in a full-screen feed, with a thumb's arc
  scroll-to <text>
  type <text> [--submit]
  press <home|volume_up|volume_down|lock>
  unlock
  open <app> [--relaunch] [--arg A]… [--env K=V]…   bundle id or app name; launch arguments / environment relaunch it
                                   (an argument starting with a dash: --arg=-UITestMode)
  close <app>
  url <url>
  wait <ms>
  alert <accept|dismiss> ["Button"]   dismiss presses the no (Cancel, Not Now…), accept the yes; or name the button
  keyboard-dismiss
  video-metadata <file> --metadata '<json>' [-o copy.mp4]   local tags only; no phone or overwrite
  normalize-video <file> [--fps 30] [--no-audio] [--quality 18] [-o out.mp4]   upload-safe fps + audio track
  photos-add <file...>             images/videos → Photos library
  file-add <app> <file> [--name X] [--dir sub]   any file → the app's Documents (Files → On My iPhone → app)
  files <app> [dir]                list an app's Documents
  photos-get [count] [-o dir]      newest camera-roll photos/videos → this Mac
  file-get <app> <remote> [-o file]   a file out of an app's Documents
  wait-for <text> [--gone] [--timeout ms]   poll until text appears / disappears
  steps '<json array>' | --file steps.json   several steps in one go, e.g. '[{"action":"open_app","app":"Settings"},{"action":"tap","text":"General"}]'
  report-start "<title>"           write down every action from now on, with screenshots
  report-finish [--outcome passed|failed] [--notes "…"]   → one HTML file to share
  location [<lat> <lon> | --clear]   the GPS position apps see (iOS 16.4+); no argument: what is set
  push <app> "title" ["body"]      a push notification (simulators)
  permission <app> <service> <grant|revoke|reset>   photos, location, contacts, microphone… (simulators)
  status-bar [clean|clear]         9:41, full signal and battery for screenshots (simulators)
  logs <app> [--seconds N] [--filter text] [--errors]   the app's log lines (a phone: listens N s, default 10)
  crashes <app> [count]            the app's newest crash reports, summarised
  record-start [--fps N] / record-stop [-o file.mov]   screen recording (iOS 17+)
  clipboard [text | --url U | --image file]   set the clipboard; no argument reads it
  appearance <light|dark> · rotate <portrait|landscape> · pinch <scale> [velocity]
  keep-awake [choice]              Auto-Lock → Never (so WDA can restart unattended)
  app-install <path.app|.ipa> · app-uninstall <app> · app-reset <app> [path.app|.ipa]   reset: reinstalled with no data
  macro <name> [json]              e.g. macro settings_open '{"page":"Battery"}'
  macros                           list app-pack macros
  register [udid|name] [--name X] [--profile natural]   register a USB-connected iPhone into devices.json
  passcode [-d device]             set the unlock passcode (typed hidden, stored only in devices.json)
  register-sim [udid|name] [--name X] [--profile natural]
  sim-create ["<device type>"] [--runtime iOS-26-5]   default: the newest iPhone Pro
  mcp                              run the MCP server on stdio

-d/--device: udid, unique prefix, or name; optional when one device is registered.`;

function parseTarget(value: string | undefined): { elementId?: string; text?: string; x?: number; y?: number } {
    if (!value) throw new Error('Give a target: an element id (e7), a label ("Wi-Fi") or x,y');
    if (/^e\d+$/.test(value)) return { elementId: value };
    const point = /^\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
    if (point) return { x: Number(point[1]), y: Number(point[2]) };
    return { text: value };
}

function swipePoint(value: string | undefined): { x: number; y: number } | undefined {
    const point = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(value ?? '');
    return point ? { x: Number(point[1]), y: Number(point[2]) } : undefined;
}

/** `phone` runs from the repo, but a path typed on the command line means the caller's folder. */
function local(file: string): string {
    return path.resolve(process.env.PHONEOS_CALLER_CWD ?? process.cwd(), file);
}

async function print(result: ToolResult, imagePath?: string): Promise<void> {
    process.stdout.write(`${result.text}\n`);
    if (result.image && imagePath) {
        await writeFile(local(imagePath), result.image.data);
        process.stdout.write(`(image written to ${local(imagePath)})\n`);
    }
}

async function registerDevice(reference: string | undefined, name: string | undefined, profile: HumanProfile): Promise<void> {
    const phones = (await discoverAll()).filter((entry) => entry.kind === 'device');
    if (!phones.length) throw new Error('No iPhone is visible over USB. Connect it with a data cable, unlock it, tap "Trust This Computer", and make sure Xcode → Window → Devices shows it.');
    const needle = (reference ?? '').toLowerCase();
    const phone = needle
        ? phones.find((entry) => entry.udid.toLowerCase() === needle || entry.name.toLowerCase() === needle || entry.udid.toLowerCase().startsWith(needle))
        : phones.length === 1 ? phones[0] : undefined;
    if (!phone) throw new Error(`Which phone? Connected: ${phones.map((entry) => `${entry.name} (${entry.udid})`).join(', ')}`);
    const existing = (await loadRegisteredDevices()).find((entry) => entry.udid === phone.udid);
    if (existing) {
        process.stdout.write(`${phone.name} is already registered as "${existing.name}" (WDA port ${existing.wdaLocalPort ?? 8100})\n`);
        return;
    }
    const ports = await allocateDevicePorts(await loadRegisteredDevices());
    await mutateRegisteredDevices((devices) => {
        devices.push({
            name: name ?? phone.name, udid: phone.udid,
            ...(phone.productType ? { productType: phone.productType } : {}),
            ...(phone.modelName ? { modelName: phone.modelName } : {}),
            osVersion: phone.osVersion, ...ports, humanProfile: profile, pluginData: {},
        });
    });
    process.stdout.write(`Registered ${phone.name} (${phone.modelName ?? phone.productType ?? 'iPhone'}, iOS ${phone.osVersion}, ${phone.udid}) — WDA :${ports.wdaLocalPort}, MJPEG :${ports.mjpegLocalPort}.\nNext: phone passcode -d ${phone.udid.slice(0, 8)}   (if it has one), then npm run wda:prepare -- --udid ${phone.udid}, then npm run wda:service\n`);
}

async function promptHidden(question: string): Promise<string> {
    const { createInterface } = await import('node:readline');
    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        const write = (rl as unknown as { _writeToOutput?: (text: string) => void });
        process.stdout.write(question);
        write._writeToOutput = () => undefined; // never echo the digits
        rl.question('', (answer) => {
            rl.close();
            process.stdout.write('\n');
            resolve(answer.trim());
        });
    });
}

async function setPasscode(reference: string | undefined): Promise<void> {
    const fleet = new DeviceFleet();
    const device = await fleet.resolve(reference ?? '');
    const passcode = process.stdin.isTTY ? await promptHidden(`Unlock passcode for ${device.name} (hidden, digits only; empty clears): `) : (await new Promise<string>((resolve) => { let data = ''; process.stdin.on('data', (chunk) => { data += chunk; }); process.stdin.on('end', () => resolve(data.trim())); }));
    if (passcode && !/^\d{4,}$/.test(passcode)) throw new Error('A passcode is at least four digits');
    await mutateRegisteredDevices((all) => {
        const entry = all.find((candidate) => candidate.udid === device.udid);
        if (!entry) throw new Error('Device disappeared from devices.json');
        if (passcode) entry.passcode = passcode;
        else delete entry.passcode;
    });
    process.stdout.write(passcode ? `Passcode saved for ${device.name} in devices.json (0600).\n` : `Passcode cleared for ${device.name}.\n`);
}

export async function runCli(argv: string[]): Promise<void> {
    const { values, positionals } = parseArgs({
        args: argv,
        options: {
            device: { type: 'string', short: 'd' },
            precise: { type: 'boolean' },
            relaxed: { type: 'boolean' },
            screenshot: { type: 'string' },
            max: { type: 'string' },
            'tree-timeout': { type: 'string' },
            out: { type: 'string', short: 'o' },
            submit: { type: 'boolean' },
            spread: { type: 'string' },
            relaunch: { type: 'boolean' },
            name: { type: 'string' },
            profile: { type: 'string' },
            runtime: { type: 'string' },
            dir: { type: 'string' },
            gone: { type: 'boolean' },
            timeout: { type: 'string' },
            fps: { type: 'string' },
            url: { type: 'string' },
            image: { type: 'string' },
            metadata: { type: 'string' },
            quality: { type: 'string' },
            'no-audio': { type: 'boolean' },
            'no-marks': { type: 'boolean' },
            changes: { type: 'boolean' },
            filter: { type: 'string' },
            seconds: { type: 'string' },
            errors: { type: 'boolean' },
            arg: { type: 'string', multiple: true },
            clear: { type: 'boolean' },
            outcome: { type: 'string' },
            file: { type: 'string' },
            notes: { type: 'string' },
            env: { type: 'string', multiple: true },
            help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: true,
    });
    const [command, ...rest] = positionals;
    if (values.help || !command) {
        process.stdout.write(`${USAGE}\n`);
        return;
    }
    const profile: HumanProfile | undefined = values.precise ? 'precise' : values.relaxed ? 'relaxed' : undefined;
    if (command === 'mcp') {
        const { main } = await import('./mcp-server.js');
        await main();
        // The server lives on stdin: return (and exit) only when the client hangs up.
        await new Promise<void>((resolve) => process.stdin.once('close', resolve));
        return;
    }
    if (command === 'demo') {
        const { runDemo } = await import('./demo.js');
        await runDemo();
        return;
    }
    if (command === 'doctor') {
        const { text, failures } = await runDoctor();
        process.stdout.write(`${text}\n`);
        if (failures) process.exitCode = 1;
        return;
    }
    if (command === 'register') {
        const chosen = values.profile ?? 'natural';
        if (!isHumanProfile(chosen)) throw new Error('--profile must be precise, natural, or relaxed');
        await registerDevice(rest[0], values.name, chosen);
        return;
    }
    if (command === 'passcode') {
        await setPasscode(values.device);
        return;
    }
    if (command === 'register-sim') {
        const chosen = values.profile ?? 'natural';
        if (!isHumanProfile(chosen)) throw new Error('--profile must be precise, natural, or relaxed');
        const { device: simulator, created } = await registerSimulator(rest[0], values.name, chosen);
        process.stdout.write(created
            ? `Registered simulator ${simulator.name} (${simulator.udid}) — WDA :${simulator.wdaLocalPort}, MJPEG :${simulator.mjpegLocalPort}.\nNext: npm run wda:prepare -- --udid ${simulator.udid} --sim   (once), then npm run wda:service\n`
            : `${simulator.name} is already registered (WDA port ${simulator.wdaLocalPort ?? 8100})\n`);
        return;
    }
    if (command === 'sim-create') {
        const simulator = await createSimulator(rest[0], values.runtime);
        process.stdout.write(`Created and booted ${simulator.name} on ${simulator.runtime}: ${simulator.udid}\nNext: phone register-sim ${simulator.udid}\n`);
        return;
    }

    const plugins = await loadAllPlugins();
    const fleet = new DeviceFleet({ ...(profile ? { humanProfile: profile } : {}), log: (line) => process.stderr.write(`${line}\n`) });
    const tools = new AgentTools({ fleet, plugins, log: (line) => process.stderr.write(`${line}\n`) });
    const device = values.device;
    const arg = (index: number, what: string): string => {
        const value = rest[index];
        if (value === undefined) throw new Error(`Missing ${what}\n\n${USAGE}`);
        return value;
    };
    const direction = (value: string) => {
        if (!['up', 'down', 'left', 'right'].includes(value)) throw new Error('direction must be up, down, left, or right');
        return value as 'up' | 'down' | 'left' | 'right';
    };

    // A command that fails is a step of an open run report too.
    const dispatch = async (): Promise<void> => {
        switch (command) {
            case 'devices': return print(await tools.listDevices());
            case 'fleet': return print(await tools.fleetStatus());
            case 'state': return print(await tools.deviceState(device));
            case 'observe': return print(await tools.observe(device, { screenshot: Boolean(values.screenshot), ...(values.max ? { maxElements: Number(values.max) } : {}), ...(values['tree-timeout'] ? { treeTimeoutMs: Number(values['tree-timeout']) } : {}), ...(values['no-marks'] ? { marks: false } : {}), ...(values.changes ? { changes: true } : {}) }), values.screenshot);
            case 'screenshot': return print(await tools.screenshot(device), values.out ?? 'screenshot.jpg');
            case 'find': return print(await tools.find(device, arg(0, 'text')));
        case 'a11y': return print(await tools.a11yAudit(device, { screenshot: Boolean(values.screenshot) }), values.screenshot);
            case 'apps': return print(await tools.listApps(device));
            case 'tap': return print(await tools.tap(device, { ...parseTarget(rest[0]), ...(values.spread ? { spread: Number(values.spread) } : {}) }));
            case 'tap-keys': return print(await tools.tapKeys(device, arg(0, 'text')));
            case 'double-tap': return print(await tools.doubleTap(device, parseTarget(rest[0])));
            case 'long-press': return print(await tools.longPress(device, parseTarget(rest[0])));
            case 'swipe': {
                const from = swipePoint(rest[0]);
                if (from) {
                    const to = swipePoint(rest[1]);
                    if (!to) throw new Error('A swipe between two points needs both: swipe x1,y1 x2,y2');
                    return print(await tools.swipe(device, { from, to }));
                }
                return print(await tools.swipe(device, { direction: direction(arg(0, 'direction')), ...(rest[1] ? { amount: Number(rest[1]) } : {}) }));
            }
            case 'feed': return print(await tools.flickFeed(device, rest[0] === 'previous' ? 'previous' : 'next'));
            case 'scroll': return print(await tools.scroll(device, { direction: direction(arg(0, 'direction')), ...(rest[1] ? { amount: Number(rest[1]) } : {}) }));
            case 'scroll-to': return print(await tools.scrollTo(device, { text: arg(0, 'text') }));
            case 'type': return print(await tools.typeText(device, { text: rest.join(' '), submit: Boolean(values.submit) }));
            case 'press': {
                const button = arg(0, 'button');
                if (!['home', 'volume_up', 'volume_down', 'lock'].includes(button)) throw new Error('button must be home, volume_up, volume_down, or lock');
                return print(await tools.pressButton(device, button as 'home'));
            }
            case 'unlock': return print(await tools.unlock(device));
            case 'open': {
                const environment = Object.fromEntries((values.env ?? []).map((pair) => {
                    const equals = pair.indexOf('=');
                    if (equals < 1) throw new Error(`--env takes NAME=value, not ${pair}`);
                    return [pair.slice(0, equals), pair.slice(equals + 1)];
                }));
                return print(await tools.openApp(device, {
                    app: arg(0, 'app'), relaunch: Boolean(values.relaunch),
                    ...(values.arg?.length ? { arguments: values.arg } : {}),
                    ...(Object.keys(environment).length ? { environment } : {}),
                }));
            }
            case 'close': return print(await tools.closeApp(device, arg(0, 'app')));
            case 'url': return print(await tools.openUrl(device, arg(0, 'url')));
            case 'wait': return print(await tools.wait(device, Number(arg(0, 'milliseconds'))));
            case 'alert': {
                const action = arg(0, 'accept|dismiss');
                if (action !== 'accept' && action !== 'dismiss') throw new Error('alert takes accept or dismiss');
                return print(await tools.alert(device, action, rest[1]));
            }
            case 'keyboard-dismiss': return print(await tools.dismissKeyboard(device));
            case 'video-metadata': {
                if (!values.metadata) throw new Error('Give --metadata as a JSON object, e.g. --metadata \'{"title":"My clip"}\'');
                let metadata: unknown;
                try { metadata = JSON.parse(values.metadata); } catch { throw new Error('--metadata must be valid JSON'); }
                return print(await tools.addVideoMetadata(addVideoMetadataSchema.parse({ input_path: local(arg(0, 'video file')), output_path: values.out === undefined ? undefined : local(values.out), metadata })));
            }
            case 'normalize-video': {
                return print(await tools.normalizeVideo(normalizeVideoSchema.parse({
                    input_path: local(arg(0, 'video file')),
                    output_path: values.out === undefined ? undefined : local(values.out),
                    ...(values.fps === undefined ? {} : { fps: Number(values.fps) }),
                    ...(values.quality === undefined ? {} : { quality: Number(values.quality) }),
                    ...(values['no-audio'] ? { ensure_audio: false } : {}),
                })));
            }
            case 'photos-add': {
                if (!rest.length) throw new Error('Give at least one image or video file');
                return print(await tools.addToPhotos(device, rest.map(local)));
            }
            case 'file-add': return print(await tools.addFile(device, { app: arg(0, 'app'), path: local(arg(1, 'file')), ...(values.name ? { name: values.name } : {}), ...(values.dir ? { subdirectory: values.dir } : {}) }));
            case 'files': return print(await tools.listFiles(device, { app: arg(0, 'app'), ...(rest[1] ? { subdirectory: rest[1] } : {}) }));
            case 'photos-get': return print(await tools.getPhotos(device, { ...(rest[0] ? { count: Number(rest[0]) } : {}), ...(values.out ? { outDirectory: local(values.out) } : {}) }));
            case 'file-get': return print(await tools.getFile(device, { app: arg(0, 'app'), path: arg(1, 'remote path'), ...(values.out ? { outPath: local(values.out) } : {}) }));
            case 'wait-for': return print(await tools.waitFor(device, { text: arg(0, 'text'), gone: Boolean(values.gone), ...(values.timeout ? { timeoutMs: Number(values.timeout) } : {}) }));
            case 'steps': {
            const { readFile } = await import('node:fs/promises');
            const source = values.file ? await readFile(local(values.file), 'utf8') : arg(0, 'steps as a JSON array (or --file steps.json)');
            let parsed: unknown;
            try { parsed = JSON.parse(source); } catch { throw new Error('Steps must be a JSON array'); }
            return print(await runSteps(tools, device, z.array(stepSchema).min(1).max(MAX_STEPS).parse(parsed)));
        }
        case 'report-start': return print(await tools.startReport(device, rest.join(' ') || 'Run'));
            case 'report-finish': {
                if (values.outcome && values.outcome !== 'passed' && values.outcome !== 'failed') throw new Error('--outcome is passed or failed');
                return print(await tools.finishReport(device, { ...(values.outcome ? { outcome: values.outcome as 'passed' | 'failed' } : {}), ...(values.notes ? { notes: values.notes } : {}) }));
            }
            case 'location': {
                if (values.clear) return print(await tools.setLocation(device, { clear: true }));
                if (!rest.length) return print(await tools.setLocation(device, {}));
                return print(await tools.setLocation(device, { latitude: Number(arg(0, 'latitude')), longitude: Number(arg(1, 'longitude')) }));
            }
            case 'push': return print(await tools.sendPush(device, { app: arg(0, 'app'), title: arg(1, 'title'), ...(rest[2] ? { body: rest[2] } : {}) }));
            case 'permission': {
                const service = arg(1, 'service');
                const action = arg(2, 'grant|revoke|reset');
                if (!(PRIVACY_SERVICES as readonly string[]).includes(service)) throw new Error(`service must be one of ${PRIVACY_SERVICES.join(', ')}`);
                if (action !== 'grant' && action !== 'revoke' && action !== 'reset') throw new Error('permission takes grant, revoke or reset');
                return print(await tools.setPermission(device, { app: arg(0, 'app'), service: service as PrivacyService, action }));
            }
            case 'status-bar': return print(await tools.statusBar(device, rest[0] !== 'clear'));
            case 'logs': {
                const seconds = values.seconds ? Number(values.seconds) : 10;
                return print(await tools.appLogs(device, { app: arg(0, 'app'), sinceSeconds: Math.max(seconds, 1), listenMs: seconds * 1_000, ...(values.filter ? { filter: values.filter } : {}), ...(values.errors ? { errorsOnly: true } : {}) }));
            }
            case 'crashes': return print(await tools.crashReports(device, { app: arg(0, 'app'), ...(rest[1] ? { count: Number(rest[1]) } : {}) }));
            case 'record-start': return print(await tools.startRecording(device, values.fps ? { fps: Number(values.fps) } : {}));
            case 'record-stop': return print(await tools.stopRecording(device, values.out ? { outPath: local(values.out) } : {}));
            case 'clipboard': {
                if (values.url) return print(await tools.setClipboard(device, { url: values.url }));
                if (values.image) return print(await tools.setClipboard(device, { imagePath: local(values.image) }));
                if (rest.length) return print(await tools.setClipboard(device, { text: rest.join(' ') }));
                return print(await tools.getClipboard(device));
            }
            case 'keep-awake': return print(await tools.setAutoLock(device, rest[0] ?? 'Never'));
            case 'appearance': {
                const mode = arg(0, 'light|dark');
                if (mode !== 'light' && mode !== 'dark') throw new Error('appearance takes light or dark');
                return print(await tools.setAppearance(device, mode));
            }
            case 'rotate': {
                const orientation = arg(0, 'portrait|landscape');
                if (orientation !== 'portrait' && orientation !== 'landscape') throw new Error('rotate takes portrait or landscape');
                return print(await tools.rotate(device, orientation));
            }
            case 'pinch': return print(await tools.pinch(device, { scale: Number(arg(0, 'scale')), ...(rest[1] ? { velocity: Number(rest[1]) } : {}) }));
            case 'app-install': return print(await tools.installApp(device, local(arg(0, 'path'))));
            case 'app-uninstall': return print(await tools.uninstallApp(device, arg(0, 'app')));
            case 'app-reset': return print(await tools.resetApp(device, { app: arg(0, 'app'), ...(rest[1] ? { path: local(rest[1]) } : {}) }));
            case 'macros': {
                const lines = plugins.flatMap((plugin) => (plugin.macros ?? []).map((macro) => `${macroToolName(plugin, macro)} — ${macro.description}`));
                process.stdout.write(`${lines.join('\n') || 'No app-pack macros installed.'}\n`);
                return;
            }
            case 'macro': {
                const name = arg(0, 'macro name');
                for (const plugin of plugins) {
                    for (const macro of plugin.macros ?? []) {
                        if (macroToolName(plugin, macro) === name) {
                            return print(await tools.runMacro(plugin, macro.name, device, rest[1] ? JSON.parse(rest[1]) : {}));
                        }
                    }
                }
                throw new Error(`Unknown macro ${name}. Run \`phone macros\`.`);
            }
            default:
                throw new Error(`Unknown command ${command}\n\n${USAGE}`);
        }
    };
    try {
        await dispatch();
    } catch (error) {
        if (!/^(Missing|Unknown command)/.test(error instanceof Error ? error.message : '')) {
            await tools.noteFailure(device, command, error instanceof Error ? error.message : String(error));
        }
        throw error;
    }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
    runCli(process.argv.slice(2)).then(() => process.exit(0)).catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    });
}
