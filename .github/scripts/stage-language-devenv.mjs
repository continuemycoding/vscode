#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Stage language-specific debug toolchains into a packaged VS Code tree.
 *
 * Downloads / installs tools the same way as RemotePro windowsDevEnvInstaller.ts:
 *   - zip tools: download + extract into bootstrap/dev-env/
 *   - installer tools (Python / rustup / dotnet-install): run at build time into package dirs
 * Then writes path-entries.json for DefaultDevEnvInitializer (user PATH only on first run).
 * Also downloads language debug adapter VSIXes into bootstrap/extensions/.
 *
 * Usage:
 *   node .github/scripts/stage-language-devenv.mjs --app-root <VSCode-win32-x64> --language go
 *   node .github/scripts/stage-language-devenv.mjs --app-root <dir> --language python --cache-dir <dir>
 *--------------------------------------------------------------------------------------------*/

import { createWriteStream, promises as fs } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
const CSHARP_DOTNET_MAJOR = 10;
const RUST_GNU_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu';
const PYTHON_INSTALL_SERIES = '3.14';

const MARKET_HEADERS = {
	'User-Agent': 'VSCode Build',
	'X-Market-Client-Id': 'VSCode Build',
	'X-Market-User-Id': '291C1CD0-051A-4123-9B4B-30D60EF52EE2',
};

const LANGUAGES = new Set(['go', 'python', 'nodejs', 'cpp', 'csharp', 'rust']);

/** @type {Record<string, Array<{ id: string, file: string }>>} */
const LANGUAGE_VSIX = {
	go: [{ id: 'golang.go', file: 'golang.go.vsix' }],
	python: [
		{ id: 'ms-python.python', file: 'ms-python.python.vsix' },
		{ id: 'ms-python.debugpy', file: 'ms-python.debugpy.vsix' },
	],
	nodejs: [],
	cpp: [
		{ id: 'ms-vscode.cpptools', file: 'ms-vscode.cpptools.vsix' },
		{ id: 'ms-vscode.cmake-tools', file: 'ms-vscode.cmake-tools.vsix' },
	],
	csharp: [
		{ id: 'ms-dotnettools.vscode-dotnet-runtime', file: 'ms-dotnettools.vscode-dotnet-runtime.vsix' },
		{ id: 'ms-dotnettools.csharp', file: 'ms-dotnettools.csharp.vsix' },
	],
	rust: [
		{ id: 'rust-lang.rust-analyzer', file: 'rust-lang.rust-analyzer.vsix' },
		{ id: 'vadimcn.vscode-lldb', file: 'vadimcn.vscode-lldb.vsix' },
	],
};

function parseArgs(argv) {
	const out = { appRoot: undefined, language: undefined, cacheDir: undefined, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = argv[i + 1];
		if (a === '--app-root' && next) {
			out.appRoot = next;
			i++;
		} else if (a === '--language' && next) {
			out.language = next;
			i++;
		} else if (a === '--cache-dir' && next) {
			out.cacheDir = next;
			i++;
		} else if (a === '--help' || a === '-h') {
			out.help = true;
		} else {
			throw new Error(`Unknown or incomplete argument: ${a}`);
		}
	}
	return out;
}

function printHelp() {
	console.log(`Stage language debug env into packaged VS Code

Usage:
  node stage-language-devenv.mjs --app-root <VSCode-win32-x64> --language <${[...LANGUAGES].join('|')}> [--cache-dir <dir>]
`);
}

function log(msg) {
	console.log(`[stage-devenv] ${msg}`);
}

async function ensureDir(dir) {
	await fs.mkdir(dir, { recursive: true });
}

