import { createRequire } from 'node:module';
import net from 'node:net';

const require = createRequire(import.meta.url);
const { utilities } = require('appium-ios-device') as {
    utilities: { connectPort(udid: string, port: number): Promise<net.Socket> };
};

export interface PortForward {
    localPort: number;
    devicePort: number;
    close(): Promise<void>;
}

/**
 * USB port forwarding over usbmuxd: every TCP connection to
 * 127.0.0.1:localPort becomes a connection to devicePort on the phone. This
 * is what lets WDA (:8100) and its MJPEG server (:9100) be reached from the Mac.
 */
export async function forwardDevicePort(udid: string, localPort: number, devicePort: number): Promise<PortForward> {
    const server = net.createServer((client) => {
        client.on('error', () => client.destroy());
        void utilities.connectPort(udid, devicePort).then((remote) => {
            remote.on('error', () => client.destroy());
            client.on('close', () => remote.destroy());
            remote.on('close', () => client.destroy());
            client.pipe(remote);
            remote.pipe(client);
        }).catch(() => client.destroy());
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(localPort, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    return {
        localPort,
        devicePort,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
