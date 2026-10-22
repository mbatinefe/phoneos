import type { PhoneosPlugin, TaskDefinition } from './plugin.js';
import type { JsonObject, JsonValue } from './types.js';

interface OpenAppPayload extends JsonObject {
    bundleId: string;
    waitSeconds: number;
}

const openAppTask: TaskDefinition<OpenAppPayload> = {
    type: 'open-app',
    version: 1,
    displayName: 'Open an installed app',
    fields: [
        { name: 'bundleId', label: 'App bundle id', type: 'text', default: 'com.apple.Preferences', required: true, help: 'e.g. com.apple.mobilesafari' },
        { name: 'waitSeconds', label: 'Keep it open for (seconds)', type: 'number', default: 10, min: 1, max: 300, required: true },
    ],
    validate(value: JsonValue): OpenAppPayload {
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Payload must be an object');
        const bundleId = value.bundleId;
        const waitSeconds = value.waitSeconds;
        if (typeof bundleId !== 'string' || !/^[A-Za-z0-9.-]{3,255}$/.test(bundleId)) {
            throw new Error('bundleId must be a valid application identifier');
        }
        if (!Number.isInteger(waitSeconds) || typeof waitSeconds !== 'number' || waitSeconds < 1 || waitSeconds > 300) {
            throw new Error('waitSeconds must be an integer between 1 and 300');
        }
        return { bundleId, waitSeconds };
    },
    summarize: (payload) => `Open ${payload.bundleId} for ${payload.waitSeconds} seconds`,
    estimateDurationMs: (payload) => payload.waitSeconds * 1_000,
    retryPolicy: () => ({ retryLimit: 1, retryDelaySeconds: 30, retryBackoff: false }),
    supportsStop: () => true,
    async execute(context, payload) {
        try {
            await context.log(`Opening ${payload.bundleId}`);
            await context.driver.unlock();
            await context.driver.openApp(payload.bundleId);
            const deadline = Date.now() + payload.waitSeconds * 1_000;
            while (Date.now() < deadline && !context.signal.aborted) {
                await context.driver.wait(Math.min(2_000, deadline - Date.now()));
            }
            return { exitCode: 0, stopped: context.signal.aborted };
        } catch (error) {
            if (context.signal.aborted) return { exitCode: null, stopped: true };
            return { exitCode: null, stopped: false, error: error instanceof Error ? error.message : String(error) };
        }
    },
};

export const examplePlugin: PhoneosPlugin = {
    id: 'com.phoneos.example',
    version: '0.1.0',
    displayName: 'Example app launcher',
    tasks: [openAppTask],
};

export default examplePlugin;