async function pathExists(p) {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function downloadFile(url, dest, headers = {}) {
	if (await pathExists(dest)) {
		const st = await fs.stat(dest);
		if (st.size > 100) {
			log(`Cache hit: ${basename(dest)} (${st.size} bytes)`);
			return dest;
		}
	}
	log(`Downloading ${url}`);
	await ensureDir(dirname(dest));
	const res = await fetch(url, { headers, redirect: 'follow' });
	if (!res.ok) {
		throw new Error(`Download failed HTTP ${res.status}: ${url}`);
	}
	const tmp = `${dest}.partial`;
	await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
	await fs.rename(tmp, dest);
	const st = await fs.stat(dest);
	log(`Downloaded ${basename(dest)} (${st.size} bytes)`);
	return dest;
}

async function fetchJson(url, headers = {}) {
	const res = await fetch(url, { headers, redirect: 'follow' });
	if (!res.ok) {
		throw new Error(`fetchJson HTTP ${res.status}: ${url}`);
	}
	return res.json();
}

/** Extract zip; if single top-level folder, flatten into destDir (RemotePro extractZipFlatten). */
async function extractZipFlatten(zipPath, destDir) {
	const staging = `${destDir}.__extract`;
	await fs.rm(staging, { recursive: true, force: true });
	await fs.rm(destDir, { recursive: true, force: true });
	await ensureDir(staging);
	execFileSync('tar', ['-xf', zipPath, '-C', staging], { stdio: 'inherit' });

	const kids = (await fs.readdir(staging, { withFileTypes: true }))
		.filter(d => d.name !== '.' && d.name !== '..');
	let source = staging;
	if (kids.length === 1 && kids[0].isDirectory()) {
		source = join(staging, kids[0].name);
	}
	await ensureDir(dirname(destDir));
	await fs.rename(source, destDir);
	await fs.rm(staging, { recursive: true, force: true });
}

async function resolveGithubAsset(repo, predicate) {
	const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, {
		Accept: 'application/vnd.github+json',
		'User-Agent': 'VSCode-Build',
		...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
	});
	const asset = (release.assets || []).find(a => predicate(a.name));
	if (!asset) {
		throw new Error(`No matching asset in ${repo} latest release`);
	}
	return { name: asset.name, url: asset.browser_download_url };
}

async function writePathEntries(devEnvRoot, pathRels, envRels = {}) {
	const payload = { path: pathRels, env: envRels };
	const file = join(devEnvRoot, 'path-entries.json');
	await fs.writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
	log(`Wrote ${file}`);
}

async function downloadMarketplaceVsix(extensionId, destPath) {
	const [publisher, name] = extensionId.split('.');
	if (!publisher || !name) {
		throw new Error(`Invalid extension id: ${extensionId}`);
	}
	const url = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${publisher}/vsextensions/${name}/latest/vspackage`;
	log(`Downloading VSIX ${extensionId}`);
	const res = await fetch(url, { headers: MARKET_HEADERS, redirect: 'follow' });
	if (!res.ok) {
		throw new Error(`VSIX download failed HTTP ${res.status}: ${extensionId}`);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length < 100) {
		throw new Error(`Empty VSIX for ${extensionId}`);
	}
	const vsixBuf = (buf[0] === 0x1f && buf[1] === 0x8b) ? gunzipSync(buf) : buf;
	await ensureDir(dirname(destPath));
	await fs.writeFile(destPath, vsixBuf);
	log(`Saved ${basename(destPath)} (${vsixBuf.length} bytes)`);
}

async function readVsixManifest(vsixPath) {
	const result = spawnSync('tar', ['-xOf', vsixPath, 'extension/package.json'], {
		encoding: 'utf8',
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(`Cannot read extension/package.json from ${vsixPath}: ${result.stderr}`);
	}
	return JSON.parse(result.stdout);
}

async function stageVsixes(appRoot, language) {
	const destDir = join(appRoot, 'bootstrap', 'extensions');
	await ensureDir(destDir);
	const items = LANGUAGE_VSIX[language] || [];
	for (const item of items) {
		await downloadMarketplaceVsix(item.id, join(destDir, item.file));
	}

	const stagedIds = new Set(items.map(item => item.id.toLowerCase()));
	for (const item of items) {
		const manifest = await readVsixManifest(join(destDir, item.file));
		const actualId = `${manifest.publisher}.${manifest.name}`.toLowerCase();
		if (actualId !== item.id.toLowerCase()) {
			throw new Error(`VSIX identity mismatch: expected ${item.id}, got ${actualId}`);
		}
		const missing = (manifest.extensionDependencies || []).filter(id => !stagedIds.has(id.toLowerCase()));
		if (missing.length > 0) {
			throw new Error(`${item.id} has unstaged extension dependencies: ${missing.join(', ')}`);
		}
	}
}

// ---- language stages ----

async function stageGo(devEnvRoot, cacheDir) {
	const releases = await fetchJson('https://go.dev/dl/?mode=json');
	const stable = releases.find(r => r.stable);
	if (!stable) {
		throw new Error('No stable Go release');
	}
	const file = stable.files.find(f => f.os === 'windows' && f.arch === 'amd64' && f.kind === 'archive');
	if (!file) {
		throw new Error(`No Go windows amd64 archive for ${stable.version}`);
	}
	const zipPath = await downloadFile(`https://go.dev/dl/${file.filename}`, join(cacheDir, file.filename));
	const goDir = join(devEnvRoot, 'Go');
	await extractZipFlatten(zipPath, goDir);

	const goBin = join(goDir, 'bin', 'go.exe');
	if (!(await pathExists(goBin))) {
		throw new Error(`go.exe missing after extract: ${goBin}`);
	}

	const toolsDir = join(devEnvRoot, 'tools');
	await ensureDir(toolsDir);
	const gopath = join(cacheDir, 'gopath-dlv');
	await ensureDir(gopath);
	log('Installing dlv via go install…');
	execFileSync(goBin, ['install', 'github.com/go-delve/delve/cmd/dlv@latest'], {
		stdio: 'inherit',
		env: {
			...process.env,
			GOROOT: goDir,
			GOPATH: gopath,
			GOBIN: toolsDir,
			PATH: `${join(goDir, 'bin')};${process.env.PATH || ''}`,
		},
		timeout: 10 * 60 * 1000,
	});
	if (!(await pathExists(join(toolsDir, 'dlv.exe')))) {
		throw new Error('dlv.exe not found after go install');
	}

	await writePathEntries(devEnvRoot, ['Go/bin', 'tools']);
}

