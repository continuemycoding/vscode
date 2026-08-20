#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Stage locked Windows development environments into a packaged VS Code tree.
 *
 * Usage:
 *   node .github/scripts/stage-language-devenv.mjs --app-root <tree> --common-only --cache-dir <dir> --commit <sha>
 *   node .github/scripts/stage-language-devenv.mjs --app-root <tree> --language <lang> --cache-dir <dir> --commit <sha> [--base-sha <sha>] --manifest <file>
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	LANGUAGES,
	LOCK_FILE,
	MARKET_HEADERS,
	assertPeImportsAllowed,
	assertRequiredFiles,
	collectExtensionIds,
	downloadVerified,
	ensureDir,
	extractVsixToExtension,
	extractZipFlatten,
	extractZipTo,
	forceRustupHardlinks,
	isInside,
	loadLock,
	log,
	normalizeWindowsDesktopExecutable,
	parseArgs,
	pathExists,
	readJson,
	runChecked,
	scanForbiddenAbsolutePaths,
	sha256File,
	writeJson,
	writeKeepDir,
} from './devenv-lib.mjs';

function printHelp() {
	console.log(`Stage locked Windows development environments

Usage:
  node stage-language-devenv.mjs --app-root <tree> --common-only --cache-dir <dir> --commit <sha>
  node stage-language-devenv.mjs --app-root <tree> --language <${LANGUAGES.join('|')}> --cache-dir <dir> --commit <sha> [--base-sha <sha>] --manifest <file>
`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printHelp();
		return;
	}
	if (!args['app-root'] || !args['cache-dir'] || !args.commit) {
		printHelp();
		throw new Error('--app-root, --cache-dir, and --commit are required');
	}
	if (args['common-only'] && args.language) {
		throw new Error('Use either --common-only or --language, not both');
	}
	if (!args['common-only'] && !args.language) {
		printHelp();
		throw new Error('--common-only or --language is required');
	}
	if (args.language && !LANGUAGES.includes(args.language)) {
		throw new Error(`Unsupported language: ${args.language}`);
	}
	if (args.language && !args.manifest) {
		throw new Error('--manifest is required when staging a language');
	}

	const lock = await loadLock();
	const appRoot = args['app-root'];
	const cacheDir = args['cache-dir'];
	await ensureDir(cacheDir);
	await ensureAppRoot(appRoot);

	const inputs = [];
	const presentIds = await collectExtensionIds(join(appRoot, 'resources', 'app', 'extensions'));
	if (args['common-only']) {
		await stageExtensions(appRoot, lock, lock.common.extensions, cacheDir, inputs, presentIds);
		log('Common extensions staged');
		return;
	}

	await finalizePortableProduct(appRoot);
	const language = args.language;
	const spec = lock.languages[language];
	const devEnvRoot = join(appRoot, 'dev-env');
	await fs.rm(devEnvRoot, { recursive: true, force: true });
	await ensureDir(devEnvRoot);
	await writeKeepDir(join(appRoot, 'data', 'tmp'));
	await writeKeepDir(join(appRoot, 'data', 'dev-env-state'));

	await stageTools(lock, spec, devEnvRoot, cacheDir, inputs);
	await stageLanguageExtras(lock, language, spec, devEnvRoot, cacheDir, inputs);
	await writePathEntries(devEnvRoot, spec);
	await mergePortableSettings(appRoot, spec.settings ?? {});
	await stageExtensions(appRoot, lock, spec.extensions, cacheDir, inputs, presentIds);
	await verifyStagedTree(appRoot, language, spec, lock, cacheDir);

	const manifest = {
		language,
		commit: args.commit,
		lockFile: '.github/devenv-inputs-win32-x64.lock.json',
		lockSha256: await sha256File(LOCK_FILE),
		baseSha256: args['base-sha'] ?? null,
		inputs,
		path: spec.path,
		env: spec.env ?? {},
		state: spec.state ?? {},
		values: spec.values ?? {},
		extensions: spec.extensions,
		tools: spec.tools,
		inventory: await inventory(appRoot, language),
	};
	await writeJson(args.manifest, manifest);
	log(`Wrote ${args.manifest}`);
}

async function ensureAppRoot(appRoot) {
	await normalizeWindowsDesktopExecutable(appRoot);
	if (!(await pathExists(join(appRoot, 'resources', 'app')))) {
		throw new Error(`App root is missing resources/app: ${appRoot}`);
	}
	if (await pathExists(join(appRoot, 'bootstrap'))) {
		throw new Error(`Refusing to stage into a tree that still contains bootstrap/: ${appRoot}`);
	}
}

async function finalizePortableProduct(appRoot) {
	const productPath = join(appRoot, 'resources', 'app', 'product.json');
	const product = await readJson(productPath);
	if (product.bundledDevEnvironment !== true) {
		throw new Error('product.json must set bundledDevEnvironment=true before language staging');
	}
	if ('target' in product) {
		delete product.target;
	}
	if ('win32VersionedUpdate' in product) {
		delete product.win32VersionedUpdate;
	}
	await fs.writeFile(productPath, JSON.stringify(product, null, '\t') + '\n', 'utf8');
}

