import { copyFile } from 'node:fs/promises';

import { z } from 'zod';

import {
    exiftool, filePath, hasVideoTrack, publishNewFile, readTags, resolveVideoTarget, type Tags,
} from './local-video.js';

const text = z.string().min(1).max(4096).refine((value) => !value.includes('\0') && value.trim().length > 0, 'Must be non-empty text without NUL characters');

export const videoMetadataSchema = z.strictObject({
    make: text.max(256).optional().describe('Camera manufacturer label, e.g. Apple. Does not establish camera provenance.'),
    model: text.max(256).optional().describe('Camera model label; no device is inferred automatically.'),
    software: text.max(256).optional().describe('Editing/capture software label, not the encoded stream codec.'),
    creation_time: z.iso.datetime({ offset: true }).optional().describe('ISO 8601 date with an explicit timezone, e.g. 2026-09-18T12:00:00-05:00. Fractional seconds are accepted and dropped; QuickTime stores whole seconds.'),
    title: text.optional(),
    description: text.optional(),
    author: text.optional(),
    copyright: text.optional(),
    comment: text.optional(),
    location: z.strictObject({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        altitude: z.number().min(-12000).max(100000).optional().describe('Metres above sea level'),
    }).optional().describe('Optional GPS coordinates. Only supply a location you intend to disclose.'),
}).refine((value) => Object.values(value).some((entry) => entry !== undefined), 'Supply at least one metadata field');

export const addVideoMetadataSchema = z.strictObject({
    input_path: filePath.describe('Local MP4, MOV or M4V on this Mac'),
    output_path: filePath.optional().describe('New file, same extension as input. Default: <input-stem>.metadata.<ext>. Never overwrites.'),
    metadata: videoMetadataSchema,
});

export type AddVideoMetadataInput = z.input<typeof addVideoMetadataSchema>;
export type VideoMetadata = z.infer<typeof videoMetadataSchema>;

export interface VideoMetadataResult {
    input_path: string;
    output_path: string;
    bytes: number;
    verified: true;
    written_tags: Record<string, string>;
    readback: Tags;
    warnings: string[];
}

/** Fixed tag allowlist: callers cannot inject ExifTool options, expressions or file reads. */
export function videoMetadataTags(metadata: VideoMetadata): Record<string, string> {
    const checked = videoMetadataSchema.parse(metadata);
    const tags: Record<string, string> = {};
    const fields = { make: 'Make', model: 'Model', software: 'Software', title: 'Title', description: 'Description', author: 'Author', copyright: 'Copyright', comment: 'Comment' } as const;
    for (const [field, tag] of Object.entries(fields)) {
        const value = checked[field as keyof typeof fields];
        if (value !== undefined) tags[`Keys:${tag}`] = value;
    }
    if (checked.creation_time) {
        // String-based Apple capture date retains its offset. Integer movie/track
        // headers are UTC (QuickTimeUTC=1); filesystem dates are not falsified.
        // QuickTime stores whole seconds, and `new Date().toISOString()` — the likeliest
        // input a caller produces — carries milliseconds, so drop them here.
        const stamp = checked.creation_time.replace(/\.\d+(?=Z$|[+-]\d{2}:\d{2}$)/, '');
        tags['Keys:CreationDate'] = stamp;
        for (const tag of ['CreateDate', 'TrackCreateDate', 'MediaCreateDate']) tags[`QuickTime:${tag}`] = stamp;
    }
    if (checked.location) {
        const { latitude, longitude, altitude } = checked.location;
        tags['Keys:GPSCoordinates'] = `${latitude.toFixed(5)} ${longitude.toFixed(5)}${altitude === undefined ? '' : ` ${altitude.toFixed(2)}`}`;
    }
    return tags;
}

function dateValue(value: unknown): number {
    return Date.parse(String(value).replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T'));
}

/** Family-1 groups that carry the QuickTime dates this tool writes. */
const QUICKTIME_GROUP = /^(?:QuickTime|Track\d+|Media\d+)$/;

function verifyTags(expected: Record<string, string>, actual: Tags): Tags {
    const verified: Tags = {};
    for (const [key, value] of Object.entries(expected)) {
        // Family-1 groups label track dates Track1/Track2, not QuickTime. Only
        // QuickTime-family groups count: an XMP:CreateDate an editor left behind is
        // not a tag this tool wrote, so comparing against it would fail a good write.
        const matches = key.startsWith('QuickTime:')
            ? Object.entries(actual).filter(([name]) => {
                const separator = name.indexOf(':');
                return separator > 0 && name.slice(separator + 1) === key.slice('QuickTime:'.length)
                    && QUICKTIME_GROUP.test(name.slice(0, separator));
            })
            : Object.entries(actual).filter(([name]) => name === key);
        if (!matches.length) throw new Error(`Metadata readback is missing ${key}`);
        for (const [name, readback] of matches) {
            let equal = String(readback) === value;
            if (key.endsWith('Date')) equal = Number.isFinite(dateValue(value)) && dateValue(readback) === dateValue(value);
            if (key.endsWith('GPSCoordinates')) {
                const requested = value.split(' ').map(Number);
                const stored = String(readback).trim().split(/\s+/).map(Number);
                equal = requested.length === stored.length && requested.every((number, i) => Math.abs(number - stored[i]!) < 0.000001);
            }
            if (!equal) throw new Error(`Metadata readback did not match ${key}`);
            verified[name] = readback;
        }
    }
    return verified;
}

/** Local metadata-only copy. No phone, upload, transcoding or source overwrite. */
export async function addVideoMetadata(input: AddVideoMetadataInput): Promise<VideoMetadataResult> {
    const checked = addVideoMetadataSchema.parse(input);
    const target = await resolveVideoTarget(checked, { defaultSuffix: 'metadata', subject: 'Video metadata' });
    const before = await readTags(target.source);
    if (!hasVideoTrack(before.tags)) throw new Error('Input must contain a video track in an MP4, MOV or M4V container');
    const tags = videoMetadataTags(checked.metadata);
    const { produced, bytes } = await publishNewFile(target, '.phoneos-video-metadata-', async (workingFile) => {
        await copyFile(target.source, workingFile);
        const write = await exiftool(['-overwrite_original', ...Object.entries(tags).map(([tag, value]) => `-${tag}${tag.endsWith('GPSCoordinates') ? '#' : ''}=${value}`), workingFile]);
        const after = await readTags(workingFile);
        return { readback: verifyTags(tags, after.tags), warnings: [write.stderr.trim(), ...after.warnings] };
    });
    return {
        input_path: target.source, output_path: target.destination, bytes, verified: true, written_tags: tags,
        readback: produced.readback,
        warnings: [...new Set([...before.warnings, ...produced.warnings,
            'Editable tags do not authenticate a capture device or make generated footage camera-original.',
            'Metadata edits can affect existing provenance signatures; this tool does not validate or re-sign them.',
        ].filter(Boolean))],
    };
}