async function stageNode(devEnvRoot, cacheDir) {
	const index = await fetchJson('https://nodejs.org/dist/index.json');
	const lts = index.find(e => e.lts && e.files.includes('win-x64-zip'));
	if (!lts) {
		throw new Error('No Node.js LTS win-x64 zip');
	}
	const ver = lts.version;
	const filename = `node-${ver}-win-x64.zip`;
	const zipPath = await downloadFile(`https://nodejs.org/dist/${ver}/${filename}`, join(cacheDir, filename));
	await extractZipFlatten(zipPath, join(devEnvRoot, 'nodejs'));
	if (!(await pathExists(join(devEnvRoot, 'nodejs', 'node.exe')))) {
		throw new Error('node.exe missing after extract');
	}
	await writePathEntries(devEnvRoot, ['nodejs']);
}

async function stageCmake(devEnvRoot, cacheDir) {
	let zipName;
	let zipUrl;
	try {
		const index = await fetchJson('https://cmake.org/files/LatestRelease/cmake-latest-files-v1.json');
		const zip = index.files?.find(f => f.name.endsWith('-windows-x86_64.zip'));
		if (zip) {
			zipName = zip.name;
			zipUrl = `https://cmake.org/files/LatestRelease/${zip.name}`;
		}
	} catch {
		// fall through
	}
	if (!zipUrl || !zipName) {
		const asset = await resolveGithubAsset('Kitware/CMake', n => n.endsWith('-windows-x86_64.zip'));
		zipName = asset.name;
		zipUrl = asset.url;
	}
	const zipPath = await downloadFile(zipUrl, join(cacheDir, zipName));
	await extractZipFlatten(zipPath, join(devEnvRoot, 'CMake'));
	if (!(await pathExists(join(devEnvRoot, 'CMake', 'bin', 'cmake.exe')))) {
		throw new Error('cmake.exe missing after extract');
	}
}

async function stageNinja(devEnvRoot, cacheDir) {
	let name = 'ninja-win.zip';
	let url;
	try {
		const asset = await resolveGithubAsset('ninja-build/ninja', n => n === 'ninja-win.zip');
		name = asset.name;
		url = asset.url;
	} catch {
		url = 'https://github.com/ninja-build/ninja/releases/download/v1.12.1/ninja-win.zip';
	}
	const zipPath = await downloadFile(url, join(cacheDir, name));
	await extractZipFlatten(zipPath, join(devEnvRoot, 'Ninja'));
	if (!(await pathExists(join(devEnvRoot, 'Ninja', 'ninja.exe')))) {
		throw new Error('ninja.exe missing after extract');
	}
}

