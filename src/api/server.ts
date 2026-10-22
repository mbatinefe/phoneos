import type { AddressInfo } from 'node:net';

import type { AuthProvider, PhoneosPlugin } from '../plugin.js';
import { loadAuthProvider } from '../loader.js';
import { loadAllPlugins } from '../apps/loader.js';
import { PluginRegistry } from '../registry.js';
import { createSchedulerRuntime } from '../scheduler/runtime.js';
import { unavailableScheduler } from '../scheduler/unavailable.js';
import { assertSafeBind } from '../security.js';
import { defaultDashboardTheme } from '../dashboard-theme.js';
import { DeviceRegistrationService } from '../devices/registration.js';
import { createApp, type DashboardTheme } from './app.js';

export interface StartServerOptions {
    plugins?: readonly PhoneosPlugin[];
    authProvider?: AuthProvider | null;
    host?: string;
    port?: number;
    dashboardTheme?: DashboardTheme;
}

export async function defaultPlugins(): Promise<PhoneosPlugin[]> {
    return loadAllPlugins();
}

export async function startServer(options: StartServerOptions = {}) {
    const loadedPlugins = options.plugins ?? await defaultPlugins();
    const authProvider = options.authProvider === undefined
        ? await loadAuthProvider(process.env.PHONEOS_AUTH_PLUGIN)
        : options.authProvider;
    const host = options.host ?? process.env.WEB_HOST ?? '127.0.0.1';
    const port = options.port ?? Number(process.env.WEB_PORT ?? 3000);
    assertSafeBind(host, authProvider);
    const plugins = new PluginRegistry(loadedPlugins);
    // The dashboard is useful without a database (live screen, registration, agent
    // tools); only scheduling needs PostgreSQL. Degrade instead of refusing to start.
    let scheduler: Awaited<ReturnType<typeof createSchedulerRuntime>>;
    try {
        scheduler = await createSchedulerRuntime(plugins);
    } catch (error) {
        const reason = error instanceof Error ? error.message.split('\n')[0] ?? 'database unreachable' : String(error);
        console.warn(`[phoneos] scheduler disabled — ${reason}`);
        scheduler = { repository: unavailableScheduler(reason), async close() {} };
    }
    const registrations = new DeviceRegistrationService({ plugins: loadedPlugins });
    await registrations.start();
    const app = await createApp({
        plugins, scheduler: scheduler.repository, authProvider,
        dashboardTheme: options.dashboardTheme ?? defaultDashboardTheme, registrations, logger: true,
    });
    await app.listen({ host, port });
    const address = app.server.address() as AddressInfo;
    console.log(`phoneos listening on http://${host}:${address.port} (${loadedPlugins.map((plugin) => plugin.id).join(', ') || 'no plugins'})`);
    return {
        app, plugins,
        async close() { await app.close(); await registrations.close(); await scheduler.close(); },
    };
}

async function main(): Promise<void> {
    const runtime = await startServer();
    // Exit once closed, rather than wait for every open handle (live screen streams, timers) to end.
    const shutdown = async () => { await runtime.close(); process.exit(0); };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) await main();
