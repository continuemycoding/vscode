#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Shared helpers for locked Windows development-environment staging.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LOCK_FILE = join(REPOSITORY_ROOT, '.github', 'devenv-inputs-win32-x64.lock.json');
export const LANGUAGES = Object.freeze(['cpp', 'go', 'rust', 'csharp', 'javascript', 'typescript', 'python', 'lua']);
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const MARKET_HEADERS = {
	'User-Agent': 'VSCode Build',
	'X-Market-Client-Id': 'VSCode Build',
	'X-Market-User-Id': '291C1CD0-051A-4123-9B4B-30D60EF52EE2',
};
const FLOATING_URL = /(^|\/)latest(\/|$)|channel-rust-stable(?!\.)|dot\.net\/v1\/dotnet-install/i;
const SYSTEM_DLL_ALLOWLIST = new Set([
	'kernel32.dll', 'kernelbase.dll', 'ntdll.dll', 'user32.dll', 'gdi32.dll', 'gdi32full.dll',
	'advapi32.dll', 'sechost.dll', 'rpcrt4.dll', 'ole32.dll', 'oleaut32.dll', 'shell32.dll',
	'shlwapi.dll', 'comdlg32.dll', 'comctl32.dll', 'combase.dll', 'ws2_32.dll', 'wsock32.dll',
	'iphlpapi.dll', 'bcrypt.dll', 'bcryptprimitives.dll', 'crypt32.dll', 'cryptbase.dll',
	'wintrust.dll', 'ncrypt.dll', 'secur32.dll', 'sspicli.dll', 'normaliz.dll', 'dnsapi.dll',
	'mswsock.dll', 'winhttp.dll', 'wininet.dll', 'urlmon.dll', 'imm32.dll', 'msvcrt.dll',
	'ucrtbase.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll',
	'msvcp140_2.dll', 'concrt140.dll', 'vcomp140.dll', 'dbghelp.dll', 'version.dll',
	'psapi.dll', 'setupapi.dll', 'cfgmgr32.dll', 'winmm.dll', 'powrprof.dll', 'pdh.dll',
	'imagehlp.dll', 'dbgcore.dll', 'userenv.dll', 'wtsapi32.dll', 'netapi32.dll',
	'authz.dll', 'credui.dll', 'dwmapi.dll', 'uxtheme.dll', 'dxgi.dll', 'd3d11.dll',
	'd3d12.dll', 'd3d9.dll', 'opengl32.dll', 'glu32.dll', 'hid.dll', 'setupapi.dll',
	'nsi.dll', 'dhcpcsvc.dll', 'wldap32.dll', 'cryptnet.dll', 'wevtapi.dll', 'amsi.dll',
	'srpapi.dll', 'ntmarta.dll', 'wldp.dll', 'kernel.appcore.dll', 'msasn1.dll',
	'windows.storage.dll', 'profapi.dll', 'shcore.dll', 'msctf.dll', 'textshaping.dll',
	'dwrite.dll', 'dxcore.dll', 'win32u.dll', 'zlib1.dll', 'libssl-3-x64.dll', 'libcrypto-3-x64.dll',
]);

export function log(message) {
	console.log(`[devenv] ${message}`);
}

export function parseArgs(argv) {
	const output = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const argument = argv[i];
		if (argument === '--help' || argument === '-h') {
			output.help = true;
			continue;
		}
		if (argument === '--check-lock' || argument === '--common-only') {
			output[argument.slice(2)] = true;
			continue;
		}
		if (!argument.startsWith('--')) {
			output._.push(argument);
			continue;
		}
		const value = argv[i + 1];
		if (value === undefined || value.startsWith('--')) {
			throw new Error(`Missing value for ${argument}`);
		}
		output[argument.slice(2)] = value;
		i++;
	}
	return output;
}

