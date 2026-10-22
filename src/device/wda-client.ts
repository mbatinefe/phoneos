import type { W3cPointerSource } from './gestures.js';
import type { WdaTreeNode } from '../observe/tree.js';

export class WdaError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) {
        super(message);
    }
}

export interface WdaScreen { screenSize: { width: number; height: number }; statusBarSize?: { width: number; height: number }; scale: number }
export interface WdaActiveApp { pid: number; bundleId: string; name: string; processArguments?: unknown }
export interface WdaDeviceInfo {
    currentLocale?: string; timeZone?: string; name?: string; model?: string; uuid?: string;
    userInterfaceIdiom?: number; userInterfaceStyle?: string; isSimulator?: boolean; thermalState?: number;
}
export interface WdaBattery { level: number; state: number }
export type WdaOrientation = 'PORTRAIT' | 'LANDSCAPE' | 'UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT' | 'UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN' | string;

export interface WdaSessionSettings {
    waitForIdleTimeout?: number;
    animationCoolOffTimeout?: number;
    snapshotMaxDepth?: number;
    customSnapshotTimeout?: number;
    defaultActiveApplication?: string;
    respectSystemAlerts?: boolean;
    maxTypingFrequency?: number;
    [key: string]: unknown;
}

export interface WdaClientOptions {
    baseUrl: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    /** Applied on every session the client creates. */
    settings?: WdaSessionSettings;
}

interface WdaResponse<T> { value: T; sessionId?: string | null }

const DEFAULT_SETTINGS: WdaSessionSettings = {
    // XCTest otherwise waits for the app to go idle before every command; feeds and animations never do.
    waitForIdleTimeout: 0,
    animationCoolOffTimeout: 0,
    // Bound the tree walk so /source on a busy app returns something instead of hanging.
    snapshotMaxDepth: 40,
    customSnapshotTimeout: 6,
    respectSystemAlerts: true,
};

/**
 * Thin, typed client for one WebDriverAgent instance (one phone).
 *
 * Routes marked sessionless in WDA are called directly. The handful that
 * need a session (`/wda/keys`, `/url`, `/wda/apps/*`, `/appium/settings`,
 * `/wda/batteryInfo`, `/wda/alert/buttons`) go through a "bare" session: no
 * bundleId, so WDA attaches to whatever app is in front and launches nothing.
 * The session the agent is already running is joined; one is created only
 * when there is none. If WDA forgets it, it is recreated once and the call retried.
 */
export class WdaClient {
    readonly baseUrl: string;
    readonly timeoutMs: number;
    private readonly fetch: typeof fetch;
    private readonly settings: WdaSessionSettings;
    private sessionId: string | undefined;
    private sessionPromise: Promise<string> | undefined;

