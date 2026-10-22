import http from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';

import type { WdaTreeNode } from '../src/observe/tree.js';

export interface FakeWdaState {
    locked: boolean;
    activeApp: { bundleId: string; name: string; pid: number };
    screen: { width: number; height: number; scale: number };
    tree: WdaTreeNode;
    /** When set, /source stalls until the request times out. */
    treeDelayMs: number;
    alertText: string | null;
    pasteboard: { plaintext?: string; url?: string; image?: string };
    appearance: 'light' | 'dark';
    orientation: 'PORTRAIT' | 'LANDSCAPE';
    recording: { uuid: string; fps: number; codec: number; startedAt: number } | null;
    /** When set, /url answers as iOS before 16.4 does. */
    cannotOpenLinks?: boolean;
    location?: { latitude: number; longitude: number } | null;
}

export interface RecordedRequest { method: string; path: string; body: unknown }

export function node(partial: Partial<WdaTreeNode> & { type: string }): WdaTreeNode {
    return {
        rawIdentifier: null, name: null, value: null, label: null,
        rect: { x: 0, y: 0, width: 0, height: 0 }, isEnabled: '1', isVisible: '1', isAccessible: '1', isFocused: '0',
        ...partial,
    };
}

export function settingsTree(): WdaTreeNode {
    return node({
        type: 'Application', name: 'Settings', label: 'Settings', rect: { x: 0, y: 0, width: 390, height: 844 },
        children: [node({
            type: 'Window', rect: { x: 0, y: 0, width: 390, height: 844 },
            children: [
                node({ type: 'NavigationBar', name: 'Settings', label: 'Settings', rect: { x: 0, y: 47, width: 390, height: 44 }, children: [
                    node({ type: 'StaticText', label: 'Settings', rect: { x: 160, y: 55, width: 70, height: 28 } }),
                ] }),
                node({ type: 'Table', rect: { x: 0, y: 91, width: 390, height: 753 }, children: [
                    node({ type: 'Cell', label: 'Airplane Mode', rect: { x: 0, y: 150, width: 390, height: 44 }, children: [
                        node({ type: 'StaticText', label: 'Airplane Mode', rect: { x: 60, y: 160, width: 120, height: 24 } }),
                        node({ type: 'Switch', label: 'Airplane Mode', value: '0', rect: { x: 320, y: 156, width: 51, height: 31 } }),
                    ] }),
                    node({ type: 'Cell', label: 'Wi-Fi', value: 'Home', rect: { x: 0, y: 194, width: 390, height: 44 } }),
                    node({ type: 'Cell', label: 'Hidden', rect: { x: 0, y: 2000, width: 390, height: 44 } }),
                    node({ type: 'Cell', label: 'Invisible', isVisible: '0', rect: { x: 0, y: 238, width: 390, height: 44 } }),
                    node({ type: 'Other', rect: { x: 0, y: 300, width: 390, height: 10 } }),
                    node({ type: 'TextField', name: 'search', label: 'Search', value: 'wifi', isFocused: '1', rect: { x: 20, y: 100, width: 350, height: 36 } }),
                ] }),
                node({ type: 'Keyboard', rect: { x: 0, y: 500, width: 390, height: 344 }, children: [
                    node({ type: 'Key', label: 'a', rect: { x: 0, y: 520, width: 30, height: 40 } }),
                ] }),
            ],
        })],
    });
}

export function lockScreenTree(): WdaTreeNode {
    const keys = ['1', '2 ABC', '3 DEF', '4 GHI', '5 JKL', '6 MNO', '7 PQRS', '8 TUV', '9 WXYZ', '0'].map((label, index) => node({
        type: 'Button', label, rect: { x: index === 9 ? 160 : 60 + (index % 3) * 100, y: index === 9 ? 620 : 320 + Math.floor(index / 3) * 90, width: 70, height: 70 },
    }));
    return node({ type: 'Application', name: 'SpringBoard', rect: { x: 0, y: 0, width: 390, height: 844 }, children: [node({ type: 'Window', rect: { x: 0, y: 0, width: 390, height: 844 }, children: keys })] });
}

