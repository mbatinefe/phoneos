#!/usr/bin/env node
// `phone` CLI entry: runs the TypeScript source through tsx from the repo, with its .env loaded.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Under `npm run phone`, npm has already moved to the repo; INIT_CWD is where the command was typed.
const caller = process.env.PHONEOS_CALLER_CWD ?? process.env.INIT_CWD ?? process.cwd();
const child = spawn(process.execPath, [
    ...(existsSync(path.join(root, '.env')) ? ['--env-file=.env'] : []),
    '--import', 'tsx',
    path.join(root, 'src/agent-interface/cli.ts'), ...process.argv.slice(2),
], { cwd: root, stdio: 'inherit', env: { ...process.env, PHONEOS_CALLER_CWD: caller } });
child.on('exit', (code) => process.exit(code ?? 1));
