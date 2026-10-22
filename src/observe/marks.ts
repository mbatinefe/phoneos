import sharp from 'sharp';

import type { SnapshotElement } from './types.js';

/**
 * Element ids drawn onto the screenshot ("set-of-marks"). A model that sees `e12`
 * printed on a button taps `element_id=e12` instead of estimating its pixels, which
 * is where vision models go wrong: by tens of points on small controls.
 */

// Saturated colours that keep white text readable; neighbours get different ones.
const PALETTE = ['#d7263d', '#1b998b', '#2e5eaa', '#f46036', '#7b2cbf', '#0a8754', '#c2185b', '#5d4037'];
const LABEL_HEIGHT = 13;
const CHAR_WIDTH = 6.4;

/** What gets a mark: things a person taps, but not the keyboard's keys, which would bury the screen. */
export function markableElements(elements: readonly SnapshotElement[]): SnapshotElement[] {
    return elements.filter((element) => element.interactive && element.type !== 'Key' && element.frame.width >= 4 && element.frame.height >= 4);
}

function escapeXml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character] ?? character);
}

/** The overlay as SVG, in points (the screenshot is already scaled to points). */
export function marksSvg(elements: readonly SnapshotElement[], size: { width: number; height: number }): string {
    const shapes: string[] = [];
    const placed: Array<{ x: number; y: number; width: number }> = [];
    markableElements(elements).forEach((element, index) => {
        const color = PALETTE[index % PALETTE.length]!;
        const { x, y, width, height } = element.frame;
        shapes.push(`<rect x="${x + 0.75}" y="${y + 0.75}" width="${Math.max(0, width - 1.5)}" height="${Math.max(0, height - 1.5)}" fill="none" stroke="${color}" stroke-width="1.5" rx="2"/>`);
        const labelWidth = Math.ceil(element.id.length * CHAR_WIDTH + 6);
        // Inside the top-left corner when the element is tall enough, else just above it.
        const labelX = Math.min(Math.max(0, x), size.width - labelWidth);
        let labelY = height >= LABEL_HEIGHT + 4 ? y + 1 : y - LABEL_HEIGHT;
        if (labelY < 0) labelY = y + height;
        // Step down past labels already there, so two ids do not print on top of each other.
        const overlaps = () => placed.some((other) => Math.abs(other.y - labelY) < LABEL_HEIGHT && labelX < other.x + other.width && other.x < labelX + labelWidth);
        for (let step = 0; step < 6 && overlaps(); step += 1) labelY += LABEL_HEIGHT;
        labelY = Math.min(labelY, size.height - LABEL_HEIGHT);
        placed.push({ x: labelX, y: labelY, width: labelWidth });
        shapes.push(`<rect x="${labelX}" y="${labelY}" width="${labelWidth}" height="${LABEL_HEIGHT}" fill="${color}" rx="2"/>`);
        shapes.push(`<text x="${labelX + 3}" y="${labelY + LABEL_HEIGHT - 3}" font-family="Helvetica, Arial, sans-serif" font-size="11" font-weight="bold" fill="#ffffff">${escapeXml(element.id)}</text>`);
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">${shapes.join('')}</svg>`;
}

/** The screenshot with every markable element boxed and labelled with its id. */
export async function markScreenshot(
    image: Buffer,
    size: { width: number; height: number },
    elements: readonly SnapshotElement[],
    format: 'image/jpeg' | 'image/png' = 'image/jpeg',
): Promise<Buffer> {
    const overlay = Buffer.from(marksSvg(elements, size));
    const composed = sharp(image).composite([{ input: overlay, top: 0, left: 0 }]);
    return format === 'image/png' ? composed.png().toBuffer() : composed.jpeg({ quality: 80 }).toBuffer();
}