export async function pathExists(target) {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

export const WINDOWS_DESKTOP_EXECUTABLES = Object.freeze(['Code.exe', 'Code - OSS.exe']);

export async function resolveWindowsDesktopExecutable(appRoot) {
	for (const name of WINDOWS_DESKTOP_EXECUTABLES) {
		const file = join(appRoot, name);
		if (await pathExists(file)) {
			return file;
		}
	}
	throw new Error(`App root is missing Code.exe or Code - OSS.exe: ${appRoot}`);
}

export async function normalizeWindowsDesktopExecutable(appRoot) {
	const found = await resolveWindowsDesktopExecutable(appRoot);
	const dest = join(appRoot, 'Code.exe');
	if (found !== dest) {
		await fs.rename(found, dest);
	}
	const fromManifest = join(appRoot, 'Code - OSS.VisualElementsManifest.xml');
	const toManifest = join(appRoot, 'Code.VisualElementsManifest.xml');
	if (await pathExists(fromManifest) && !(await pathExists(toManifest))) {
		await fs.rename(fromManifest, toManifest);
	}
	return dest;
}

export async function ensureDir(dir) {
	await fs.mkdir(dir, { recursive: true });
}

export async function readJson(file) {
	return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function writeJson(file, value) {
	await ensureDir(dirname(file));
	await fs.writeFile(file, JSON.stringify(value, null, '\t') + '\n', 'utf8');
}

export async function sha256File(file) {
	const hash = createHash('sha256');
	await pipeline(createReadStream(file), hash);
	return hash.digest('hex');
}

export async function loadLock(lockFile = LOCK_FILE) {
	if (!(await pathExists(lockFile))) {
		throw new Error(`Missing lock file: ${lockFile}`);
	}
	const lock = await readJson(lockFile);
	validateLock(lock);
	return lock;
}

export function validateLock(lock) {
	if (!lock || lock.schemaVersion !== 1) {
		throw new Error('Lock schemaVersion must be 1');
	}
	if (lock.platform !== 'win32-x64') {
		throw new Error(`Lock platform must be win32-x64, got ${lock.platform}`);
	}
	if (!lock.assets || typeof lock.assets !== 'object') {
		throw new Error('Lock assets must be an object');
	}
	if (!Array.isArray(lock.common?.extensions) || lock.common.extensions.length === 0) {
		throw new Error('Lock common.extensions must be a non-empty array');
	}
	for (const [id, asset] of Object.entries(lock.assets)) {
		validateAsset(id, asset);
	}
	for (const language of LANGUAGES) {
		const spec = lock.languages?.[language];
		if (!spec) {
			throw new Error(`Lock is missing language ${language}`);
		}
		if (!Array.isArray(spec.tools) || !Array.isArray(spec.extensions) || !Array.isArray(spec.path)) {
			throw new Error(`Language ${language} must declare tools, extensions, and path`);
		}
		for (const assetId of [...spec.tools, ...spec.extensions, ...(spec.modules ?? [])]) {
			if (!lock.assets[assetId]) {
				throw new Error(`Language ${language} references unknown asset ${assetId}`);
			}
		}
		assertRelativeManifest(spec.path, spec.env ?? {}, spec.state ?? {}, spec.values ?? {});
	}
	for (const id of lock.common.extensions) {
		if (!lock.assets[id]) {
			throw new Error(`Common extension references unknown asset ${id}`);
		}
		if (lock.assets[id].kind !== 'vsix') {
			throw new Error(`Common asset ${id} must be a vsix`);
		}
	}
}

function validateAsset(id, asset) {
	if (!asset || asset.id !== id) {
		throw new Error(`Asset ${id} must have a matching id field`);
	}
	if (!['archive', 'vsix', 'binary', 'go-module'].includes(asset.kind)) {
		throw new Error(`Asset ${id} has unsupported kind ${asset.kind}`);
	}
	if (!asset.version || typeof asset.version !== 'string' || /latest/i.test(asset.version)) {
		throw new Error(`Asset ${id} must have a concrete version`);
	}
	if (asset.platform !== 'win32-x64') {
		throw new Error(`Asset ${id} platform must be win32-x64`);
	}
	if (typeof asset.url !== 'string' || !/^https:\/\//i.test(asset.url) || FLOATING_URL.test(asset.url)) {
		throw new Error(`Asset ${id} has a floating or invalid URL: ${asset.url}`);
	}
	if (!SHA256_PATTERN.test(asset.sha256)) {
		throw new Error(`Asset ${id} sha256 must be a 64-character lowercase hex digest`);
	}
	if (!Array.isArray(asset.requiredFiles) || asset.requiredFiles.length === 0) {
		throw new Error(`Asset ${id} must declare requiredFiles`);
	}
	for (const file of asset.requiredFiles) {
		assertRelativePath(file, `${id}.requiredFiles`);
	}
	if (!Array.isArray(asset.extensionDependencies)) {
		throw new Error(`Asset ${id} must declare extensionDependencies`);
	}
	if (asset.kind === 'vsix' && asset.targetPlatform !== 'win32-x64' && asset.targetPlatform !== 'universal') {
		throw new Error(`VSIX ${id} must pin targetPlatform to win32-x64 or universal`);
	}
	if (asset.kind === 'go-module' && (!asset.module || !asset.install)) {
		throw new Error(`Go module ${id} must declare module and install`);
	}
}

function assertRelativeManifest(pathEntries, env, state, values) {
	for (const entry of pathEntries) {
		assertRelativePath(entry, 'path');
	}
	for (const [name, value] of Object.entries(env)) {
		assertEnvName(name);
		assertRelativePath(value, `env.${name}`);
	}
	for (const [name, value] of Object.entries(state)) {
		assertEnvName(name);
		assertRelativePath(value, `state.${name}`);
	}
	for (const [name, value] of Object.entries(values)) {
		assertEnvName(name);
		if (typeof value !== 'string' || !value || /^\s|\s$/.test(value) || value.includes('\0')) {
			throw new Error(`Invalid literal environment value for ${name}`);
		}
	}
}

export function assertRelativePath(value, property) {
	if (typeof value !== 'string' || !value || /^\s|\s$/.test(value) || value.includes('\0') || value.includes(';')) {
		throw new Error(`Invalid relative path for ${property}`);
	}
	const normalized = value.replace(/\\/g, '/');
	if (isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
		throw new Error(`${property} must be a relative path without traversal: ${value}`);
	}
}

function assertEnvName(name) {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.toUpperCase() === 'PATH' || name.toUpperCase().startsWith('VSCODE_') || name.toUpperCase().startsWith('ELECTRON_')) {
		throw new Error(`Invalid environment variable name: ${name}`);
	}
}

export async function downloadVerified(url, dest, sha256, headers = {}) {
	if (!SHA256_PATTERN.test(sha256)) {
		throw new Error(`Cannot download ${url}: lock sha256 is invalid`);
	}
	if (await pathExists(dest)) {
		const existing = await sha256File(dest);
		if (existing === sha256) {
			log(`Cache hit ${dest}`);
			return dest;
		}
		log(`Cache mismatch for ${dest}, re-downloading`);
		await fs.rm(dest, { force: true });
	}
	await ensureDir(dirname(dest));
	log(`Downloading ${url}`);
	const response = await fetch(url, { headers, redirect: 'follow' });
	if (!response.ok) {
		throw new Error(`Download failed HTTP ${response.status}: ${url}`);
	}
	const partial = `${dest}.partial`;
	await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
	let bytes = await fs.readFile(partial);
	if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
		bytes = gunzipSync(bytes);
		await fs.writeFile(partial, bytes);
	}
	const actual = createHash('sha256').update(bytes).digest('hex');
	if (actual !== sha256) {
		await fs.rm(partial, { force: true });
		throw new Error(`SHA-256 mismatch for ${url}: expected ${sha256}, got ${actual}`);
	}
	await fs.rename(partial, dest);
	log(`Verified ${dest} (${bytes.length} bytes)`);
	return dest;
}

