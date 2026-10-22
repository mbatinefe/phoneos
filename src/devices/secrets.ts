import { loadRegisteredDevices, saveRegisteredDevices, PASSCODE_PATTERN } from './registry.js';

/** A device's unlock passcode, from `devices.json` only — never the environment. */
export async function passcodeForDevice(udid: string): Promise<string | undefined> {
    const device = (await loadRegisteredDevices()).find((entry) => entry.udid === udid);
    return device?.passcode || undefined;
}

/** Set (or replace) a registered device's passcode in `devices.json`. */
export async function setDevicePasscode(udid: string, passcode: string): Promise<void> {
    if (!PASSCODE_PATTERN.test(passcode)) throw new Error('Device passcode must contain at least four digits');
    const devices = await loadRegisteredDevices();
    const device = devices.find((entry) => entry.udid === udid);
    if (!device) throw new Error(`Device ${udid} is not registered`);
    device.passcode = passcode;
    await saveRegisteredDevices(devices);
}