    constructor(options: WdaClientOptions) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        this.timeoutMs = options.timeoutMs ?? 10_000;
        this.fetch = options.fetchImpl ?? fetch;
        this.settings = { ...DEFAULT_SETTINGS, ...options.settings };
    }

    // ---- transport -------------------------------------------------------

    async request<T = unknown>(method: 'GET' | 'POST' | 'DELETE', pathname: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
        let response: Response;
        try {
            response = await this.fetch(`${this.baseUrl}${pathname}`, {
                method,
                ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new WdaError(`WebDriverAgent at ${this.baseUrl} is unreachable: ${reason}`, 0, 'unreachable');
        }
        const text = await response.text();
        let parsed: WdaResponse<T> | undefined;
        try {
            parsed = text ? JSON.parse(text) as WdaResponse<T> : undefined;
        } catch { /* non-JSON body */ }
        if (!response.ok) {
            const value = parsed?.value as { error?: string; message?: string } | undefined;
            const message = value?.message ?? value?.error ?? text.slice(0, 300) ?? response.statusText;
            throw new WdaError(`WDA ${method} ${pathname} → ${response.status}: ${message}`, response.status, value?.error);
        }
        return (parsed?.value ?? (undefined as unknown)) as T;
    }

    // ---- session ---------------------------------------------------------

    /** The session the agent is already running, if any (it keeps one at a time). */
    private async runningSession(): Promise<string | undefined> {
        try {
            const response = await this.fetch(`${this.baseUrl}/status`, { signal: AbortSignal.timeout(5_000) });
            const sessionId = (JSON.parse(await response.text()) as WdaResponse<unknown>).sessionId;
            return typeof sessionId === 'string' && sessionId ? sessionId : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Id of the bare session: the agent's current one when it has one, else a new one. Starting
     * a session ends the agent's screen recording (on iOS 26 a clip stops after 0.4 s), so
     * one-command-per-process callers like the CLI join the running session instead.
     */
    async session(): Promise<string> {
        if (this.sessionId) return this.sessionId;
        this.sessionPromise ??= (async () => {
            const running = await this.runningSession();
            if (running) {
                this.sessionId = running;
                return running;
            }
            const created = await this.request<{ sessionId: string }>('POST', '/session', {
                capabilities: {
                    alwaysMatch: {
                        shouldUseCompactResponses: true,
                        disableAutomaticScreenshots: true,
                        eventloopIdleDelaySec: 0,
                        shouldWaitForQuiescence: false,
                        waitForIdleTimeout: this.settings.waitForIdleTimeout ?? 0,
                        ...(this.settings.maxTypingFrequency ? { maxTypingFrequency: this.settings.maxTypingFrequency } : {}),
                    },
                },
            }, 30_000);
            this.sessionId = created.sessionId;
            try {
                await this.request('POST', `/session/${created.sessionId}/appium/settings`, { settings: this.settings });
            } catch { /* settings are an optimisation, not a requirement */ }
            return created.sessionId;
        })().finally(() => { this.sessionPromise = undefined; });
        return this.sessionPromise;
    }

    forgetSession(): void {
        this.sessionId = undefined;
    }

    private async withSession<T>(run: (sessionId: string) => Promise<T>): Promise<T> {
        const first = await this.session();
        try {
            return await run(first);
        } catch (error) {
            if (error instanceof WdaError && (error.status === 404 || /session/i.test(error.message)) && error.status !== 0) {
                this.forgetSession();
                return run(await this.session());
            }
            throw error;
        }
    }

    sessionGet<T>(pathname: string, timeoutMs?: number): Promise<T> {
        return this.withSession((id) => this.request<T>('GET', `/session/${id}${pathname}`, undefined, timeoutMs));
    }

    sessionPost<T = unknown>(pathname: string, body: unknown = {}, timeoutMs?: number): Promise<T> {
        return this.withSession((id) => this.request<T>('POST', `/session/${id}${pathname}`, body, timeoutMs));
    }

    // ---- sessionless: state ---------------------------------------------

    async status(): Promise<Record<string, unknown>> {
        return this.request<Record<string, unknown>>('GET', '/status', undefined, 3_000);
    }

    async isReady(): Promise<boolean> {
        try {
            await this.status();
            return true;
        } catch {
            return false;
        }
    }

    screen(): Promise<WdaScreen> {
        return this.request<WdaScreen>('GET', '/wda/screen');
    }

    locked(): Promise<boolean> {
        return this.request<boolean>('GET', '/wda/locked');
    }

    /** WDA waits up to about 10 s for the lock to be confirmed, so allow longer than that: its own error says what went wrong. */
    lock(): Promise<void> {
        return this.request('POST', '/wda/lock', {}, 15_000);
    }

    /** Wakes the screen; on a passcode-protected phone WDA then reports an error because it stays locked — callers handle that. */
    unlock(): Promise<void> {
        return this.request('POST', '/wda/unlock', {}, 15_000);
    }

    homescreen(): Promise<void> {
        return this.request('POST', '/wda/homescreen', {});
    }

    activeAppInfo(): Promise<WdaActiveApp> {
        return this.request<WdaActiveApp>('GET', '/wda/activeAppInfo');
    }

    deviceInfo(): Promise<WdaDeviceInfo> {
        return this.request<WdaDeviceInfo>('GET', '/wda/device/info');
    }

    orientation(): Promise<WdaOrientation> {
        return this.request<WdaOrientation>('GET', '/orientation');
    }

    /** The location the phone reports to apps while one is simulated (iOS 16.4+), or null. */
    async simulatedLocation(): Promise<{ latitude: number; longitude: number } | null> {
        const value = await this.request<{ latitude: number | null; longitude: number | null }>('GET', '/wda/simulatedLocation');
        return value?.latitude === null || value?.longitude === null || !value ? null : { latitude: value.latitude, longitude: value.longitude };
    }

    setSimulatedLocation(latitude: number, longitude: number): Promise<void> {
        return this.request('POST', '/wda/simulatedLocation', { latitude, longitude });
    }

    clearSimulatedLocation(): Promise<void> {
        return this.request('DELETE', '/wda/simulatedLocation');
    }

    /** The labels of the alert's buttons (the route needs a session). Empty when there is no alert. */
    async alertButtons(timeoutMs = 4_000): Promise<string[]> {
        try {
            const value = await this.sessionGet<string[]>('/wda/alert/buttons', timeoutMs);
            return Array.isArray(value) ? value.filter((label): label is string => typeof label === 'string') : [];
        } catch {
            return [];
        }
    }

    /** Text of the alert on screen, or `null` when there is none — or when WDA is too busy (app launching) to say. */
    async alertText(timeoutMs = 4_000): Promise<string | null> {
        try {
            return await this.request<string>('GET', '/alert/text', undefined, timeoutMs);
        } catch {
            return null; // "no alert open", or a probe timeout while an app animates in
        }
    }

    /** Accept the alert, or press the button named `name`. */
    alertAccept(name?: string): Promise<void> {
        return this.request('POST', '/alert/accept', name ? { name } : {});
    }

    /** Dismiss the alert, or press the button named `name`. */
    alertDismiss(name?: string): Promise<void> {
        return this.request('POST', '/alert/dismiss', name ? { name } : {});
    }

    // ---- sessionless: observe --------------------------------------------

    async screenshot(timeoutMs = 15_000): Promise<Buffer> {
        const value = await this.request<string>('GET', '/screenshot', undefined, timeoutMs);
        if (typeof value !== 'string') throw new WdaError('WDA returned an invalid screenshot', 500);
        return Buffer.from(value, 'base64');
    }

    /** The accessibility tree of the frontmost app as JSON. Bounded by `timeoutMs` — busy apps can stall the walk. */
    source(timeoutMs = 8_000): Promise<WdaTreeNode> {
        return this.request<WdaTreeNode>('GET', '/source?format=json', undefined, timeoutMs);
    }

    /** MJPEG server response; the caller owns the body stream. */
    async mjpeg(mjpegUrl: string, signal?: AbortSignal): Promise<Response> {
        const response = await this.fetch(`${mjpegUrl.replace(/\/+$/, '')}/`, signal ? { signal } : {});
        if (!response.ok || !response.body) throw new WdaError(`WDA video stream returned ${response.status}`, response.status);
        return response;
    }

    // ---- sessionless: act (incl. patched routes) --------------------------

    /** Patched route: synthesises a touch path straight through XCTest's daemon, bypassing element lookup. */
    absoluteActions(actions: W3cPointerSource[], timeoutMs = 20_000): Promise<void> {
        return this.request('POST', '/wda/absolute-actions', { actions }, timeoutMs);
    }

    /** Patched to be sessionless; names: home, volumeUp, volumeDown (volume only on real devices). */
    pressButton(name: 'home' | 'volumeUp' | 'volumeDown', durationSeconds?: number): Promise<void> {
        return this.request('POST', '/wda/pressButton', { name, ...(durationSeconds ? { duration: durationSeconds } : {}) });
    }

    /** Patched route: writes a file into Photos. */
    importMedia(name: string, mimeType: string, data: Buffer): Promise<{ localIdentifier: string; assetCount: number }> {
        return this.request('POST', '/wda/import-media', { name, mimeType, data: data.toString('base64') }, 180_000);
    }

    /** Put text / a URL / an image on the phone's clipboard. */
    setPasteboard(content: Buffer | string, contentType: 'plaintext' | 'url' | 'image' = 'plaintext'): Promise<void> {
        const data = typeof content === 'string' ? Buffer.from(content) : content;
        return this.request('POST', '/wda/setPasteboard', { content: data.toString('base64'), contentType }, 30_000);
    }

    /** Read the phone's clipboard (empty buffer when nothing of that type is on it). */
    async getPasteboard(contentType: 'plaintext' | 'url' | 'image' = 'plaintext'): Promise<Buffer> {
        try {
            const value = await this.request<string>('POST', '/wda/getPasteboard', { contentType }, 30_000);
            return Buffer.from(value ?? '', 'base64');
        } catch (error) {
            if (error instanceof WdaError && error.status !== 0) return Buffer.alloc(0);
            throw error;
        }
    }

    setAppearance(name: 'light' | 'dark'): Promise<void> {
        return this.request('POST', '/wda/device/appearance', { name });
    }

    setOrientation(orientation: 'PORTRAIT' | 'LANDSCAPE'): Promise<void> {
        return this.request('POST', '/orientation', { orientation }, 15_000);
    }

    // ---- session-scoped ---------------------------------------------------

    /** Types into whatever has keyboard focus. `frequency` is characters per second. */
    keys(text: string, frequency?: number): Promise<void> {
        return this.sessionPost('/wda/keys', { value: [...text], ...(frequency ? { frequency } : {}) }, 60_000);
    }

    openUrl(url: string, bundleId?: string): Promise<void> {
        return this.sessionPost('/url', { url, ...(bundleId ? { bundleId } : {}) }, 30_000);
    }

    /** Launch (or relaunch) and attach; returns once XCTest sees the app in the foreground. */
    launchApp(bundleId: string, { shouldWaitForQuiescence = false, args, environment }: { shouldWaitForQuiescence?: boolean; args?: string[]; environment?: Record<string, string> } = {}): Promise<void> {
        return this.sessionPost('/wda/apps/launch', {
            bundleId, shouldWaitForQuiescence, ...(args ? { arguments: args } : {}), ...(environment ? { environment } : {}),
        }, 60_000);
    }

    activateApp(bundleId: string): Promise<void> {
        return this.sessionPost('/wda/apps/activate', { bundleId }, 30_000);
    }

    terminateApp(bundleId: string): Promise<boolean> {
        return this.sessionPost<boolean>('/wda/apps/terminate', { bundleId }, 30_000);
    }

    /** XCUIApplicationState: 0 unknown, 1 not running, 2 background suspended, 3 background, 4 foreground. */
    appState(bundleId: string): Promise<number> {
        return this.sessionPost<number>('/wda/apps/state', { bundleId });
    }

    battery(): Promise<WdaBattery> {
        return this.sessionGet<WdaBattery>('/wda/batteryInfo');
    }

    /**
     * Send a real hardware-button event through IOKit HID. XCUIDevice's synthetic
     * `pressButton` only wakes a sleeping phone; a HID "menu" (Home) press behaves like
     * the physical button and is what actually brings up the passcode keypad.
     * Home = page 0x0C usage 0x40; power = page 0x0C usage 0x30.
     */
    performIoHidEvent(page: number, usage: number, durationSeconds = 0.05): Promise<void> {
        return this.sessionPost('/wda/performIoHidEvent', { page, usage, duration: durationSeconds }, 20_000);
    }

    /** Pinch on the frontmost app: scale < 1 zooms out, > 1 zooms in; velocity in scale units per second. */
    pinch(scale: number, velocity: number): Promise<void> {
        return this.sessionPost('/wda/pinch', { scale, velocity }, 20_000);
    }

    dismissKeyboard(keyNames?: string[]): Promise<void> {
        return this.sessionPost('/wda/keyboard/dismiss', keyNames ? { keyNames } : {});
    }

    updateSettings(settings: WdaSessionSettings): Promise<void> {
        return this.sessionPost('/appium/settings', { settings });
    }

    /** Puts back the settings this client was created with, after a temporary `updateSettings`. */
    restoreSettings(): Promise<void> {
        return this.updateSettings(this.settings);
    }
}
