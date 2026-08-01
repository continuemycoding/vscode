#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Smoke-verify stage-language-devenv for go + python without a full VS Code build.
 *
 * Creates a fake app root, stages toolchains, checks binaries + path-entries.json,
 * and confirms commands resolve when those dirs are prepended to PATH (RemotePro-style).
 *
 * Usage:
 *   node .github/scripts/verify-language-devenv.mjs
 *   node .github/scripts/verify-language-devenv.mjs --languages go,python
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stageScript = join(__dirname, 'stage-language-devenv.mjs');

const CHECKS = {
	go: [
		{ rel: 'Go/bin/go.exe', args: ['version'] },
		{ rel: 'tools/dlv.exe', args: ['version'] },
	],
	python: [
		{ rel: 'Python312/python.exe', args: ['--version'] },
	],
	nodejs: [
		{ rel: 'nodejs/node.exe', args: ['--version'] },
	],
};

function parseArgs(argv) {
	let languages = ['go', 'python'];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--languages' && argv[i + 1]) {
			languages = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
		}
	}
	return { languages };
}

async function pathExists(p) {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function verifyLanguage(language, workRoot, cacheRoot) {
	const appRoot = join(workRoot, `fake-app-${language}`);
	await fs.rm(appRoot, { recursive: true, force: true });
	await fs.mkdir(join(appRoot, 'resources', 'app'), { recursive: true });
	// bootstrap is sibling of resources (same as DefaultDevEnvInitializer layout)
	await fs.mkdir(join(appRoot, 'bootstrap'), { recursive: true });

	console.log(`\n=== verify ${language} ===`);
	execFileSync(process.execPath, [
		stageScript,
		'--app-root', appRoot,
		'--language', language,
		'--cache-dir', join(cacheRoot, language),
	], { stdio: 'inherit', env: process.env });

	const entriesPath = join(appRoot, 'bootstrap', 'dev-env', 'path-entries.json');
	if (!(await pathExists(entriesPath))) {
		throw new Error(`missing path-entries.json for ${language}`);
	}
	const entries = JSON.parse(await fs.readFile(entriesPath, 'utf8'));
	if (!Array.isArray(entries.path) || entries.path.length === 0) {
		throw new Error(`path-entries.json has empty path for ${language}`);
	}

	const devEnv = join(appRoot, 'bootstrap', 'dev-env');
	const pathDirs = entries.path.map(rel => join(devEnv, rel));
	const pathPrefix = pathDirs.join(';');

	const checks = CHECKS[language];
	if (!checks) {
		console.log(`No binary checks configured for ${language}; path-entries OK`);
		return;
	}

	for (const check of checks) {
		const exe = join(devEnv, check.rel);
		if (!(await pathExists(exe))) {
			throw new Error(`missing binary: ${exe}`);
		}
		const out = execFileSync(exe, check.args, {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${pathPrefix};${process.env.PATH || ''}` },
			timeout: 60_000,
		});
		console.log(`OK ${check.rel}: ${String(out).trim().split(/\r?\n/)[0]}`);
	}

	// Simulate PATH registration: dirs must be absolute and exist
	for (const dir of pathDirs) {
		if (!(await pathExists(dir))) {
			throw new Error(`path entry dir missing: ${dir}`);
		}
	}
	console.log(`path-entries PATH dirs OK (${pathDirs.length})`);
}

async function main() {
	const { languages } = parseArgs(process.argv.slice(2));
	const workRoot = join(tmpdir(), 'vscode-devenv-verify');
	const cacheRoot = join(tmpdir(), 'vscode-devenv-cache');
	await fs.mkdir(workRoot, { recursive: true });
	await fs.mkdir(cacheRoot, { recursive: true });

	for (const language of languages) {
		await verifyLanguage(language, workRoot, cacheRoot);
	}
	console.log('\nAll verifications passed.');
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