async function stageExtensions(appRoot, lock, ids, cacheDir, inputs, alreadyPresent) {
	const extensionsRoot = join(appRoot, 'resources', 'app', 'extensions');
	await ensureDir(extensionsRoot);
	for (const id of ids) {
		if (alreadyPresent.has(id.toLowerCase())) {
			throw new Error(`Cannot stage ${id}: a built-in extension already uses this id`);
		}
		const asset = lock.assets[id];
		const vsixPath = await downloadAsset(asset, cacheDir, inputs);
		const dest = join(extensionsRoot, id.toLowerCase());
		if (!isInside(extensionsRoot, dest)) {
			throw new Error(`Extension destination escaped extensions root: ${id}`);
		}
		const manifest = await extractVsixToExtension(vsixPath, dest, { id, version: asset.version });
		await assertRequiredFiles(dest, asset.requiredFiles, id);
		const missing = (manifest.extensionDependencies || []).filter(dep => {
			const needle = dep.toLowerCase();
			return !alreadyPresent.has(needle) && !ids.some(staged => staged.toLowerCase() === needle);
		});
		if (missing.length > 0) {
			throw new Error(`${id} has unstaged extension dependencies: ${missing.join(', ')}`);
		}
		alreadyPresent.set(id.toLowerCase(), id);
	}
	await collectExtensionIds(extensionsRoot);
}

async function stageTools(lock, spec, devEnvRoot, cacheDir, inputs) {
	for (const id of spec.tools) {
		const asset = lock.assets[id];
		if (asset.kind === 'go-module' || asset.kind === 'vsix') {
			continue;
		}
		if (id === 'rustup-init') {
			continue;
		}
		const archive = await downloadAsset(asset, cacheDir, inputs);
		const dest = join(devEnvRoot, asset.dest);
		if (!asset.dest || !isInside(devEnvRoot, dest)) {
			throw new Error(`Asset ${id} is missing a dest inside dev-env`);
		}
		if (asset.kind === 'binary') {
			await ensureDir(dirname(dest));
			await fs.copyFile(archive, dest.endsWith('.exe') ? dest : join(dest, asset.requiredFiles[0]));
		} else if (asset.flatten === false) {
			await extractZipTo(archive, dest);
		} else {
			await extractZipFlatten(archive, dest);
		}
		await assertRequiredFiles(dest, asset.requiredFiles, id);
	}
}

async function stageLanguageExtras(lock, language, spec, devEnvRoot, cacheDir, inputs) {
	if (language === 'go') {
		await stageGoModules(lock, spec, devEnvRoot, cacheDir, inputs);
	}
	if (language === 'rust') {
		await stageRustToolchain(lock, spec, devEnvRoot, cacheDir, inputs);
	}
	if (language === 'python') {
		await stagePythonPip(devEnvRoot);
	}
}

async function stageGoModules(lock, spec, devEnvRoot, cacheDir, inputs) {
	const goBin = join(devEnvRoot, 'Go', 'bin', 'go.exe');
	const toolsDir = join(devEnvRoot, 'tools');
	await ensureDir(toolsDir);
	const gopath = join(cacheDir, 'gopath');
	await ensureDir(gopath);
	for (const id of spec.modules ?? []) {
		const asset = lock.assets[id];
		await downloadAsset(asset, cacheDir, inputs);
		log(`go install ${asset.install}@${asset.version}`);
		runChecked(goBin, ['install', `${asset.install}@${asset.version}`], {
			env: {
				...process.env,
				GOROOT: join(devEnvRoot, 'Go'),
				GOPATH: gopath,
				GOBIN: toolsDir,
				GOTOOLCHAIN: 'local',
				PATH: `${join(devEnvRoot, 'Go', 'bin')};${process.env.PATH || ''}`,
			},
			timeout: 15 * 60 * 1000,
		});
		await assertRequiredFiles(toolsDir, asset.requiredFiles, id);
	}
}

async function stageRustToolchain(lock, spec, devEnvRoot, cacheDir, inputs) {
	const asset = lock.assets['rustup-init'];
	const initPath = await downloadAsset(asset, cacheDir, inputs);
	const cargoHome = join(devEnvRoot, '.cargo');
	const rustupHome = join(devEnvRoot, '.rustup');
	await ensureDir(cargoHome);
	await ensureDir(rustupHome);
	const toolchain = spec.rustToolchain;
	log(`rustup-init ${toolchain}`);
	runChecked(initPath, [
		'-y',
		'--default-toolchain', toolchain,
		'--default-host', 'x86_64-pc-windows-gnu',
		'--profile', spec.rustupProfile || 'minimal',
		'--no-modify-path',
		...((spec.rustupComponents ?? []).flatMap(component => ['--component', component])),
	], {
		env: {
			...process.env,
			CARGO_HOME: cargoHome,
			RUSTUP_HOME: rustupHome,
			RUSTUP_AUTO_INSTALL: '0',
		},
		timeout: 30 * 60 * 1000,
	});
	const rustup = join(cargoHome, 'bin', 'rustup.exe');
	runChecked(rustup, ['set', 'auto-self-update', 'disable'], {
		env: { ...process.env, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome },
	});
	await forceRustupHardlinks(join(cargoHome, 'bin'));
	const rustc = join(cargoHome, 'bin', 'rustc.exe');
	const version = runFile(rustc, ['--version', '--verbose'], {
		env: { ...process.env, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome, PATH: `${join(cargoHome, 'bin')};${join(devEnvRoot, 'MinGW', 'bin')};${process.env.PATH || ''}` },
	});
	if (!version.includes('host: x86_64-pc-windows-gnu') || !version.includes(toolchain.split('-')[0])) {
		throw new Error(`Unexpected rustc output:\n${version}`);
	}
}

