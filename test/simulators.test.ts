import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultDeviceType } from '../src/devices/simulators.js';

const type = (name: string) => ({ name, identifier: `com.apple.CoreSimulator.SimDeviceType.${name.replace(/ /g, '-')}` });

test('a new simulator is the newest iPhone Pro Xcode offers', () => {
    const chosen = defaultDeviceType([type('iPhone 16'), type('iPhone 17'), type('iPhone 17 Pro Max'), type('iPhone 17 Pro'), type('iPad Pro 13-inch (M5)'), type('iPhone SE (3rd generation)')]);
    assert.equal(chosen?.name, 'iPhone 17 Pro');
});

test('without a Pro, the newest iPhone; without numbered iPhones, any iPhone', () => {
    assert.equal(defaultDeviceType([type('iPhone 15'), type('iPhone 16e')])?.name, 'iPhone 16e');
    assert.equal(defaultDeviceType([type('iPad Air 11-inch (M4)'), type('iPhone SE (3rd generation)')])?.name, 'iPhone SE (3rd generation)');
    assert.equal(defaultDeviceType([type('iPad mini (A17 Pro)')]), undefined);
});