export function listArchiveEntries(archive) {
	const result = spawnSync('tar', ['-tf', archive], {
		encoding: 'utf8',
		maxBuffer: 128 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(`Cannot list archive ${archive}: ${result.stderr || result.stdout}`);
	}
	return result.stdout.split(/\r?\n/).map(entry => entry.trim()).filter(Boolean);
}

export function assertSafeArchiveEntries(entries, { vsix = false } = {}) {
	for (const entry of entries) {
		const normalized = entry.replace(/\\/g, '/');
		if (!normalized || normalized.includes('\0')) {
			throw new Error(`Archive contains an empty or illegal entry: ${entry}`);
		}
		if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
			throw new Error(`Archive entry escapes the destination: ${entry}`);
		}
		if (vsix && !/^(extension\/|\[Content_Types\]\.xml$|extension\.vsixmanifest$)/i.test(normalized)) {
			continue;
		}
	}
}

export async function extractZipTo(archive, destDir) {
	const entries = listArchiveEntries(archive);
	assertSafeArchiveEntries(entries);
	await fs.rm(destDir, { recursive: true, force: true });
	await ensureDir(destDir);
	const result = spawnSync('tar', ['-xf', archive, '-C', destDir], { encoding: 'utf8', windowsHide: true });
	if (result.status !== 0) {
		throw new Error(`Extract failed for ${archive}: ${result.stderr || result.stdout}`);
	}
	await assertExtractedTreeStaysInside(destDir);
}

