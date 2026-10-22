import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import { z } from 'zod';

import {
    filePath, hasVideoTrack, publishNewFile, readTags, resolveVideoTarget, type Tags,
} from './local-video.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export const normalizeVideoSchema = z.strictObject({
    input_path: filePath.describe('Local MP4, MOV or M4V on this Mac'),
    output_path: filePath.optional().describe('New file, same extension as input. Default: <input-stem>.normalized.<ext>. Never overwrites.'),
    fps: z.number().int().min(1).max(120).default(30).describe('Target constant frame rate. 30 suits vertical social video; 24 often stutters there. The video is only re-encoded when it does not already run at this rate.'),
    ensure_audio: z.boolean().default(true).describe('Add a silent stereo AAC track when the file has no audio at all. Uploads commonly fail or play back muted without one. An existing audio track is copied untouched.'),
    quality: z.number().int().min(0).max(51).default(18).describe('x264 CRF used only when re-encoding: lower is better quality and a bigger file. 18 is visually near-lossless.'),
});

export type NormalizeVideoInput = z.input<typeof normalizeVideoSchema>;

export interface VideoProbe {
    fps: number | null;
    hasAudio: boolean;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
}

export interface NormalizeVideoResult {
    input_path: string;
    output_path: string;
    bytes: number;
    verified: true;
    /** Empty when the input already conformed and the streams were copied as-is. */
    changed: string[];
    before: VideoProbe;
    after: VideoProbe;
    warnings: string[];
}

const AUDIO_TAG = /:Audio(?:Format|Channels|SampleRate|BitsPerSample)$/;

function numberTag(tags: Tags, suffix: string): number | null {
    for (const [key, value] of Object.entries(tags)) {
        if (!key.endsWith(suffix)) continue;
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
}

export function probeTags(tags: Tags): VideoProbe {
    return {
        fps: numberTag(tags, ':VideoFrameRate'),
        hasAudio: Object.keys(tags).some((key) => AUDIO_TAG.test(key)),
        width: numberTag(tags, ':ImageWidth'),
        height: numberTag(tags, ':ImageHeight'),
        durationSeconds: numberTag(tags, ':Duration'),
    };
}

/** Frame rates are reported as floats (23.976 vs 24), so compare with tolerance. */
function sameRate(a: number | null, b: number): boolean {
    return a !== null && Math.abs(a - b) < 0.05;
}

async function ffmpeg(args: string[]): Promise<string> {
    const executable = require('ffmpeg-static') as string | null;
    if (!executable) throw new Error('Video normalization needs the ffmpeg-static dependency. Run npm install.');
    try {
        // ffmpeg writes progress to stderr; only the exit code signals failure.
        const { stderr } = await execFileAsync(executable, ['-nostdin', '-hide_banner', '-loglevel', 'warning', ...args], {
            encoding: 'utf8', timeout: 900_000, maxBuffer: 16 * 1024 * 1024,
        });
        return stderr.trim();
    } catch (error) {
        const detail = error as NodeJS.ErrnoException & { stderr?: string };
        if (detail.code === 'ENOENT') throw new Error('Video normalization needs the ffmpeg-static dependency. Run npm install.');
        const message = (detail.stderr ?? '').trim().split('\n').slice(-4).join('; ');
        throw new Error(`Video normalization failed: ${message || detail.message}`, { cause: error });
    }
}

/**
 * Re-wrap a local video so a social upload accepts it: a constant frame rate and
 * an audio track. Streams that already conform are copied, not re-encoded, so
 * this is lossless whenever it can be. Always writes a new file; the source and
 * its existing metadata are left alone.
 *
 * This deliberately does not strip encoder traces or rewrite capture provenance
 * — see docs/video-metadata.md.
 */
export async function normalizeVideo(input: NormalizeVideoInput): Promise<NormalizeVideoResult> {
    const checked = normalizeVideoSchema.parse(input);
    const target = await resolveVideoTarget(checked, { defaultSuffix: 'normalized', subject: 'Video normalization' });
    const source = await readTags(target.source);
    if (!hasVideoTrack(source.tags)) throw new Error('Input must contain a video track in an MP4, MOV or M4V container');
    const before = probeTags(source.tags);

    const needsFps = !sameRate(before.fps, checked.fps);
    const needsAudio = checked.ensure_audio && !before.hasAudio;
    const changed = [
        ...(needsFps ? [`frame rate ${before.fps ?? 'unknown'} → ${checked.fps} fps (video re-encoded, CRF ${checked.quality})`] : []),
        ...(needsAudio ? ['silent stereo AAC track added'] : []),
    ];

    const { produced, bytes } = await publishNewFile(target, '.phoneos-video-normalize-', async (workingFile) => {
        const args = ['-i', target.source];
        // anullsrc is an infinite source, so -shortest ends the file with the video.
        if (needsAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
        args.push('-map', '0:v:0');
        if (needsAudio) args.push('-map', '1:a:0', '-shortest');
        else if (before.hasAudio) args.push('-map', '0:a');
        args.push(...(needsFps
            ? ['-c:v', 'libx264', '-crf', String(checked.quality), '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', String(checked.fps)]
            : ['-c:v', 'copy']));
        args.push(...(needsAudio ? ['-c:a', 'aac', '-b:a', '128k'] : before.hasAudio ? ['-c:a', 'copy'] : []));
        // Keep the container's own metadata; faststart puts the index up front for streaming.
        args.push('-map_metadata', '0', '-movflags', '+faststart', workingFile);
        const stderr = await ffmpeg(args);
        const after = await readTags(workingFile);
        return { probe: probeTags(after.tags), warnings: [stderr, ...after.warnings] };
    });

    const after = produced.probe;
    if (!sameRate(after.fps, checked.fps)) throw new Error(`Frame rate readback is ${after.fps ?? 'unknown'}, expected ${checked.fps}`);
    if (checked.ensure_audio && !after.hasAudio) throw new Error('Audio track readback is missing');
    if (before.width !== after.width || before.height !== after.height) {
        throw new Error(`Dimensions changed from ${before.width}x${before.height} to ${after.width}x${after.height}`);
    }
    if (before.durationSeconds !== null && after.durationSeconds !== null && Math.abs(before.durationSeconds - after.durationSeconds) > 0.5) {
        throw new Error(`Duration changed from ${before.durationSeconds}s to ${after.durationSeconds}s`);
    }

    return {
        input_path: target.source, output_path: target.destination, bytes, verified: true, changed, before, after,
        warnings: [...new Set([...source.warnings, ...produced.warnings,
            ...(changed.length ? [] : ['Input already conformed; streams were copied without re-encoding.']),
            'Re-encoding is lossy where it happens; keep the original as the master copy.',
        ].filter(Boolean))],
    };
}