/**
 * An in-process WebDriverAgent double: the routes DeviceDriver uses, with a
 * mutable state and a request log. Not a full WDA — just enough to prove the
 * driver speaks the protocol correctly.
 */
export async function startFakeWda(initial: Partial<FakeWdaState> = {}): Promise<{ url: string; state: FakeWdaState; requests: RecordedRequest[]; close(): Promise<void> }> {
    const state: FakeWdaState = {
        locked: false,
        activeApp: { bundleId: 'com.apple.Preferences', name: 'Settings', pid: 42 },
        screen: { width: 390, height: 844, scale: 3 },
        tree: settingsTree(),
        treeDelayMs: 0,
        alertText: null,
        pasteboard: {},
        appearance: 'light',
        orientation: 'PORTRAIT',
        recording: null,
        ...initial,
    };
    const requests: RecordedRequest[] = [];
    let sessions = 0;
    const png = await sharp({ create: { width: 1170, height: 2532, channels: 3, background: { r: 20, g: 30, b: 40 } } }).png().toBuffer();

    const server = http.createServer((request, response) => {
        let raw = '';
        request.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        request.on('end', () => {
            const body = raw ? JSON.parse(raw) as unknown : undefined;
            const url = new URL(request.url ?? '/', 'http://localhost');
            const pathname = url.pathname.replace(/^\/session\/[^/]+/, '');
            requests.push({ method: request.method ?? 'GET', path: url.pathname, body });
            const send = (status: number, value: unknown) => {
                response.writeHead(status, { 'content-type': 'application/json' });
                // Like WDA: the session it is running, or null before the first one.
                response.end(JSON.stringify({ value, sessionId: sessions ? `s${sessions}` : null }));
            };
            const error = (status: number, code: string, message: string) => send(status, { error: code, message, traceback: '' });
            const method = request.method;
            if (method === 'POST' && url.pathname === '/session') { sessions += 1; return send(200, { sessionId: `s${sessions}`, capabilities: {} }); }
            if (method === 'GET' && pathname === '/status') return send(200, { ready: true, state: 'success', os: { name: 'iOS' } });
            if (method === 'GET' && pathname === '/wda/screen') return send(200, { screenSize: { width: state.screen.width, height: state.screen.height }, statusBarSize: { width: 390, height: 47 }, scale: state.screen.scale });
            if (method === 'GET' && pathname === '/orientation') return send(200, state.orientation);
            if (method === 'POST' && pathname === '/orientation') { state.orientation = (body as { orientation: 'PORTRAIT' | 'LANDSCAPE' }).orientation; const landscape = state.orientation === 'LANDSCAPE'; state.screen = { ...state.screen, width: landscape ? 844 : 390, height: landscape ? 390 : 844 }; return send(200, null); }
            if (method === 'POST' && pathname === '/wda/setPasteboard') { const { content, contentType } = body as { content: string; contentType: 'plaintext' | 'url' | 'image' }; state.pasteboard = { [contentType]: content }; if (contentType === 'url') state.pasteboard.plaintext = content; return send(200, null); }
            if (method === 'POST' && pathname === '/wda/getPasteboard') { const { contentType } = body as { contentType: 'plaintext' | 'url' | 'image' }; const value = state.pasteboard[contentType]; return value ? send(200, value) : error(500, 'unknown error', 'Cannot get pasteboard data'); }
            if (method === 'POST' && pathname === '/wda/device/appearance') { state.appearance = (body as { name: 'light' | 'dark' }).name; return send(200, null); }
            if (method === 'POST' && pathname === '/wda/pinch') return send(200, null);
            if (method === 'POST' && pathname === '/wda/video/start') { state.recording = { uuid: 'REC-1', fps: (body as { fps: number }).fps, codec: 0, startedAt: Date.now() / 1000 }; return send(200, state.recording); }
            if (method === 'POST' && pathname === '/wda/video/stop') { const recording = state.recording; state.recording = null; return send(200, recording); }
            if (method === 'GET' && pathname === '/wda/locked') return send(200, state.locked);
            if (method === 'POST' && pathname === '/wda/lock') { state.locked = true; return send(200, null); }
            if (method === 'POST' && pathname === '/wda/unlock') {
                if (state.locked) return error(500, 'unknown error', 'Timed out while waiting until the screen gets unlocked');
                return send(200, null);
            }
            if (method === 'POST' && pathname === '/wda/homescreen') { state.activeApp = { bundleId: 'com.apple.springboard', name: 'SpringBoard', pid: 1 }; return send(200, null); }
            if (method === 'GET' && pathname === '/wda/activeAppInfo') return send(200, { ...state.activeApp, processArguments: {} });
            if (method === 'GET' && pathname === '/wda/device/info') return send(200, { name: 'Fake', model: 'iPhone', isSimulator: false, thermalState: 2 });
            if (method === 'GET' && pathname === '/alert/text') return state.alertText ? send(200, state.alertText) : error(404, 'no such alert', 'An attempt was made to operate on a modal dialog when one was not open');
            if (method === 'GET' && pathname === '/screenshot') return send(200, png.toString('base64'));
            if (method === 'GET' && pathname === '/source') {
                if (state.treeDelayMs) return void setTimeout(() => send(200, state.tree), state.treeDelayMs);
                return send(200, state.tree);
            }
            if (method === 'POST' && pathname === '/wda/absolute-actions') {
                // The lock-screen fake: tapping any keypad button counts as a digit; four taps unlock.
                // A swipe (more than one move) is not a digit.
                const isTap = (payload: unknown): boolean => ((payload as { actions?: Array<{ actions: Array<{ type: string }> }> })?.actions?.[0]?.actions ?? [])
                    .filter((action) => action.type === 'pointerMove').length === 1;
                if (state.locked && isTap(body)) {
                    state.locked = requests.filter((entry) => entry.path.endsWith('/wda/absolute-actions') && isTap(entry.body)).length % 4 !== 0;
                }
                return send(200, null);
            }
            if (pathname === '/wda/simulatedLocation') {
                if (method === 'POST') state.location = body as { latitude: number; longitude: number };
                if (method === 'DELETE') state.location = null;
                return send(200, method === 'GET' ? { latitude: state.location?.latitude ?? null, longitude: state.location?.longitude ?? null, altitude: null } : null);
            }
            if (method === 'POST' && pathname === '/wda/pressButton') return send(200, null);
            if (method === 'POST' && pathname === '/wda/keys') return send(200, null);
            if (method === 'POST' && pathname === '/url') {
                // As iOS before 16.4 answers.
                if (state.cannotOpenLinks) return error(500, 'unknown error', 'Error Domain=com.apple.dt.xctest.ui-testing.error Code=10401 "Device does not have the capability to open the default app from a url"');
                return send(200, null);
            }
            if (method === 'POST' && pathname === '/wda/apps/launch') { const { bundleId } = body as { bundleId: string }; state.activeApp = { bundleId, name: bundleId.split('.').pop() ?? bundleId, pid: 99 }; return send(200, null); }
            if (method === 'POST' && pathname === '/wda/apps/activate') { const { bundleId } = body as { bundleId: string }; state.activeApp = { bundleId, name: bundleId.split('.').pop() ?? bundleId, pid: 99 }; return send(200, null); }
            if (method === 'POST' && pathname === '/wda/apps/terminate') return send(200, true);
            if (method === 'POST' && pathname === '/wda/apps/state') return send(200, (body as { bundleId: string }).bundleId === state.activeApp.bundleId ? 4 : 1);
            if (method === 'GET' && pathname === '/wda/batteryInfo') return send(200, { level: 0.8, state: 2 });
            if (method === 'POST' && pathname === '/appium/settings') return send(200, body);
            if (method === 'POST' && pathname === '/wda/keyboard/dismiss') return send(200, null);
            if (method === 'POST' && pathname === '/alert/accept') { state.alertText = null; return send(200, null); }
            if (method === 'POST' && pathname === '/alert/dismiss') { state.alertText = null; return send(200, null); }
            // As on the phone for "Turn On Location Services…": the route lives under a session.
            if (method === 'GET' && url.pathname.endsWith('/wda/alert/buttons') && url.pathname.startsWith('/session/')) return send(200, state.alertText ? ['Settings', 'Cancel'] : []);
            return error(404, 'unknown command', `no route for ${method} ${url.pathname}`);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`, state, requests,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
