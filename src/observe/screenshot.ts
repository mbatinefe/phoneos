import sharp from 'sharp';

export interface ScaledScreenshot {
    data: Buffer;
    mimeType: 'image/jpeg' | 'image/png';
    width: number;
    height: number;
}

/**
 * WDA screenshots come back at device-pixel resolution (2× / 3×). Scaling
 * them to point dimensions means any coordinate read off the image is a tap
 * coordinate — no scale arithmetic for the reader, and far fewer image tokens.
 */
export async function scaleToPoints(
    png: Buffer,
    screen: { width: number; height: number },
    { format = 'jpeg', quality = 80 }: { format?: 'jpeg' | 'png'; quality?: number } = {},
): Promise<ScaledScreenshot> {
    const pipeline = sharp(png).resize(screen.width, screen.height, { fit: 'fill' });
    const data = format === 'jpeg' ? await pipeline.jpeg({ quality }).toBuffer() : await pipeline.png().toBuffer();
    return { data, mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png', width: screen.width, height: screen.height };
}