function runFile(file, args, options = {}) {
	const result = spawnSync(file, args, {
		encoding: 'utf8',
		windowsHide: true,
		env: options.env,
		timeout: options.timeout ?? 60_000,
	});
	if (result.status !== 0) {
		throw new Error(`${file} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
	}
	return `${result.stdout || ''}${result.stderr || ''}`;
}

async function stagePythonPip(devEnvRoot) {
	const python = join(devEnvRoot, 'Python314', 'python.exe');
	runChecked(python, ['-m', 'ensurepip', '--upgrade'], { timeout: 10 * 60 * 1000 });
	const pipCheck = runFile(python, ['-m', 'pip', '--version'], {});
	if (!/pip/i.test(pipCheck)) {
		throw new Error(`python -m pip is unavailable: ${pipCheck}`);
	}
	await ensureDir(join(devEnvRoot, 'Python314', 'Scripts'));
	const scripts = join(devEnvRoot, 'Python314', 'Scripts');
	if (await pathExists(scripts)) {
		for (const name of await fs.readdir(scripts)) {
			if (!/^pip.*\.(exe|cmd)$/i.test(name)) {
				continue;
			}
			const file = join(scripts, name);
			const bytes = await fs.readFile(file);
			if (bytes.includes(Buffer.from(tmpdir()))) {
				await fs.rm(file, { force: true });
			}
		}
	}
}

async function writePathEntries(devEnvRoot, spec) {
	const payload = {
		path: spec.path,
		env: spec.env ?? {},
		state: spec.state ?? {},
		values: spec.values ?? {},
	};
	await writeJson(join(devEnvRoot, 'path-entries.json'), payload);
}

async function mergePortableSettings(appRoot, settings) {
	const userDir = join(appRoot, 'data', 'user-data', 'User');
	await ensureDir(userDir);
	const settingsPath = join(userDir, 'settings.json');
	const current = (await pathExists(settingsPath)) ? await readJson(settingsPath) : {};
	await writeJson(settingsPath, {
		'extensions.autoCheckUpdates': false,
		'extensions.autoUpdate': false,
		'extensions.ignoreRecommendations': true,
		'telemetry.telemetryLevel': 'off',
		'update.mode': 'none',
		...current,
		...settings,
	});
}

async function verifyStagedTree(appRoot, language, spec, lock, cacheDir) {
	const devEnvRoot = join(appRoot, 'dev-env');
	if (await pathExists(join(appRoot, 'bootstrap'))) {
		throw new Error('bootstrap/ must not exist after staging');
	}
	await assertRequiredFiles(devEnvRoot, spec.extraRequiredFiles ?? [], language);
	for (const id of spec.extensions) {
		const dest = join(appRoot, 'resources', 'app', 'extensions', id.toLowerCase());
		await assertRequiredFiles(dest, lock.assets[id].requiredFiles, id);
	}
	await scanForbiddenAbsolutePaths(devEnvRoot, [cacheDir, tmpdir()].filter(Boolean));
	if (language === 'rust') {
		await forceRustupHardlinks(join(devEnvRoot, '.cargo', 'bin'));
	}
	await assertPeImportsAllowed(devEnvRoot, [join(appRoot, 'resources', 'app')]);
}

async function downloadAsset(asset, cacheDir, inputs) {
	const fileName = decodeURIComponent(asset.url.split('/').pop().split('?')[0]);
	const dest = join(cacheDir, `${asset.id}-${asset.version}-${fileName}`);
	const headers = asset.kind === 'vsix' && /marketplace\.visualstudio\.com/i.test(asset.url) ? MARKET_HEADERS : { 'User-Agent': 'VSCode Build' };
	await downloadVerified(asset.url, dest, asset.sha256, headers);
	inputs.push({ id: asset.id, version: asset.version, url: asset.url, sha256: asset.sha256 });
	return dest;
}

async function inventory(appRoot, language) {
	return {
		language,
		hasBootstrap: await pathExists(join(appRoot, 'bootstrap')),
		devEnv: await pathExists(join(appRoot, 'dev-env', 'path-entries.json')),
		dataTmp: await pathExists(join(appRoot, 'data', 'tmp')),
		extensions: [...(await collectExtensionIds(join(appRoot, 'resources', 'app', 'extensions'))).keys()],
	};
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
