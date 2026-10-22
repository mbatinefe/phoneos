import { DeviceFleet } from '../device/fleet.js';
import type { RemoteAction, RemoteControl, ScreenInfo } from './wda-remote.js';

/** RemoteControl over the shared fleet: one driver per registered device, rebuilt after `forget()`. */
export class RegistryWdaRemoteControl implements RemoteControl {
    constructor(readonly fleet: DeviceFleet = new DeviceFleet()) {}

    forget(udid: string): void {
        this.fleet.forget(udid);
    }

    async getScreenInfo(udid: string): Promise<ScreenInfo> {
        const screen = await (await this.fleet.driver(udid)).screen();
        return { screenSize: { width: screen.width, height: screen.height }, scale: screen.scale };
    }

    async getScreenshot(udid: string): Promise<Buffer> {
        return (await this.fleet.driver(udid)).rawScreenshot();
    }

    async getMjpegStream(udid: string, signal?: AbortSignal): Promise<Response> {
        return (await this.fleet.driver(udid)).mjpegStream(signal);
    }

    async isLocked(udid: string): Promise<boolean> {
        return (await this.fleet.driver(udid)).client.locked();
    }

    async performAction(udid: string, action: RemoteAction): Promise<void> {
        const driver = await this.fleet.driver(udid);
        switch (action.type) {
            case 'tap': await driver.tap({ x: action.x, y: action.y }); return;
            case 'swipe': await driver.swipe({ from: { x: action.startX, y: action.startY }, to: { x: action.endX, y: action.endY }, intent: 'flick', durationMs: action.durationMs }); return;
            case 'home': await driver.home(); return;
            case 'lock': await driver.pressButton('lock'); return;
            case 'wake': await driver.client.unlock().catch(() => undefined); return;
            case 'unlock': await driver.unlock(); return;
            case 'volumeUp': case 'volumeDown': await driver.pressButton(action.type); return;
            default: throw new Error(`Unknown remote action ${String((action as { type: string }).type)}`);
        }
    }
}
