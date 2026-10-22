import http from 'node:http';

import type { DeviceConnectionStatus } from './connection-manager.js';
import { wdaServiceSocketPath, type WdaServiceDevicesResponse } from './wda-service-protocol.js';

export interface ServiceResponse {
    statusCode: number;
    body: string;
}

export function requestWdaService(
    pathname: string,
    options: { socketPath?: string; method?: 'GET' | 'POST'; timeoutMs?: number } = {},
): Promise<ServiceResponse> {
    return new Promise((resolve, reject) => {
        const request = http.request({
            socketPath: options.socketPath ?? wdaServiceSocketPath(),
            path: pathname,
            method: options.method ?? 'GET',
        }, (response) => {
            response.setEncoding('utf8');
            let body = '';
            response.on('data', (chunk: string) => { body += chunk; });
            response.once('end', () => resolve({ statusCode: response.statusCode ?? 0, body }));
        });
        request.setTimeout(options.timeoutMs ?? 2_000, () => {
            request.destroy(new Error('WDA service request timed out'));
        });
        request.once('error', reject);
        request.end();
    });
}


/** Per-device supervisor status from the running wda-service, or `undefined` when it is not reachable. */
export async function wdaServiceStatuses(timeoutMs = 2_000): Promise<DeviceConnectionStatus[] | undefined> {
    try {
        const response = await requestWdaService('/devices', { timeoutMs });
        if (response.statusCode < 200 || response.statusCode >= 300) return undefined;
        return (JSON.parse(response.body) as WdaServiceDevicesResponse).devices;
    } catch {
        return undefined;
    }
}
