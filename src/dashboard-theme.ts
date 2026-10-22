import { fileURLToPath } from 'node:url';

import type { DashboardTheme } from './api/app.js';

export const defaultDashboardTheme: DashboardTheme = {
    rootDirectory: fileURLToPath(new URL('../static/dashboard/', import.meta.url)),
};
