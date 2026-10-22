import type { Point } from '../humanize/humanizer.js';

/**
 * Where the keys of the iOS on-screen keyboard sit, for writing text one key tap at a
 * time. Lower-case QWERTY in portrait. Only measured screens are listed, because a
 * guessed row height taps the wrong key: 390×844 (iOS 26) and 414×736 (iOS 15), each
 * checked by writing words, searches and hashtags with it.
 */
const LAYOUTS: Record<string, { rows: ReadonlyArray<readonly [letters: string, firstX: number, y: number]>; step: number; space: Point }> = {
    '390x844': { rows: [['qwertyuiop', 26, 582], ['asdfghjkl', 43, 635], ['zxcvbnm', 81, 690]], step: 38, space: { x: 195, y: 743 } },
    '414x736': { rows: [['qwertyuiop', 22, 540], ['asdfghjkl', 43, 597], ['zxcvbnm', 84, 653]], step: 41, space: { x: 228, y: 708 } },
};

/** The key centre for every character of `text`, or an error naming what cannot be written this way. */
export function keyPoints(text: string, screen: { width: number; height: number }): Point[] {
    const layout = LAYOUTS[`${screen.width}x${screen.height}`];
    if (!layout) throw new Error(`The on-screen keyboard has not been measured on a ${screen.width}×${screen.height} screen. Tap the keys one by one from a screenshot instead.`);
    const keys = new Map<string, Point>([[' ', layout.space]]);
    for (const [letters, firstX, y] of layout.rows) [...letters].forEach((letter, index) => keys.set(letter, { x: firstX + index * layout.step, y }));
    const missing = [...new Set([...text].filter((character) => !keys.has(character)))];
    if (missing.length) throw new Error(`No key for ${missing.map((character) => JSON.stringify(character)).join(', ')}: tap-keys writes lower-case letters and spaces. Capitals, digits, punctuation and emoji are tapped by sight (shift, the 123 key, the emoji key).`);
    return [...text].map((character) => keys.get(character)!);
}