export async function extractZipFlatten(archive, destDir) {
	const staging = `${destDir}.__extract`;
	await extractZipTo(archive, staging);
	const children = (await fs.readdir(staging, { withFileTypes: true }))
		.filter(entry => entry.name !== '.' && entry.name !== '..');
	const source = children.length === 1 && children[0].isDirectory() ? join(staging, children[0].name) : staging;
	await fs.rm(destDir, { recursive: true, force: true });
	await ensureDir(dirname(destDir));
	await fs.rename(source, destDir);
	await fs.rm(staging, { recursive: true, force: true });
}

export async function extractVsixToExtension(vsixPath, destDir, expected) {
	const entries = listArchiveEntries(vsixPath);
	assertSafeArchiveEntries(entries, { vsix: true });
	const staging = `${destDir}.__vsix`;
	await extractZipTo(vsixPath, staging);
	const extensionRoot = join(staging, 'extension');
	if (!(await pathExists(join(extensionRoot, 'package.json')))) {
		throw new Error(`VSIX is missing extension/package.json: ${vsixPath}`);
	}
	const manifest = await readJson(join(extensionRoot, 'package.json'));
	const actualId = `${manifest.publisher}.${manifest.name}`.toLowerCase();
	if (actualId !== expected.id.toLowerCase()) {
		throw new Error(`VSIX identity mismatch: expected ${expected.id}, got ${actualId}`);
	}
	if (manifest.version !== expected.version) {
		throw new Error(`VSIX version mismatch for ${expected.id}: expected ${expected.version}, got ${manifest.version}`);
	}
	if (!manifest.engines?.vscode) {
		throw new Error(`VSIX ${expected.id} is missing engines.vscode`);
	}
	await fs.rm(destDir, { recursive: true, force: true });
	await copyTree(extensionRoot, destDir);
	await fs.rm(staging, { recursive: true, force: true });
	return manifest;
}

async function copyTree(source, dest) {
	const sourceRoot = resolve(source);
	await ensureDir(dest);
	const queue = [''];
	while (queue.length > 0) {
		const relativeDir = queue.shift();
		const fromDir = relativeDir ? join(sourceRoot, relativeDir) : sourceRoot;
		for (const entry of await fs.readdir(fromDir, { withFileTypes: true })) {
			const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
			if (rel.split(/[\\/]/).includes('..')) {
				throw new Error(`Refusing to copy traversed path: ${rel}`);
			}
			const from = join(sourceRoot, rel);
			const to = join(dest, rel);
			if (!isInside(dest, to) || !isInside(sourceRoot, from)) {
				throw new Error(`Copy escaped staging roots: ${rel}`);
			}
			if (entry.isDirectory()) {
				await ensureDir(to);
				queue.push(rel);
			} else if (entry.isFile()) {
				await ensureDir(dirname(to));
				await fs.copyFile(from, to);
			} else {
				throw new Error(`Refusing to copy non-file ${rel}`);
			}
		}
	}
}