async function stageMingw(devEnvRoot, cacheDir) {
	const asset = await resolveGithubAsset(
		'brechtsanders/winlibs_mingw',
		name => /^winlibs-x86_64-posix-seh-gcc-.*\.zip$/i.test(name) && !/\.(sha256|sha512)$/i.test(name),
	);
	const zipPath = await downloadFile(asset.url, join(cacheDir, asset.name));
	await extractZipFlatten(zipPath, join(devEnvRoot, 'MinGW'));
	if (!(await pathExists(join(devEnvRoot, 'MinGW', 'bin', 'gcc.exe')))) {
		throw new Error('gcc.exe missing after MinGW extract');
	}
}

async function stageCpp(devEnvRoot, cacheDir) {
	await stageCmake(devEnvRoot, cacheDir);
	await stageNinja(devEnvRoot, cacheDir);
	await stageMingw(devEnvRoot, cacheDir);
	await writePathEntries(devEnvRoot, ['CMake/bin', 'Ninja', 'MinGW/bin']);
}

async function latestPythonInstallVersion() {
	const releases = await fetchJson('https://www.python.org/api/v2/downloads/release/');
	const versions = releases
		.filter(release => release.is_published && !release.pre_release)
		.map(release => new RegExp(`^Python (${PYTHON_INSTALL_SERIES.replace('.', '\\.')})\\.(\\d+)$`).exec(release.name))
		.filter(match => match !== null)
		.map(match => ({ version: match[0].slice('Python '.length), patch: Number(match[2]) }))
		.sort((a, b) => b.patch - a.patch);
	if (!versions[0]) {
		throw new Error(`No stable Python ${PYTHON_INSTALL_SERIES} release`);
	}
	return versions[0].version;
}

async function stagePython(devEnvRoot, cacheDir) {
	log(`Resolving latest Python ${PYTHON_INSTALL_SERIES} release…`);
	const version = await latestPythonInstallVersion();
	const filename = `python-${version}-amd64.exe`;
	const url = `https://www.python.org/ftp/python/${version}/${filename}`;
	const exePath = await downloadFile(url, join(cacheDir, filename));
	const targetDirName = `Python${PYTHON_INSTALL_SERIES.replace('.', '')}`;
	const targetDir = join(devEnvRoot, targetDirName);
	await fs.rm(targetDir, { recursive: true, force: true });
	// Do not pre-create TargetDir — empty dir can hang the official installer.
	log(`Installing Python silently into ${targetDir}`);
	const args = [
		'/quiet',
		`TargetDir=${targetDir}`,
		'InstallAllUsers=0',
		'PrependPath=0',
		'Include_test=0',
		'Include_launcher=0',
		'Include_doc=0',
		'Include_pip=1',
		'SimpleInstall=1',
	].join(' ');
	const ps = [
		`$p = Start-Process -FilePath '${exePath.replace(/'/g, "''")}' -ArgumentList '${args.replace(/'/g, "''")}' -Wait -PassThru -WindowStyle Hidden`,
		`exit $p.ExitCode`,
	].join('; ');
	const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
		stdio: 'inherit',
		windowsHide: true,
		timeout: 20 * 60 * 1000,
	});
	if (result.status !== 0) {
		throw new Error(`Python installer exited with code ${result.status}`);
	}
	if (!(await pathExists(join(targetDir, 'python.exe')))) {
		throw new Error('python.exe missing after silent install');
	}
	await writePathEntries(devEnvRoot, [targetDirName, `${targetDirName}/Scripts`]);
}

