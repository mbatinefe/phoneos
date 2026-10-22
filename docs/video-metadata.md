# Video metadata

`add_video_metadata` creates a **new local copy** of an MP4, MOV or M4V with
the supplied QuickTime tags. It requires no connected phone and does not upload,
publish, transcode, add sound, resize or alter frame rate. Import the returned
`output_path` separately with `add_to_photos` when desired.

The pinned `exiftool-vendored.pl` npm dependency supplies ExifTool. Perl is
required (included with macOS); no separate Homebrew/FFmpeg install is needed.
The tool never touches a phone.

## MCP input

For a clip actually recorded on the specified device:

```json
{
  "input_path": "/absolute/path/clip.mp4",
  "output_path": "/absolute/path/clip-tagged.mp4",
  "metadata": {
    "make": "Apple",
    "model": "iPhone 15 Pro",
    "creation_time": "2026-09-18T12:00:00-05:00",
    "title": "Morning run",
    "description": "Park loop, first lap"
  }
}
```

All metadata fields are optional, but at least one must be supplied. There is
no automatic iPhone preset, inferred device, invented timestamp or GPS lookup.

| Field | Accepted value / destination |
|---|---|
| `make`, `model`, `software` | Non-empty strings, up to 256 characters; QuickTime `Keys:Make`, `Keys:Model`, `Keys:Software` |
| `title`, `description`, `author`, `copyright`, `comment` | Non-empty strings, up to 4096 characters; corresponding QuickTime Keys tags |
| `creation_time` | ISO 8601 with `Z` or an explicit `±HH:MM` offset; fractional seconds are accepted and truncated to whole seconds; `Keys:CreationDate` plus movie, track and media creation dates |
| `location` | `{ "latitude": 37.3349, "longitude": -122.009, "altitude": 12 }`; altitude is optional, in metres; `Keys:GPSCoordinates` |

Dates without a timezone are rejected. QuickTime integer creation timestamps
are written in UTC; the string-based capture date retains its offset. Existing
modification timestamps are not explicitly replaced. Filesystem timestamps on
the new copy reflect the edit, not a claimed camera recording date.

Latitude must be between −90 and 90, longitude between −180 and 180. Coordinates
are rounded to five decimal places and altitude to two. Location can expose
private information; only include coordinates you intend to disclose. Omitting
location leaves existing location metadata intact—it is **not** a GPS scrubber.

## CLI

```sh
npm run phone -- video-metadata /absolute/path/clip.mp4 \
  --metadata '{"title":"Product demo","description":"Screen recording of the onboarding flow","software":"phoneos"}' \
  -o /absolute/path/clip-tagged.mp4
```

The TypeScript library also exports
`addVideoMetadata(input)` with the same input shape.

If `output_path` / `-o` is omitted, the destination is
`<input-stem>.metadata.<extension>` alongside the resolved source. The destination
directory must already exist. The extension must match the input: renaming an
MP4 to MOV does not convert it. Existing files, source paths and destination
symlinks are rejected; there is deliberately no overwrite option.

## Results and safeguards

The tool returns JSON with `input_path`, `output_path`, `bytes`, `verified`,
`written_tags`, `readback` and `warnings`. `verified: true` means the requested
tags were read back and matched, not that a camera identity was authenticated.
The new output is published only after verification. Private temporary files
are cleaned up after success or failure, and concurrent writes cannot overwrite
each other. The original remains untouched. Session logs record paths and field
names, not metadata values/GPS coordinates.

The implementation uses a fixed tag allowlist and argument arrays, not a shell.
Unknown metadata keys, empty values, arbitrary encoder options, control NULs,
invalid dates and out-of-range coordinates are rejected. Existing metadata is
retained except for the fields explicitly replaced; the tool does not offer
bulk stripping, encoder-trace removal or watermark removal. Editing a signed
asset may affect its provenance signatures; no signature validation or
re-signing is performed.

Changing make/model tags **does not turn generated footage into an iPhone
recording**, change its image characteristics, or guarantee how a platform
classifies it. Keep AI disclosures and factual descriptions accurate. For
genuine iPhone provenance, capture on the phone and retain the original.

Tag mappings follow the official [ExifTool QuickTime documentation](https://exiftool.org/TagNames/QuickTime.html#Keys).

## Normalizing for upload (`normalize_video`)

A separate tool, because this one re-encodes and `add_video_metadata` never does.
It fixes the two things that actually break social uploads:

- **Frame rate.** A constant `fps` (default 30). 24 fps commonly stutters in
  vertical feeds. The video stream is only re-encoded when it does not already
  run at the target rate; otherwise it is stream-copied, losslessly.
- **Missing audio.** With `ensure_audio` (default true) a silent stereo AAC
  track is added **only** when the file has no audio at all — uploads often fail
  or play back muted without one. An existing track is copied untouched.

`quality` is the x264 CRF used when re-encoding (default 18, visually
near-lossless; lower means bigger). Output is verified before publishing: frame
rate, audio presence, unchanged picture size and duration within half a second.
`changed` lists what it actually did, and is empty when the input already
conformed.

```sh
npm run phone -- normalize-video /absolute/path/clip.mp4 --fps 30 -o /absolute/path/clip-upload.mp4
```

Run it **before** `add_video_metadata`: re-encoding rewrites container tags, so
tagging first would lose them.

Like the metadata tool, it writes a new file, never overwrites, and leaves the
source alone. It does **not** strip encoder traces, remove watermarks or forge
capture provenance — re-encoding with ffmpeg leaves its own encoder tags, which
is accurate, and a generated clip stays a generated clip.

## Tests

```sh
node --import tsx --test test/video-metadata.test.ts
npm run check
```

Tests use an original tiny black-frame video, the real bundled ExifTool, and
in-memory MCP transport. They cover tag round trips, byte-identical encoded
media, Unicode, timezones, GPS (including zero), validation, source preservation,
existing destinations, symlinks, simultaneous writes, and CLI/MCP execution
without phone access. Two regression cases guard verification: an unrelated
`XMP:CreateDate` left behind by an editor must not fail a good write, and a
millisecond timestamp (what `toISOString()` produces) must be accepted and
stored to the whole second.