async function assertExtractedTreeStaysInside(root) {
	const rootResolved = resolve(root);
	const queue = [rootResolved];
	while (queue.length > 0) {
		const current = queue.shift();
		for (const entry of await fs.readdir(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (!isInside(rootResolved, full)) {
				throw new Error(`Extracted path escaped ${root}: ${full}`);
			}
			if (entry.isDirectory()) {
				queue.push(full);
			}
		}
	}
}

export function isInside(root, candidate) {
	const relativePath = relative(resolve(root), resolve(candidate));
	return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

export async function writeKeepDir(dir) {
	await ensureDir(dir);
	await fs.writeFile(join(dir, '.keep'), '', 'utf8');
}

export async function assertRequiredFiles(root, files, label) {
	for (const file of files) {
		assertRelativePath(file, `${label}.requiredFiles`);
		const full = join(root, file);
		if (!isInside(root, full) || !(await pathExists(full))) {
			throw new Error(`Missing required file for ${label}: ${file}`);
		}
	}
}

export async function collectExtensionIds(extensionsRoot) {
	const ids = new Map();
	if (!(await pathExists(extensionsRoot))) {
		return ids;
	}
	for (const entry of await fs.readdir(extensionsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const manifestPath = join(extensionsRoot, entry.name, 'package.json');
		if (!(await pathExists(manifestPath))) {
			continue;
		}
		const manifest = await readJson(manifestPath);
		const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
		if (ids.has(id)) {
			throw new Error(`Duplicate extension id ${id}: ${ids.get(id)} and ${entry.name}`);
		}
		ids.set(id, entry.name);
	}
	return ids;
}

export async function scanForbiddenAbsolutePaths(root, needles) {
	const matches = [];
	const queue = [root];
	while (queue.length > 0) {
		const current = queue.shift();
		let entries = [];
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(full);
				continue;
			}
			if (!entry.isFile() || !/\.(json|toml|config|ps1|cmd|bat|txt|xml|props|targets|ini|rc)$/i.test(entry.name)) {
				continue;
			}
			let text;
			try {
				text = await fs.readFile(full, 'utf8');
			} catch {
				continue;
			}
			for (const needle of needles) {
				if (needle && text.toLowerCase().includes(needle.toLowerCase())) {
					matches.push({ file: full, needle });
				}
			}
		}
	}
	if (matches.length > 0) {
		throw new Error(`Staged files contain cache/staging absolute paths: ${matches.slice(0, 8).map(match => `${relative(root, match.file)}`).join(', ')}`);
	}
}

export async function forceRustupHardlinks(cargoBin) {
	const rustup = join(cargoBin, 'rustup.exe');
	if (!(await pathExists(rustup))) {
		throw new Error(`rustup.exe missing at ${rustup}`);
	}
	const rustupStat = await fs.stat(rustup);
	for (const name of ['rustc.exe', 'cargo.exe', 'rustdoc.exe', 'rustup.exe']) {
		const proxy = join(cargoBin, name);
		if (!(await pathExists(proxy))) {
			if (name === 'rustup.exe') {
				throw new Error('rustup.exe missing after install');
			}
			continue;
		}
		const stat = await fs.stat(proxy);
		if (stat.ino === rustupStat.ino && stat.dev === rustupStat.dev) {
			continue;
		}
		await fs.rm(proxy, { force: true });
		await fs.link(rustup, proxy);
	}
}

export function run(file, args, options = {}) {
	const result = spawnSync(file, args, {
		encoding: 'utf8',
		stdio: options.stdio ?? 'pipe',
		env: options.env,
		cwd: options.cwd,
		timeout: options.timeout ?? 10 * 60 * 1000,
		windowsHide: true,
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.status !== 0 && !options.allowFailure) {
		throw new Error(`${file} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
	}
	return result;
}

export function runChecked(file, args, options = {}) {
	execFileSync(file, args, {
		stdio: options.stdio ?? 'inherit',
		env: options.env,
		cwd: options.cwd,
		timeout: options.timeout ?? 30 * 60 * 1000,
		windowsHide: true,
	});
}

export async function assertPeImportsAllowed(root, extraRoots = []) {
	const allowRoots = [root, ...extraRoots].map(value => resolve(value));
	const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
	const localNames = await indexNativeFileNames(allowRoots);
	const queue = [root];
	while (queue.length > 0) {
		const current = queue.shift();
		let entries = [];
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(full);
				continue;
			}
			if (!entry.isFile() || !/\.(exe|dll)$/i.test(entry.name)) {
				continue;
			}
			const imports = readPeImportDlls(full);
			if (!imports) {
				continue;
			}
			for (const dll of imports) {
				const name = dll.toLowerCase();
				if (name.startsWith('api-ms-win-') || name.startsWith('ext-ms-') || SYSTEM_DLL_ALLOWLIST.has(name) || localNames.has(name)) {
					continue;
				}
				if (await pathExists(join(dirname(full), dll)) || await pathExists(join(system32, dll))) {
					continue;
				}
				throw new Error(`${relative(root, full)} imports disallowed DLL ${dll}`);
			}
		}
	}
}

async function indexNativeFileNames(roots) {
	const names = new Set();
	for (const root of roots) {
		const queue = [root];
		while (queue.length > 0) {
			const current = queue.shift();
			let entries = [];
			try {
				entries = await fs.readdir(current, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (entry.isDirectory()) {
					queue.push(join(current, entry.name));
				} else if (entry.isFile() && /\.(exe|dll)$/i.test(entry.name)) {
					names.add(entry.name.toLowerCase());
				}
			}
		}
	}
	return names;
}

function readPeImportDlls(file) {
	let buffer;
	try {
		buffer = readFileSync(file);
	} catch {
		return undefined;
	}
	if (buffer.length < 64 || buffer.toString('ascii', 0, 2) !== 'MZ') {
		return undefined;
	}
	const peOffset = buffer.readUInt32LE(0x3c);
	if (peOffset + 24 > buffer.length || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
		return undefined;
	}
	const machine = buffer.readUInt16LE(peOffset + 4);
	if (machine !== 0x8664 && machine !== 0x14c) {
		return undefined;
	}
	const optionalHeaderSize = buffer.readUInt16LE(peOffset + 20);
	const optionalHeader = peOffset + 24;
	const magic = buffer.readUInt16LE(optionalHeader);
	const isPe32Plus = magic === 0x20b;
	if (!isPe32Plus && magic !== 0x10b) {
		return undefined;
	}
	const importDir = optionalHeader + (isPe32Plus ? 120 : 104);
	if (importDir + 8 > buffer.length) {
		return undefined;
	}
	const importRva = buffer.readUInt32LE(importDir);
	const numberOfSections = buffer.readUInt16LE(peOffset + 6);
	const sectionTable = optionalHeader + optionalHeaderSize;
	if (importRva === 0) {
		return [];
	}
	const importOffset = rvaToOffset(buffer, sectionTable, numberOfSections, importRva);
	if (importOffset === undefined) {
		return [];
	}
	const dlls = [];
	for (let index = 0; ; index++) {
		const descriptor = importOffset + index * 20;
		if (descriptor + 20 > buffer.length) {
			break;
		}
		const nameRva = buffer.readUInt32LE(descriptor + 12);
		if (buffer.readUInt32LE(descriptor) === 0 && nameRva === 0) {
			break;
		}
		const nameOffset = rvaToOffset(buffer, sectionTable, numberOfSections, nameRva);
		if (nameOffset === undefined) {
			continue;
		}
		dlls.push(readCString(buffer, nameOffset));
	}
	return dlls;
}

function rvaToOffset(buffer, sectionTable, numberOfSections, rva) {
	for (let i = 0; i < numberOfSections; i++) {
		const section = sectionTable + i * 40;
		if (section + 40 > buffer.length) {
			return undefined;
		}
		const virtualAddress = buffer.readUInt32LE(section + 12);
		const virtualSize = buffer.readUInt32LE(section + 8);
		const rawSize = buffer.readUInt32LE(section + 16);
		const rawPtr = buffer.readUInt32LE(section + 20);
		const size = Math.max(virtualSize, rawSize);
		if (rva >= virtualAddress && rva < virtualAddress + size) {
			return rawPtr + (rva - virtualAddress);
		}
	}
	return undefined;
}

function readCString(buffer, offset) {
	let end = offset;
	while (end < buffer.length && buffer[end] !== 0) {
		end++;
	}
	return buffer.toString('utf8', offset, end);
}