async function stageCsharp(devEnvRoot, cacheDir) {
	const scriptPath = await downloadFile('https://dot.net/v1/dotnet-install.ps1', join(cacheDir, 'dotnet-install.ps1'));
	const installDir = join(devEnvRoot, 'dotnet');
	await ensureDir(installDir);
	const channel = `${CSHARP_DOTNET_MAJOR}.0`;
	const baseArgs = [
		'-NoProfile', '-ExecutionPolicy', 'Bypass',
		'-File', scriptPath,
		'-Channel', channel,
		'-InstallDir', installDir,
	];
	log('Installing .NET SDK…');
	execFileSync('powershell.exe', baseArgs, { stdio: 'inherit', timeout: 20 * 60 * 1000 });
	log('Installing .NET Runtime…');
	execFileSync('powershell.exe', [...baseArgs, '-Runtime', 'dotnet'], {
		stdio: 'inherit',
		timeout: 20 * 60 * 1000,
	});
	if (!(await pathExists(join(installDir, 'dotnet.exe')))) {
		throw new Error('dotnet.exe missing after install');
	}
	await writePathEntries(devEnvRoot, ['dotnet']);
}

async function stageRust(devEnvRoot, cacheDir) {
	const cargoHome = join(devEnvRoot, '.cargo');
	const rustupHome = join(devEnvRoot, '.rustup');
	await ensureDir(cargoHome);
	await ensureDir(rustupHome);

	const initUrl = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe';
	const initPath = await downloadFile(initUrl, join(cacheDir, 'rustup-init.exe'));
	log(`Running rustup-init with ${RUST_GNU_TOOLCHAIN}…`);
	execFileSync(initPath, ['-y', '--default-toolchain', RUST_GNU_TOOLCHAIN, '--default-host', 'x86_64-pc-windows-gnu', '--no-modify-path'], {
		stdio: 'inherit',
		env: {
			...process.env,
			CARGO_HOME: cargoHome,
			RUSTUP_HOME: rustupHome,
		},
		timeout: 30 * 60 * 1000,
	});

	const rustup = join(cargoHome, 'bin', 'rustup.exe');
	const rustc = join(cargoHome, 'bin', 'rustc.exe');
	const cargo = join(cargoHome, 'bin', 'cargo.exe');
	if (!(await pathExists(rustup)) || !(await pathExists(rustc)) || !(await pathExists(cargo))) {
		throw new Error('rustup, rustc, or cargo missing after rustup-init');
	}
	const activeToolchain = execFileSync(rustup, ['show', 'active-toolchain'], {
		encoding: 'utf8',
		env: {
			...process.env,
			CARGO_HOME: cargoHome,
			RUSTUP_HOME: rustupHome,
		},
	}).trim();
	if (!activeToolchain.startsWith(RUST_GNU_TOOLCHAIN)) {
		throw new Error(`Unexpected active Rust toolchain: ${activeToolchain}`);
	}

	await stageMingw(devEnvRoot, cacheDir);
	await writePathEntries(devEnvRoot, ['.cargo/bin', 'MinGW/bin'], {
		CARGO_HOME: '.cargo',
		RUSTUP_HOME: '.rustup',
	});
}

async function stageLanguage(language, devEnvRoot, cacheDir) {
	switch (language) {
		case 'go':
			return stageGo(devEnvRoot, cacheDir);
		case 'python':
			return stagePython(devEnvRoot, cacheDir);
		case 'nodejs':
			return stageNode(devEnvRoot, cacheDir);
		case 'cpp':
			return stageCpp(devEnvRoot, cacheDir);
		case 'csharp':
			return stageCsharp(devEnvRoot, cacheDir);
		case 'rust':
			return stageRust(devEnvRoot, cacheDir);
		default:
			throw new Error(`Unsupported language: ${language}`);
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printHelp();
		return;
	}
	if (!args.appRoot || !args.language) {
		printHelp();
		throw new Error('--app-root and --language are required');
	}
	const language = String(args.language).toLowerCase();
	if (!LANGUAGES.has(language)) {
		throw new Error(`Unsupported language: ${language}. Use one of: ${[...LANGUAGES].join(', ')}`);
	}

	const appRoot = args.appRoot;
	const cacheDir = args.cacheDir || join(tmpdir(), 'vscode-devenv-cache', language);
	await ensureDir(cacheDir);

	const devEnvRoot = join(appRoot, 'bootstrap', 'dev-env');
	await fs.rm(devEnvRoot, { recursive: true, force: true });
	await ensureDir(devEnvRoot);

	log(`Staging ${language} into ${devEnvRoot}`);
	await stageLanguage(language, devEnvRoot, cacheDir);
	await stageVsixes(appRoot, language);
	log(`Done staging ${language}`);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
