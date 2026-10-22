/**
 * Who a device is. Nothing here is a tap coordinate — screen geometry comes
 * from WDA at runtime (`/wda/screen`) and element positions from the
 * accessibility tree, so any model works without a profile.
 */
export type DeviceKind = 'device' | 'simulator';

export interface DeviceIdentity {
    udid: string;
    kind: DeviceKind;
    name: string;
    /** Apple hardware identifier, e.g. `iPhone15,2`; simulators report their device type instead. */
    productType?: string;
    /** Marketing name, e.g. "iPhone 14 Pro". */
    modelName?: string;
    osVersion?: string;
}

/** ProductType → marketing name (iPhone 6s onwards; an unknown identifier has none). */
const IPHONE_MODELS: Record<string, string> = {
    'iPhone8,1': 'iPhone 6s', 'iPhone8,2': 'iPhone 6s Plus', 'iPhone8,4': 'iPhone SE (1st generation)',
    'iPhone9,1': 'iPhone 7', 'iPhone9,3': 'iPhone 7', 'iPhone9,2': 'iPhone 7 Plus', 'iPhone9,4': 'iPhone 7 Plus',
    'iPhone10,1': 'iPhone 8', 'iPhone10,4': 'iPhone 8',
    'iPhone10,2': 'iPhone 8 Plus', 'iPhone10,5': 'iPhone 8 Plus',
    'iPhone10,3': 'iPhone X', 'iPhone10,6': 'iPhone X',
    'iPhone11,2': 'iPhone XS', 'iPhone11,4': 'iPhone XS Max', 'iPhone11,6': 'iPhone XS Max', 'iPhone11,8': 'iPhone XR',
    'iPhone12,1': 'iPhone 11', 'iPhone12,3': 'iPhone 11 Pro', 'iPhone12,5': 'iPhone 11 Pro Max', 'iPhone12,8': 'iPhone SE (2nd generation)',
    'iPhone13,1': 'iPhone 12 mini', 'iPhone13,2': 'iPhone 12', 'iPhone13,3': 'iPhone 12 Pro', 'iPhone13,4': 'iPhone 12 Pro Max',
    'iPhone14,4': 'iPhone 13 mini', 'iPhone14,5': 'iPhone 13', 'iPhone14,2': 'iPhone 13 Pro', 'iPhone14,3': 'iPhone 13 Pro Max',
    'iPhone14,6': 'iPhone SE (3rd generation)',
    'iPhone14,7': 'iPhone 14', 'iPhone14,8': 'iPhone 14 Plus', 'iPhone15,2': 'iPhone 14 Pro', 'iPhone15,3': 'iPhone 14 Pro Max',
    'iPhone15,4': 'iPhone 15', 'iPhone15,5': 'iPhone 15 Plus', 'iPhone16,1': 'iPhone 15 Pro', 'iPhone16,2': 'iPhone 15 Pro Max',
    'iPhone17,3': 'iPhone 16', 'iPhone17,4': 'iPhone 16 Plus', 'iPhone17,1': 'iPhone 16 Pro', 'iPhone17,2': 'iPhone 16 Pro Max',
    'iPhone17,5': 'iPhone 16e',
    'iPhone18,1': 'iPhone 17 Pro', 'iPhone18,2': 'iPhone 17 Pro Max', 'iPhone18,3': 'iPhone 17', 'iPhone18,4': 'iPhone Air',
};

export function modelNameForProductType(productType: string | undefined): string | undefined {
    if (!productType) return undefined;
    const known = IPHONE_MODELS[productType];
    if (known) return known;
    // Simulator device types: com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro
    const simulator = /SimDeviceType\.(.+)$/.exec(productType);
    if (simulator) return simulator[1]!.replace(/-/g, ' ');
    return undefined;
}

/** Whether the phone has a physical Home button (affects the lock-screen keypad layout fallback). */
export function hasHomeButton(productType: string | undefined): boolean {
    if (!productType) return false;
    return /^iPhone(8,[124]|9,[1234]|10,[1245]|12,8|14,6)$/.test(productType) || /SimDeviceType\.iPhone-(6s|7|8|SE)/.test(productType);
}
