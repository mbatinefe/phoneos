export interface ElementFrame { x: number; y: number; width: number; height: number }

export interface SnapshotElement {
    /**
     * `e1`, `e2`, … in the element tree's order. An element still on screen keeps its id in
     * the next observation (see diff.ts).
     */
    id: string;
    /** WDA short type: Button, TextField, Cell, StaticText, Switch, Image, … */
    type: string;
    label?: string;
    name?: string;
    value?: string;
    /** The app's accessibilityIdentifier, when set — the most stable handle. */
    identifier?: string;
    /** In points, top-left origin. */
    frame: ElementFrame;
    enabled: boolean;
    focused: boolean;
    /** Ancestry of meaningful containers, e.g. "NavigationBar > Cell". */
    path: string;
    /** Buttons, fields, cells, switches… — things a person would tap. */
    interactive: boolean;
}

export interface AlertSummary {
    title?: string;
    text?: string;
    buttons: string[];
}

export interface ScreenGeometry {
    width: number;
    height: number;
    scale: number;
    orientation: 'portrait' | 'landscape';
}

export interface ActiveApp {
    bundleId: string;
    name: string;
    pid: number;
}

export interface DeviceState {
    locked: boolean;
    /** `null` when the home screen / SpringBoard is in front. */
    activeApp: ActiveApp | null;
    screen: ScreenGeometry;
    keyboardVisible: boolean;
    alert: AlertSummary | null;
    battery?: { level: number; state: 'unknown' | 'unplugged' | 'charging' | 'full' };
    takenAt: string;
}

export type TreeStatus = 'ok' | 'timeout' | 'unavailable' | 'skipped';

export interface Snapshot {
    state: DeviceState;
    elements: SnapshotElement[];
    treeStatus: TreeStatus;
    /** Scaled to points (so coordinates map 1:1): when asked for, or when the tree was empty or could not be read. */
    screenshot?: { data: Buffer; mimeType: 'image/jpeg' | 'image/png'; width: number; height: number };
}
