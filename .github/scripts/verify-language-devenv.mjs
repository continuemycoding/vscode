#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Verify locked Windows development-environment inputs and staged product trees.
 *
 * Usage:
 *   node .github/scripts/verify-language-devenv.mjs --check-lock
 *   node .github/scripts/verify-language-devenv.mjs --app-root <tree> --language <lang>
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
	LANGUAGES,
	LOCK_FILE,
	assertRequiredFiles,
	collectExtensionIds,
	loadLock,
	parseArgs,
	pathExists,
	readJson,
	sha256File,
	validateLock,
} from './devenv-lib.mjs';

const COMMAND_CHECKS = {
	cpp: [
		{ rel: 'CMake/bin/cmake.exe', args: ['--version'] },
		{ rel: 'Ninja/ninja.exe', args: ['--version'] },
		{ rel: 'MinGW/bin/gcc.exe', args: ['--version'] },
		{ rel: 'MinGW/bin/g++.exe', args: ['--version'] },
		{ rel: 'MinGW/bin/gdb.exe', args: ['--version'] },
	],
	go: [
		{ rel: 'Go/bin/go.exe', args: ['version'] },
		{ rel: 'tools/dlv.exe', args: ['version'] },
		{ rel: 'tools/gopls.exe', args: ['version'] },
	],
	rust: [
		{ rel: '.cargo/bin/rustc.exe', args: ['--version', '--verbose'], includes: 'host: x86_64-pc-windows-gnu' },
		{ rel: '.cargo/bin/cargo.exe', args: ['--version'] },
		{ rel: '.rustup/toolchains/stable-x86_64-pc-windows-gnu/bin/rustc.exe', args: ['--version', '--verbose'], includes: 'host: x86_64-pc-windows-gnu' },
		{ rel: 'MinGW/bin/gcc.exe', args: ['--version'] },
	],
	csharp: [
		{ rel: 'dotnet/dotnet.exe', args: ['--info'] },
		{ rel: 'NetCoreDbg/netcoredbg.exe', args: ['--help'], allowFailure: true },
	],
	javascript: [
		{ rel: 'nodejs/node.exe', args: ['--version'] },
	],
	typescript: [
		{ rel: 'nodejs/node.exe', args: ['--version'] },
		{ rel: 'nodejs/npm.cmd', args: ['--version'] },
	],
	python: [
		{ rel: 'Python314/python.exe', args: ['--version'] },
		{ rel: 'Python314/python.exe', args: ['-m', 'pip', '--version'] },
	],
	lua: [
		{ rel: 'Lua/lua.exe', args: ['-v'] },
	],
};

function printHelp() {
	console.log(`Verify locked Windows development environments

Usage:
  node verify-language-devenv.mjs --check-lock
  node verify-language-devenv.mjs --app-root <tree> --language <${LANGUAGES.join('|')}>
`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printHelp();
		return;
	}
	if (args['check-lock']) {
		await checkLock();
		return;
	}
	if (!args['app-root'] || !args.language) {
		printHelp();
		throw new Error('Use --check-lock, or --app-root and --language');
	}
	if (!LANGUAGES.includes(args.language)) {
		throw new Error(`Unsupported language: ${args.language}`);
	}
	await verifyTree(args['app-root'], args.language);
}

async function checkLock() {
	const lock = await loadLock();
	validateLock(lock);
	const lockSha = await sha256File(LOCK_FILE);
	const assetCount = Object.keys(lock.assets).length;
	for (const language of LANGUAGES) {
		const spec = lock.languages[language];
		if (spec.path.length === 0) {
			throw new Error(`${language} path entries must not be empty`);
		}
	}
	if (!lock.common.extensions.includes('remotepro-cn.remotepro') || !lock.common.extensions.includes('saoudrizwan.claude-dev')) {
		throw new Error('Common extensions must include RemotePro and Claude Dev');
	}
	console.log(`Lock OK (${assetCount} assets, sha256=${lockSha})`);
}

async function verifyTree(appRoot, language) {
	const lock = await loadLock();
	const spec = lock.languages[language];
	if (await pathExists(join(appRoot, 'bootstrap'))) {
		throw new Error(`${language} package still contains bootstrap/`);
	}
	const product = await readJson(join(appRoot, 'resources', 'app', 'product.json'));
	if (product.bundledDevEnvironment !== true) {
		throw new Error('product.json bundledDevEnvironment must be true');
	}
	if ('target' in product || product.win32VersionedUpdate) {
		throw new Error('portable product.json must not declare installer target or win32VersionedUpdate');
	}

	const entriesPath = join(appRoot, 'dev-env', 'path-entries.json');
	if (!(await pathExists(entriesPath))) {
		throw new Error(`missing ${entriesPath}`);
	}
	const entries = await readJson(entriesPath);
	if (JSON.stringify(entries.path) !== JSON.stringify(spec.path)) {
		throw new Error(`${language} path-entries.path does not match the lock`);
	}

	const devEnv = join(appRoot, 'dev-env');
	for (const rel of spec.extraRequiredFiles ?? []) {
		await assertRequiredFiles(devEnv, [rel], language);
	}
	if (!(await pathExists(join(appRoot, 'data', 'tmp'))) || !(await pathExists(join(appRoot, 'data', 'dev-env-state')))) {
		throw new Error('portable data/tmp or data/dev-env-state is missing');
	}

	const extensionIds = await collectExtensionIds(join(appRoot, 'resources', 'app', 'extensions'));
	for (const id of [...lock.common.extensions, ...spec.extensions]) {
		if (!extensionIds.has(id.toLowerCase())) {
			throw new Error(`Missing system extension ${id}`);
		}
		const dest = join(appRoot, 'resources', 'app', 'extensions', extensionIds.get(id.toLowerCase()));
		await assertRequiredFiles(dest, lock.assets[id].requiredFiles, id);
	}

	const pathPrefix = spec.path.map(rel => join(devEnv, rel)).join(';');
	for (const check of COMMAND_CHECKS[language]) {
		const exe = join(devEnv, check.rel);
		if (!(await pathExists(exe))) {
			throw new Error(`missing binary: ${exe}`);
		}
		try {
			const out = execFileSync(exe, check.args, {
				encoding: 'utf8',
				env: { ...process.env, PATH: `${pathPrefix};${process.env.PATH || ''}` },
				timeout: 60_000,
				windowsHide: true,
			});
			if (check.includes && !out.includes(check.includes)) {
				throw new Error(`${check.rel} output does not include ${JSON.stringify(check.includes)}`);
			}
			console.log(`OK ${check.rel}: ${String(out).trim().split(/\r?\n/)[0]}`);
		} catch (error) {
			if (!check.allowFailure) {
				throw error;
			}
			console.log(`OK ${check.rel} (help/version emitted)`);
		}
	}

	if (language === 'lua' && !(await pathExists(join(devEnv, 'Lua', 'lua55.dll')))) {
		throw new Error('lua55.dll must sit next to lua.exe');
	}
	console.log(`${language} tree verification passed`);
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
