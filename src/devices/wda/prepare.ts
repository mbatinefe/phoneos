import { spawn, type SpawnOptions } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureWdaSource } from './source.js';
import { resolveBuildTargets } from './target-device.js';
import {
    deploymentTarget, destinationArgument, resolveDerivedDataPath, resolveDeveloperDir, resolveWdaProject, resolveWdaRoot, signingArguments,
} from './xcode-env.js';

function run(command: string, args: string[], options: SpawnOptions = {}): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit', ...options });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`${command} failed (${signal ?? `exit ${code}`})`));
        });
    });
}

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const wdaRoot = resolveWdaRoot();
const projectPath = resolveWdaProject();

/** Apply the bundled WDA patches (idempotent: each one checks for its own marker first). */
export async function applyWdaPatches(): Promise<void> {
    if (!process.env.WDA_ROOT) await ensureWdaSource(wdaRoot);
    const touchCommandsPath = path.join(wdaRoot, 'WebDriverAgentLib/Commands/FBTouchActionCommands.m');
    const runnerInfoPlistPath = path.join(wdaRoot, 'WebDriverAgentRunner/Info.plist');
    const customCommandsPath = path.join(wdaRoot, 'WebDriverAgentLib/Commands/FBCustomCommands.m');
    const patches = [
        {
            file: path.join(packageRoot, 'Patches/appium-webdriveragent-8.9.1-absolute-touch.patch'),
            applied: async () => (await readFile(touchCommandsPath, 'utf8')).includes('FBImportMedia')
                && (await readFile(runnerInfoPlistPath, 'utf8')).includes('NSPhotoLibraryAddUsageDescription'),
            label: 'absolute-touch + Photos import',
        },
        {
            file: path.join(packageRoot, 'Patches/appium-webdriveragent-8.9.1-sessionless-buttons.patch'),
            applied: async () => (await readFile(customCommandsPath, 'utf8')).includes('POST:@"/wda/pressButton"].withoutSession'),
            label: 'sessionless device buttons',
        },
    ];
    await Promise.all([access(projectPath), access(touchCommandsPath), access(runnerInfoPlistPath), access(customCommandsPath)]);
    for (const patch of patches) {
        if (await patch.applied()) {
            console.log(`WDA ${patch.label} patch is already applied`);
            continue;
        }
                await run('/usr/bin/patch', ['-p0', '-i', patch.file], { cwd: wdaRoot });
        console.log(`Applied WDA ${patch.label} patch`);
    }
}

async function main(): Promise<void> {
    await applyWdaPatches();
    const developerDir = resolveDeveloperDir();
    const targets = await resolveBuildTargets();
    for (const target of targets) {
        if (targets.length > 1) console.log(`\n=== WebDriverAgent build for ${target.udid} (${target.kind}) ===`);
        await run('xcodebuild', [
            'build-for-testing',
            ...(target.kind === 'device' ? ['-allowProvisioningUpdates'] : []),
            ...(target.kind === 'device' && process.env.ALLOW_PROVISIONING_DEVICE_REGISTRATION === 'true'
                ? ['-allowProvisioningDeviceRegistration']
                : []),
            '-project', projectPath,
            '-scheme', 'WebDriverAgentRunner',
            '-derivedDataPath', resolveDerivedDataPath(),
            '-destination', destinationArgument(target),
            ...(target.kind === 'device' ? [`IPHONEOS_DEPLOYMENT_TARGET=${deploymentTarget(target)}`] : []),
            ...signingArguments(target),
            'GCC_TREAT_WARNINGS_AS_ERRORS=0',
            'COMPILER_INDEX_STORE_ENABLE=NO',
        ], { env: { ...process.env, DEVELOPER_DIR: developerDir } });
    }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) await main();
