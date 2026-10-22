import { execFile } from 'node:child_process';
import { link, lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export const filePath = z.string().min(1).refine((value) => !value.includes('\0'), 'Invalid path');
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v'];
export type Tags = Record<string, unknown>;

export async function exiftool(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const executable = require('exiftool-vendored.pl') as string;
    try {
        return await execFileAsync('perl', [executable, '-config', '', '-api', 'QuickTimeUTC=1', '-charset', 'filename=UTF8', ...args], {
            encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
            // A deterministic timezone for integer QuickTime date readback.
            env: { ...process.env, TZ: 'UTC' },
        });
    } catch (error) {
        const detail = error as NodeJS.ErrnoException & { stderr?: string };
        if (detail.code === 'ENOENT') throw new Error('Video tooling needs Perl (included with macOS) and installed npm dependencies. Run npm install.');
        throw new Error(`Video metadata operation failed: ${detail.stderr?.trim() || detail.message}`, { cause: error });
    }
}

export async function readTags(file: string): Promise<{ tags: Tags; warnings: string[] }> {
    const { stdout, stderr } = await exiftool(['-json', '-G1', '-s', '-n', file]);
    const entries: unknown = JSON.parse(stdout);
    if (!Array.isArray(entries) || entries.length !== 1 || !entries[0] || typeof entries[0] !== 'object') throw new Error('Invalid ExifTool readback');
    const tags = entries[0] as Tags;
    if (tags['ExifTool:Error']) throw new Error(`Video metadata read failed: ${String(tags['ExifTool:Error'])}`);
    return { tags, warnings: [stderr.trim(), String(tags['ExifTool:Warning'] ?? '')].filter(Boolean) };
}

/** True when the container holds a video track with real pixel dimensions. */
export function hasVideoTrack(tags: Tags): boolean {
    return ['MP4', 'MOV', 'M4V'].includes(String(tags['File:FileType']))
        && Object.entries(tags).some(([key, value]) => key.endsWith(':ImageWidth') && Number(value) > 0);
}

export interface VideoTarget {
    source: string;
    destination: string;
    extension: string;
}

/**
 * Resolve input and output for a tool that always writes a NEW file. Rejects an
 * existing destination, a destination that is the source, and a format change.
 * `subject` only shapes the error text so each tool reads naturally.
 */
export async function resolveVideoTarget(
    input: { input_path: string; output_path?: string },
    options: { defaultSuffix: string; subject: string },
): Promise<VideoTarget> {
    const source = await realpath(path.resolve(input.input_path));
    if (!(await stat(source)).isFile()) throw new Error('input_path must be a regular video file');
    const extension = path.extname(source);
    if (!VIDEO_EXTENSIONS.includes(extension.toLowerCase())) throw new Error(`${options.subject} supports MP4, MOV and M4V only`);
    const destination = path.resolve(input.output_path ?? `${source.slice(0, -extension.length)}.${options.defaultSuffix}${extension}`);
    if (source === destination || path.resolve(input.input_path) === destination) throw new Error('output_path must differ from input_path; the original is never overwritten');
    if (path.extname(destination).toLowerCase() !== extension.toLowerCase()) throw new Error('output_path must keep the input extension; this tool does not convert video formats');
    // lstat, not stat: a dangling or looping symlink still counts as taken.
    if (await lstat(destination).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; })) {
        throw new Error(`Output already exists: ${destination}`);
    }
    const outputDirectory = path.dirname(destination);
    if (!await stat(outputDirectory).then((info) => info.isDirectory(), () => false)) throw new Error(`Output directory does not exist: ${outputDirectory}`);
    return { source, destination, extension };
}

/**
 * Build the file privately, then publish it with link(), which refuses an
 * existing destination atomically — so two concurrent runs cannot clobber each
 * other and a half-written file is never visible at the destination.
 */
export async function publishNewFile<T>(
    target: VideoTarget,
    stagingPrefix: string,
    produce: (workingFile: string) => Promise<T>,
): Promise<{ produced: T; bytes: number }> {
    const staging = await mkdtemp(path.join(path.dirname(target.destination), stagingPrefix));
    try {
        const workingFile = path.join(staging, `video${target.extension}`);
        const produced = await produce(workingFile);
        const info = await stat(workingFile);
        await link(workingFile, target.destination);
        return { produced, bytes: info.size };
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}
