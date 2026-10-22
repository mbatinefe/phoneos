/** Dashboard-facing action vocabulary (what the live-screen page posts). */
export type RemoteAction =
    | { type: 'tap'; x: number; y: number }
    | { type: 'home' }
    | { type: 'lock' }
    | { type: 'wake' }
    | { type: 'unlock' }
    | { type: 'volumeUp' }
    | { type: 'volumeDown' }
    | { type: 'swipe'; startX: number; startY: number; endX: number; endY: number; durationMs: number };

export interface ScreenInfo {
    screenSize: { width: number; height: number };
    scale: number;
}

export interface RemoteControl {
    getScreenInfo(udid: string): Promise<ScreenInfo>;
    getScreenshot(udid: string): Promise<Buffer>;
    /** `signal` should be tied to the client request so the upstream device stream closes when the viewer leaves. */
    getMjpegStream(udid: string, signal?: AbortSignal): Promise<Response>;
    performAction(udid: string, action: RemoteAction): Promise<void>;
    isLocked(udid: string): Promise<boolean>;
    /** Drop any cached client for this device so its next use re-reads devices.json. */
    forget?(udid: string): void;
}
