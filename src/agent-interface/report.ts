import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A run report: while one is open for a device, every action is written down with a
 * screenshot of what followed; finishing it renders one self-contained HTML file to
 * attach to a bug or share. Kept on disk, so it spans separate `phone` commands too.
 */

export interface ReportStep {
    at: string;
    action: string;
    state?: string;
    /** File name of the screenshot taken after the step, in the report's folder. */
    image?: string;
    failed?: boolean;
}

export interface ActiveReport {
    title: string;
    device: string;
    udid: string;
    startedAt: string;
    directory: string;
}

export interface FinishedReport {
    path: string;
    steps: number;
    failures: number;
}

const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');

export class RunReports {
    constructor(private readonly root: string) {}

    private marker(udid: string): string {
        return path.join(this.root, `active-${safe(udid)}.json`);
    }

    async active(udid: string): Promise<ActiveReport | undefined> {
        try {
            return JSON.parse(await readFile(this.marker(udid), 'utf8')) as ActiveReport;
        } catch {
            return undefined;
        }
    }

    async start(udid: string, device: string, title: string): Promise<ActiveReport> {
        if (await this.active(udid)) throw new Error(`A report is already open for ${device}: finish_report first`);
        const startedAt = new Date().toISOString();
        const directory = path.join(this.root, `${startedAt.replace(/[:.]/g, '-')}-${safe(title).slice(0, 40) || 'run'}`);
        await mkdir(directory, { recursive: true });
        const report: ActiveReport = { title, device, udid, startedAt, directory };
        await writeFile(this.marker(udid), JSON.stringify(report));
        return report;
    }

    async step(udid: string, step: { action: string; state?: string; image?: Buffer; failed?: boolean }): Promise<void> {
        const report = await this.active(udid);
        if (!report) return;
        const steps = await this.steps(report);
        let image: string | undefined;
        if (step.image) {
            image = `${String(steps.length + 1).padStart(3, '0')}.jpg`;
            await writeFile(path.join(report.directory, image), step.image);
        }
        const entry: ReportStep = {
            at: new Date().toISOString(), action: step.action,
            ...(step.state ? { state: step.state } : {}), ...(image ? { image } : {}), ...(step.failed ? { failed: true } : {}),
        };
        await appendFile(path.join(report.directory, 'steps.jsonl'), `${JSON.stringify(entry)}\n`);
    }

    private async steps(report: ActiveReport): Promise<ReportStep[]> {
        const raw = await readFile(path.join(report.directory, 'steps.jsonl'), 'utf8').catch(() => '');
        return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as ReportStep);
    }

    async finish(udid: string, { outcome, notes }: { outcome?: 'passed' | 'failed'; notes?: string } = {}): Promise<FinishedReport> {
        const report = await this.active(udid);
        if (!report) throw new Error('No report is open for this device: start_report first');
        const steps = await this.steps(report);
        const images = new Map<string, string>();
        for (const step of steps) {
            if (step.image) images.set(step.image, (await readFile(path.join(report.directory, step.image))).toString('base64'));
        }
        const file = path.join(report.directory, 'report.html');
        await writeFile(file, renderReport({ ...report, finishedAt: new Date().toISOString(), ...(outcome ? { outcome } : {}), ...(notes ? { notes } : {}) }, steps, images));
        await rm(this.marker(udid), { force: true });
        return { path: file, steps: steps.length, failures: steps.filter((step) => step.failed).length };
    }
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

function elapsed(from: string, to: string): string {
    const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
    return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function renderReport(
    report: ActiveReport & { finishedAt: string; outcome?: 'passed' | 'failed'; notes?: string },
    steps: readonly ReportStep[],
    images: ReadonlyMap<string, string>,
): string {
    const failures = steps.filter((step) => step.failed).length;
    const outcome = report.outcome ?? (failures ? 'failed' : undefined);
    const rows = steps.map((step, index) => {
        const image = step.image && images.get(step.image);
        return `<li class="step${step.failed ? ' failed' : ''}">
<div class="text"><span class="n">${index + 1}</span><span class="t">+${elapsed(report.startedAt, step.at)}</span>
<p class="action">${escapeHtml(step.action)}</p>${step.state ? `<p class="state">${escapeHtml(step.state)}</p>` : ''}</div>
${image ? `<img src="data:image/jpeg;base64,${image}" alt="Screen after step ${index + 1}" title="Click to enlarge" onclick="this.classList.toggle('zoom')">` : ''}
</li>`;
    }).join('\n');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(report.title)}</title>
<style>
:root{--bg:#f7f7f8;--card:#fff;--text:#16181d;--muted:#5f6670;--line:#e3e5e8;--bad:#c62828;--good:#1b7f3b}
@media (prefers-color-scheme:dark){:root{--bg:#121316;--card:#1b1d22;--text:#eceef1;--muted:#9aa1ab;--line:#2c3038;--bad:#ef6b6b;--good:#5cc584}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}.meta{color:var(--muted);margin:0 0 16px}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:600;font-size:13px;margin-left:8px;color:#fff;background:var(--muted)}
.badge.passed{background:var(--good)}.badge.failed{background:var(--bad)}
.notes{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;white-space:pre-wrap}
ol{list-style:none;padding:0;margin:16px 0 0}
.step{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 10px}
.step.failed{border-color:var(--bad)}.step.failed .action{color:var(--bad)}
.text{min-width:0;flex:1}.n{font-weight:700;margin-right:8px}.t{color:var(--muted);font-size:13px}
.action{margin:4px 0;font-weight:500;overflow-wrap:anywhere}.state{margin:0;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
img{width:140px;border-radius:8px;border:1px solid var(--line);display:block;cursor:zoom-in}
img.zoom{width:min(390px,100%);cursor:zoom-out}
@media (max-width:520px){.step{flex-direction:column}img{width:100%;max-width:260px}}
</style></head>
<body><main>
<h1>${escapeHtml(report.title)}${outcome ? `<span class="badge ${outcome}">${outcome}</span>` : ''}</h1>
<p class="meta">${escapeHtml(report.device)} · ${escapeHtml(new Date(report.startedAt).toLocaleString('en-GB'))} · ${elapsed(report.startedAt, report.finishedAt)} · ${steps.length} step${steps.length === 1 ? '' : 's'}${failures ? ` · ${failures} failed` : ''}</p>
${report.notes ? `<div class="notes">${escapeHtml(report.notes)}</div>` : ''}
<ol>
${rows}
</ol>
<p class="meta">Made by phoneos.</p>
</main></body></html>
`;
}
