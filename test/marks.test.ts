import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { markableElements, markScreenshot, marksSvg } from '../src/observe/marks.js';
import type { SnapshotElement } from '../src/observe/types.js';

function element(id: string, frame: SnapshotElement['frame'], overrides: Partial<SnapshotElement> = {}): SnapshotElement {
    return { id, type: 'Button', label: id, frame, enabled: true, focused: false, path: '', interactive: true, ...overrides };
}

test('tappable elements get a mark; text, keyboard keys and specks do not', () => {
    const marked = markableElements([
        element('e1', { x: 10, y: 10, width: 80, height: 30 }),
        element('e2', { x: 10, y: 50, width: 80, height: 20 }, { type: 'StaticText', interactive: false }),
        element('e3', { x: 10, y: 80, width: 30, height: 40 }, { type: 'Key' }),
        element('e4', { x: 10, y: 130, width: 2, height: 2 }),
    ]);
    assert.deepEqual(marked.map((entry) => entry.id), ['e1']);
});

test('the id is printed on the element, in its own colour, readable in the image', async () => {
    const size = { width: 120, height: 100 };
    const white = await sharp({ create: { width: size.width, height: size.height, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const marked = await markScreenshot(white, size, [element('e7', { x: 10, y: 10, width: 80, height: 40 })], 'image/png');
    const { data, info } = await sharp(marked).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
    // Inside the label's coloured background, left of where the text starts.
    const label = pixel(11, 14);
    assert.notDeepEqual(label, [255, 255, 255]);
    assert.ok(label[0]! > 150 && label[1]! < 100, `expected the first palette colour (red), got ${label}`);
    // The middle of the button is left alone, so the content still shows through.
    assert.deepEqual(pixel(60, 40), [255, 255, 255]);
});

test('labels that would land on each other are stacked', () => {
    const svg = marksSvg([
        element('e1', { x: 20, y: 20, width: 100, height: 40 }),
        element('e2', { x: 22, y: 21, width: 100, height: 40 }),
    ], { width: 390, height: 844 });
    const labelYs = [...svg.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="\d+" height="13"/g)].map((match) => Number(match[1]));
    assert.equal(labelYs.length, 2);
    assert.ok(Math.abs(labelYs[0]! - labelYs[1]!) >= 13, `labels at ${labelYs.join(', ')} overlap`);
});

test('a label never leaves the screen', () => {
    const svg = marksSvg([element('e123', { x: 380, y: 835, width: 10, height: 9 })], { width: 390, height: 844 });
    const [, x, y, width] = /<rect x="([\d.]+)" y="([\d.]+)" width="(\d+)" height="13"/.exec(svg)!.map(Number);
    assert.ok(x! + width! <= 390 && y! + 13 <= 844, `label at ${x},${y} width ${width}`);
});
