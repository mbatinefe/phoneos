import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';

import type { DeviceIdentity } from './device/identity.js';
import type {
    JsonObject,
    JsonValue,
    StoredAsset,
    TaskExecutionResult,
    TaskRetryPolicy,
} from './types.js';
import type { SchedulerRepository } from './scheduler/repository.js';
import type { RegisteredDevice } from './devices/registry.js';
import type { RemoteControl } from './devices/wda-remote.js';
import type { DeviceDriver } from './device/driver.js';
import type { HumanProfile, Point } from './humanize/humanizer.js';

export interface TaskValidationContext {
    timingKind: 'now' | 'once' | 'daily' | 'weekly';
    devicePluginData: JsonObject;
}

export interface TaskExecutionContext {
    executionId: string;
    attempt: number;
    workspaceDirectory: string;
    device: DeviceIdentity;
    registeredDevice: RegisteredDevice;
    devicePluginData: JsonObject;
    /** The device, unlocked-on-demand, with every gesture humanised. */
    driver: DeviceDriver;
    assets: StoredAsset[];
    signal: AbortSignal;
    log(line: string): Promise<void>;
    runProcess(specification: PluginProcessSpecification): Promise<TaskExecutionResult>;
    /** One of this pack's named points on this device's screen (its override, if it has one). */
    point(name: string): Promise<Point>;
}

export interface PluginProcessSpecification {
    entrypoint: string;
    args?: string[];
    env?: Record<string, string>;
}

/**
 * One input on the dashboard's "new schedule" form. A task that declares its fields gets a
 * real form for free — including tasks added later by your own app pack — instead of forcing
 * the user to hand-write JSON. `validate()` is still the authority; this is only the UI.
 */
export interface TaskField {
    name: string;
    label: string;
    type: 'text' | 'textarea' | 'number' | 'boolean' | 'select';
    /** Pre-filled value. */
    default?: JsonValue;
    /** For `select`. */
    options?: ReadonlyArray<{ value: string; label: string }>;
    /** For `select`: also offer values from this device's `pluginData` key (e.g. `usernames`). */
    optionsFromPluginData?: string;
    min?: number;
    max?: number;
    required?: boolean;
    help?: string;
}

export interface TaskDefinition<TPayload extends JsonObject = JsonObject> {
    type: string;
    version: number;
    displayName: string;
    /** Optional form description for the dashboard. Omit for tasks that need their own UI (file uploads etc.). */
    fields?: readonly TaskField[];
    validate(payload: JsonValue, context: TaskValidationContext): TPayload;
    summarize(payload: TPayload): string;
    estimateDurationMs(payload: TPayload): number;
    retryPolicy(payload: TPayload): TaskRetryPolicy;
    supportsStop(payload: TPayload): boolean;
    execute(context: TaskExecutionContext, payload: TPayload): Promise<TaskExecutionResult>;
}

export interface RegistrationCheckResult {
    status: 'passed' | 'blocked' | 'failed';
    message: string;
}

export interface RegistrationCheckContext {
    /** Present when WDA is reachable, so a check can look at the screen. */
    driver?: DeviceDriver;
    log?(line: string): void;
}

export interface RegistrationCheck {
    id: string;
    displayName: string;
    run(device: DeviceIdentity, pluginData: JsonObject, context?: RegistrationCheckContext): Promise<RegistrationCheckResult>;
}

export interface DevicePanel {
    id: string;
    title: string;
    fragmentPath: string;
    scriptPath?: string;
    order?: number;
}

/** A link a plugin contributes to the dashboard's top navigation. */
export interface PluginNavLink {
    label: string;
    href: string;
    order?: number;
}

export interface PluginRouteContext {
    app: FastifyInstance;
    routePrefix: string;
    scheduler: SchedulerRepository;
    remote: RemoteControl;
    loadDevices(): Promise<RegisteredDevice[]>;
    saveDevices(devices: RegisteredDevice[]): Promise<void>;
    /** Load → mutate → save devices.json atomically under the shared in-process lock. Prefer this over load+saveDevices. */
    mutateDevices<T>(mutate: (devices: RegisteredDevice[]) => T | Promise<T>): Promise<T>;
    renderActivity(deviceUdid: string, message?: string): Promise<string>;
}

/** What a macro runs with: the device driver plus the device's stored config for this pack. */
export interface MacroContext {
    driver: DeviceDriver;
    device: RegisteredDevice;
    pluginData: JsonObject;
    log(line: string): void;
    signal?: AbortSignal;
    /** Resolves a path the macro will write on this Mac, refusing one outside the folder it may write in. */
    outputPath?(requested: string): string;
    /** One of this pack's named points on this device's screen (its override, if it has one). */
    point(name: string): Promise<Point>;
}

/** A spot on screen as fractions of its width and height, for a control the app does not expose as an element. */
export interface NamedPoint {
    fx: number;
    fy: number;
    /** What is there, for people: "Like button". */
    label: string;
}

/**
 * A deterministic, humanised flow an app pack exposes to agents as a tool
 * (e.g. `settings_open`). Runs in the agent-interface process.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMacroDefinition = MacroDefinition<any>;

export interface MacroDefinition<TInput = Record<string, unknown>> {
    /** Tool name suffix; the pack's short id is prefixed automatically. */
    name: string;
    description: string;
    /** zod object schema for the input (also becomes the MCP tool schema). */
    input: ZodType<TInput>;
    run(context: MacroContext, input: TInput): Promise<JsonValue | string | void>;
}

/**
 * A plugin — or, when it declares a `bundleId`, an *app pack*: scheduled
 * tasks, dashboard panels, routes and registration checks as before, plus a
 * guide the agent reads while that app is in front and macros it can call.
 */
export interface PhoneosPlugin {
    id: string;
    version: string;
    displayName: string;
    tasks: readonly TaskDefinition[];
    /** The app this pack is about. Guide + macros surface when it is the active app. */
    bundleId?: string;
    /** Short handle used to prefix macro tool names, e.g. `settings`. Defaults to the last id segment. */
    shortId?: string;
    /** Markdown file: what the app looks like, its screens, gotchas. Injected into the agent's context. */
    guidePath?: string;
    /** Gesture profile for this pack's own macros and scheduled tasks (a session's `--precise`/`--relaxed` still wins). */
    humanProfile?: HumanProfile;
    macros?: readonly AnyMacroDefinition[];
    /**
     * Named points for controls the app does not expose as elements, as screen fractions.
     * Macros and tasks get them with `context.point(name)`; a device can override any of
     * them (`devices.json` → `coordinates` → `<shortId>.<name>`).
     */
    points?: Readonly<Record<string, NamedPoint>>;
    navLinks?: readonly PluginNavLink[];
    devicePanels?: readonly DevicePanel[];
    registrationChecks?: readonly RegistrationCheck[];
    registerRoutes?(context: PluginRouteContext): Promise<void> | void;
}

export type AppPack = PhoneosPlugin;

export interface AuthenticatedUser {
    id: string;
    email?: string;
    roles: string[];
}

export interface AuthProvider {
    id: string;
    registerRoutes(app: FastifyInstance): Promise<void> | void;
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedUser | null>;
    isPublicPath(path: string): boolean;
    /** Path a "Log out" link points at, e.g. "/auth/logout". Omit to hide the link. */
    logoutPath?: string;
}

export function pluginShortId(plugin: Pick<PhoneosPlugin, 'id' | 'shortId'>): string {
    return plugin.shortId ?? plugin.id.split('.').pop() ?? plugin.id;
}
