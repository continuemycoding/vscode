#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..', '..');
const TEST_EXTENSION_ROOT = path.join(REPOSITORY_ROOT, '.github', 'integration-tests', 'packaged-devenv');
const TEST_EXTENSION_ENTRY = path.join(TEST_EXTENSION_ROOT, 'out', 'extension.js');
const LANGUAGES = new Set(['cpp', 'go', 'rust', 'csharp', 'javascript', 'typescript', 'python', 'lua']);
const MODES = new Set(['verify', 'move', 'replacement', 'concurrency']);
const PAIRS = new Set(['cpp:python', 'rust:javascript', 'typescript:go', 'csharp:lua']);
const BOOLEAN_VALUES = new Set(['true', 'false']);
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const PHASE_TIMEOUT_MINIMUM_MS = 30_000;
const HOST_HEARTBEAT_MS = 15_000;
const REMOTEPRO_ID = 'remotepro-cn.remotepro';
const REMOTEPRO_VERSION = '1.4.4';
const FIREWALL_PREFIX = 'VSCode-Packaged-DevEnv-Integration';
const LANGUAGE_COMMANDS = {
	cpp: ['cmake', 'ninja', 'gcc', 'g++', 'gdb'],
	go: ['go', 'dlv', 'gopls'],
	rust: ['cargo', 'rustup', 'rustc', 'gcc'],
	csharp: ['dotnet'],
	javascript: ['node'],
	typescript: ['node', 'npm'],
	python: ['python'],
	lua: ['lua']
};
const UNIQUE_COMMANDS = {
	cpp: ['cmake', 'ninja', 'g++', 'gdb'],
	go: ['go', 'dlv', 'gopls'],
	rust: ['cargo', 'rustup', 'rustc'],
	csharp: ['dotnet'],
	javascript: [],
	typescript: ['npm'],
	python: ['python'],
	lua: ['lua']
};
const LANGUAGE_VARIABLE_PATTERNS = [
	/^(CARGO|RUSTUP|RUST|RUSTC|RUSTFLAGS|CC_|CXX_)/i,
	/^(GOROOT|GOPATH|GOBIN|GOENV|GOTOOLCHAIN|GOFLAGS)$/i,
	/^(PYTHON|PYTHONHOME|PYTHONPATH|PIP_|VIRTUAL_ENV)/i,
	/^(DOTNET|NUGET|MSBUILD)/i,
	/^(NODE|NPM|npm_config_|COREPACK|BUN|DENO)/i,
	/^(LUA|LUA_PATH|LUA_CPATH|YK_LIBS_DIR)/i,
	/^(CMAKE|NINJA|MINGW|MSYSTEM|LLVM|CLANG)/i,
	/^VSCODE_/i,
	/^ELECTRON_/i
];
const CONTROLLER_PASSTHROUGH = new Set([
	'ALLUSERSPROFILE',
	'APPDATA',
	'COMMONPROGRAMFILES',
	'COMMONPROGRAMFILES(X86)',
	'COMMONPROGRAMW6432',
	'COMPUTERNAME',
	'COMSPEC',
	'DRIVERDATA',
	'HOMEDRIVE',
	'HOMEPATH',
	'LOCALAPPDATA',
	'LOGONSERVER',
	'NUMBER_OF_PROCESSORS',
	'OS',
	'PATHEXT',
	'PROCESSOR_ARCHITECTURE',
	'PROCESSOR_IDENTIFIER',
	'PROCESSOR_LEVEL',
	'PROCESSOR_REVISION',
	'PROGRAMDATA',
	'PROGRAMFILES',
	'PROGRAMFILES(X86)',
	'PROGRAMW6432',
	'PSMODULEPATH',
	'PUBLIC',
	'SESSIONNAME',
	'SYSTEMDRIVE',
	'SYSTEMROOT',
	'TEMP',
	'TMP',
	'USERDOMAIN',
	'USERDOMAIN_ROAMINGPROFILE',
	'USERNAME',
	'USERPROFILE',
	'WINDIR'
]);

function printHelp() {
	console.log(`Packaged Windows development-environment integration test

Usage:
  node .github/scripts/run-packaged-devenv-integration.mjs --mode verify --language <language> --zip <file> --evidence-dir <dir>
  node .github/scripts/run-packaged-devenv-integration.mjs --mode move --language <language> --zip <file> --evidence-dir <dir>
  node .github/scripts/run-packaged-devenv-integration.mjs --mode replacement --pair <pair> --preserve-data <true|false> --zip-a <file> --zip-b <file> --evidence-dir <dir>
  node .github/scripts/run-packaged-devenv-integration.mjs --mode concurrency --pair <pair> --zip-a <file> --zip-b <file> --evidence-dir <dir>

Languages:
  cpp, go, rust, csharp, javascript, typescript, python, lua

Pairs:
  cpp:python, rust:javascript, typescript:go, csharp:lua

Options:
  --offline <true|false>          Require Windows Firewall isolation (default: true)
  --timeout <milliseconds>        Per editor phase timeout (default: ${DEFAULT_TIMEOUT_MS})
  --keep-temp <true|false>        Preserve extracted products and workspaces (default: false)
  --help                          Show this help

The ZIP must contain one top-level application directory with Code.exe and data/.
The controller never passes --user-data-dir, --extensions-dir, or --shared-data-dir.`);
}

function parseArgs(argv) {
	const output = {};
	for (let index = 0; index < argv.length; index++) {
		const name = argv[index];
		if (name === '--help' || name === '-h') {
			output.help = true;
			continue;
		}
		if (!/^--[a-z][a-z0-9-]*$/.test(name)) {
			throw new Error(`Invalid argument name: ${name}`);
		}
		const value = argv[index + 1];
		if (value === undefined || value.startsWith('--')) {
			throw new Error(`Missing value for ${name}`);
		}
		const key = name.slice(2);
		if (Object.hasOwn(output, key)) {
			throw new Error(`Duplicate argument: ${name}`);
		}
		output[key] = value;
		index++;
	}
	return output;
}

function validateArgs(raw) {
	if (raw.help) {
		return { help: true };
	}
	const allowed = new Set([
		'mode', 'language', 'zip', 'zip-a', 'zip-b', 'pair', 'preserve-data', 'evidence-dir', 'offline', 'timeout', 'keep-temp',
		'internal-peer', 'app-root', 'workspace', 'run-id', 'barrier-dir'
	]);
	for (const key of Object.keys(raw)) {
		if (!allowed.has(key)) {
			throw new Error(`Unknown argument: --${key}`);
		}
	}
	const mode = required(raw, 'mode');
	if (!MODES.has(mode)) {
		throw new Error(`Invalid --mode=${mode}`);
	}
	const offline = parseBoolean(
		raw.offline ?? (process.env.PACKAGED_DEVENV_NETWORK_FIREWALL === 'false' ? 'false' : 'true'),
		'--offline'
	);
	const keepTemp = parseBoolean(raw['keep-temp'] ?? 'false', '--keep-temp');
	const internalPeer = parseBoolean(raw['internal-peer'] ?? 'false', '--internal-peer');
	const timeoutMs = Number(raw.timeout ?? process.env.PACKAGED_DEVENV_TEST_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < PHASE_TIMEOUT_MINIMUM_MS) {
		throw new Error(`--timeout must be an integer >= ${PHASE_TIMEOUT_MINIMUM_MS}`);
	}
	if (process.platform !== 'win32') {
		throw new Error(`Packaged devenv integration requires Windows; current platform is ${process.platform}`);
	}
	const evidenceDir = absolute(required(raw, 'evidence-dir'));

	if (internalPeer) {
		const language = validateLanguage(required(raw, 'language'));
		if (mode !== 'concurrency') {
			throw new Error('--internal-peer requires --mode concurrency');
		}
		return {
			appRoot: absolute(required(raw, 'app-root')),
			barrierDir: absolute(required(raw, 'barrier-dir')),
			evidenceDir,
			help: false,
			internalPeer,
			keepTemp,
			language,
			mode,
			offline,
			runId: required(raw, 'run-id'),
			timeoutMs,
			workspace: absolute(required(raw, 'workspace'))
		};
	}

	if (mode === 'verify' || mode === 'move') {
		return {
			evidenceDir,
			help: false,
			internalPeer: false,
			keepTemp,
			language: validateLanguage(required(raw, 'language')),
			mode,
			offline,
			timeoutMs,
			zip: absolute(required(raw, 'zip'))
		};
	}

	const pair = required(raw, 'pair');
	if (!PAIRS.has(pair)) {
		throw new Error(`Invalid --pair=${pair}`);
	}
	const [languageA, languageB] = pair.split(':');
	const common = {
		evidenceDir,
		help: false,
		internalPeer: false,
		keepTemp,
		languageA,
		languageB,
		mode,
		offline,
		pair,
		timeoutMs,
		zipA: absolute(required(raw, 'zip-a')),
		zipB: absolute(required(raw, 'zip-b'))
	};
	if (mode === 'replacement') {
		return { ...common, preserveData: parseBoolean(required(raw, 'preserve-data'), '--preserve-data') };
	}
	return common;
}

function required(raw, key) {
	const value = raw[key];
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`--${key} is required`);
	}
	return value;
}

function parseBoolean(value, name) {
	if (!BOOLEAN_VALUES.has(value)) {
		throw new Error(`${name} must be true or false`);
	}
	return value === 'true';
}

function validateLanguage(value) {
	if (!LANGUAGES.has(value)) {
		throw new Error(`Invalid --language=${value}`);
	}
	return value;
}

function absolute(value) {
	return path.resolve(value);
}

function stripExtendedPath(value) {
	if (value.startsWith('\\\\?\\UNC\\')) {
		return `\\\\${value.slice(8)}`;
	}
	if (value.startsWith('\\\\?\\')) {
		return value.slice(4);
	}
	return value;
}

function nativeLongPath(value) {
	const resolved = path.resolve(value);
	try {
		return stripExtendedPath(realpathSync.native(resolved));
	} catch {
		return resolved;
	}
}

function tempRoot() {
	return nativeLongPath(process.env.RUNNER_TEMP || process.env.TEMP || os.tmpdir());
}

function normalized(value) {
	return path.normalize(path.resolve(value)).toLowerCase();
}

function samePath(left, right) {
	return normalized(left) === normalized(right);
}

function isUnder(root, candidate) {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function pathExists(value) {
	try {
		await fs.access(value);
		return true;
	} catch {
		return false;
	}
}

async function ensureFile(file, description = file) {
	const stat = await fs.stat(file).catch(() => undefined);
	if (!stat?.isFile()) {
		throw new Error(`Missing ${description}: ${file}`);
	}
}

async function ensureDirectory(directory, description = directory) {
	const stat = await fs.stat(directory).catch(() => undefined);
	if (!stat?.isDirectory()) {
		throw new Error(`Missing ${description}: ${directory}`);
	}
}

async function writeJson(file, value) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(file) {
	return JSON.parse(await fs.readFile(file, 'utf8'));
}

function timestamp() {
	return new Date().toISOString();
}

async function sha256(file) {
	const hash = createHash('sha256');
	await pipeline(createReadStream(file), hash);
	return hash.digest('hex');
}

function xmlEscape(value) {
	return String(value).replace(/[&<>"']/g, character => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&apos;'
	})[character]);
}

async function writeJUnit(file, name, started, error) {
	const elapsed = (Date.now() - started) / 1000;
	const detail = error ? error instanceof Error ? error.stack ?? error.message : String(error) : '';
	const failure = error ? `<failure message="${xmlEscape(String(error))}">${xmlEscape(detail)}</failure>` : '';
	const xml = `<?xml version="1.0" encoding="UTF-8"?><testsuite name="packaged-devenv" tests="1" failures="${error ? 1 : 0}" time="${elapsed.toFixed(3)}"><testcase name="${xmlEscape(name)}" time="${elapsed.toFixed(3)}">${failure}</testcase></testsuite>`;
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, xml, 'utf8');
}

function runProcess(executable, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		const timeout = options.timeoutMs ? setTimeout(() => {
			if (!settled) {
				settled = true;
				reject(new Error(`${path.basename(executable)} exceeded ${options.timeoutMs}ms`));
			}
			void killPidTree(child.pid);
		}, options.timeoutMs) : undefined;
		child.stdout?.on('data', chunk => stdout += chunk.toString());
		child.stderr?.on('data', chunk => stderr += chunk.toString());
		child.once('error', error => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});
		child.once('close', (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			const result = { code: code ?? 1, pid: child.pid, signal, stderr, stdout };
			if (options.allowFailure || code === 0) {
				resolve(result);
			} else {
				const error = new Error(`${executable} ${args.join(' ')} exited ${code ?? signal}: ${(stderr || stdout).trim()}`);
				error.result = result;
				reject(error);
			}
		});
	});
}

async function powershell(script, options = {}) {
	const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
	const file = path.join(tempRoot(), `packaged-devenv-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`);
	await fs.writeFile(file, `${script}\n`, 'utf8');
	try {
		return await runProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
			...options,
			timeoutMs: options.timeoutMs ?? 60_000
		});
	} finally {
		await fs.rm(file, { force: true });
	}
}

async function getSevenZip() {
	for (const candidate of ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe']) {
		if (await pathExists(candidate)) {
			return candidate;
		}
	}
	const resolved = await whereCommand('7z.exe', process.env.PATH ?? process.env.Path ?? '');
	if (!resolved) {
		throw new Error('7z.exe is required for ZIP inspection and safe extraction');
	}
	return resolved;
}

async function listZipEntries(zipFile) {
	const sevenZip = await getSevenZip();
	const { stdout } = await runProcess(sevenZip, ['l', '-slt', '-ba', '-sccUTF-8', zipFile], { timeoutMs: 120_000 });
	const entries = [];
	let current;
	for (const line of stdout.split(/\r?\n/)) {
		const separator = line.indexOf(' = ');
		if (separator < 0) {
			continue;
		}
		const key = line.slice(0, separator);
		const value = line.slice(separator + 3);
		if (key === 'Path') {
			if (current?.path) {
				entries.push(current);
			}
			current = { path: value };
		} else if (current && key === 'Attributes') {
			current.attributes = value;
		} else if (current && key === 'Folder') {
			current.folder = value === '+';
		} else if (current && key === 'Symbolic Link') {
			current.symbolicLink = value;
		} else if (current && key === 'Hard Link') {
			current.hardLink = value;
		}
	}
	if (current?.path) {
		entries.push(current);
	}
	if (entries.length === 0) {
		throw new Error(`ZIP contains no entries: ${zipFile}`);
	}
	return entries;
}

function validateZipEntries(zipFile, entries) {
	const topLevels = new Set();
	const caseFolded = new Map();
	for (const entry of entries) {
		const raw = entry.path.replace(/\\/g, '/');
		if (!raw || raw.includes('\0') || raw.startsWith('/') || raw.startsWith('//') || /^[a-z]:/i.test(raw)) {
			throw new Error(`Unsafe absolute ZIP entry in ${zipFile}: ${entry.path}`);
		}
		const parts = raw.split('/').filter(Boolean);
		if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) {
			throw new Error(`Unsafe traversal ZIP entry in ${zipFile}: ${entry.path}`);
		}
		if (entry.symbolicLink || entry.hardLink || /L/.test(entry.attributes ?? '')) {
			throw new Error(`Links are not allowed in packaged ZIP: ${entry.path}`);
		}
		for (const part of parts) {
			if (/[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)) {
				throw new Error(`Windows-unsafe ZIP entry: ${entry.path}`);
			}
		}
		topLevels.add(parts[0].toLowerCase());
		const folded = parts.join('/').toLowerCase();
		const previous = caseFolded.get(folded);
		if (previous && previous !== raw) {
			throw new Error(`Case-colliding ZIP entries: ${previous} and ${raw}`);
		}
		caseFolded.set(folded, raw);
	}
	if (topLevels.size !== 1) {
		throw new Error(`ZIP must contain exactly one top-level directory; found ${[...topLevels].join(', ')}`);
	}
}

async function extractZipSafe(zipFile, extractionRoot) {
	await ensureFile(zipFile, 'ZIP');
	const entries = await listZipEntries(zipFile);
	validateZipEntries(zipFile, entries);
	await fs.rm(extractionRoot, { recursive: true, force: true });
	await fs.mkdir(extractionRoot, { recursive: true });
	const sevenZip = await getSevenZip();
	await runProcess(sevenZip, ['x', '-y', '-aoa', `-o${extractionRoot}`, zipFile], { timeoutMs: 15 * 60_000 });
	const children = await fs.readdir(extractionRoot, { withFileTypes: true });
	if (children.length !== 1 || !children[0].isDirectory()) {
		throw new Error(`Extraction must produce one top-level application directory: ${extractionRoot}`);
	}
	const appRoot = path.join(extractionRoot, children[0].name);
	await validateAppRoot(appRoot);
	return appRoot;
}

async function validateAppRoot(appRoot) {
	await ensureFile(path.join(appRoot, 'Code.exe'), 'Code.exe');
	await ensureDirectory(path.join(appRoot, 'resources', 'app'), 'resources/app');
	await ensureDirectory(path.join(appRoot, 'data'), 'portable data directory');
	await ensureDirectory(path.join(appRoot, 'dev-env'), 'bundled development environment');
	if (await pathExists(path.join(appRoot, 'bootstrap'))) {
		throw new Error(`Packaged application must not contain bootstrap/: ${appRoot}`);
	}
}

async function moveDirectory(source, destination) {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await fs.rm(destination, { recursive: true, force: true });
	try {
		await fs.rename(source, destination);
	} catch (error) {
		if (error?.code !== 'EXDEV') {
			throw error;
		}
		await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true });
		await fs.rm(source, { recursive: true, force: true });
	}
}

async function whereCommand(command, pathValue) {
	const whereExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe');
	const result = await runProcess(whereExe, [command], {
		allowFailure: true,
		env: { COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD', PATH: pathValue, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
		timeoutMs: 15_000
	});
	return result.code === 0 ? result.stdout.split(/\r?\n/).find(Boolean)?.trim() : undefined;
}

function systemPaths() {
	const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
	return [
		path.join(systemRoot, 'System32'),
		systemRoot,
		path.join(systemRoot, 'System32', 'Wbem'),
		path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
	];
}

function commandNamesForLanguages(languages) {
	return [...new Set(languages.flatMap(language => LANGUAGE_COMMANDS[language]))];
}

async function assertPurifiedPath(languages, evidenceDir) {
	const pathValue = systemPaths().join(path.delimiter);
	const snapshots = [];
	for (const command of commandNamesForLanguages(languages)) {
		const where = await whereCommand(command, pathValue);
		snapshots.push({ command, where: where ?? null });
		if (where) {
			throw new Error(`Purified PATH unexpectedly resolves ${command}: ${where}`);
		}
	}
	await writeJson(path.join(evidenceDir, 'path', 'prelaunch-resolution.json'), { path: pathValue, snapshots, timestamp: timestamp() });
	return pathValue;
}

function strictBaseEnvironment(pathValue) {
	const output = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || !CONTROLLER_PASSTHROUGH.has(key.toUpperCase())) {
			continue;
		}
		output[key] = value;
	}
	output.Path = pathValue;
	output.PATH = pathValue;
	return output;
}

function removeContaminatingEnvironment(env) {
	for (const key of Object.keys(env)) {
		if (LANGUAGE_VARIABLE_PATTERNS.some(pattern => pattern.test(key))) {
			delete env[key];
		}
	}
	return env;
}

function hostEnvironment(pathValue, config) {
	const env = removeContaminatingEnvironment(strictBaseEnvironment(pathValue));
	env.ELECTRON_ENABLE_LOGGING = '1';
	env.NO_PROXY = '*';
	env.no_proxy = '*';
	env.PACKAGED_DEVENV_INTEGRATION_CONFIG = JSON.stringify(config);
	env.REMOTEPRO_INTEGRATION_TEST = '1';
	env.VSCODE_CLI = '0';
	return env;
}

function buildEditorLaunchArgs(options) {
	const { evidenceDir, phase, projectDir, testExtensionEntry, testExtensionRoot } = options;
	const logsPath = path.join(evidenceDir, 'logs', `vscode-${phase}`);
	const crashesPath = path.join(evidenceDir, 'crashes', phase);
	const args = [
		'--disable-gpu',
		'--disable-updates',
		'--disable-telemetry',
		'--disable-experiments',
		'--disable-workspace-trust',
		'--no-cached-data',
		'--no-proxy-server',
		'--use-inmemory-secretstorage',
		'--new-window',
		'--skip-release-notes',
		'--skip-welcome',
		`--crash-reporter-directory=${crashesPath}`,
		`--logsPath=${logsPath}`,
		`--extensionDevelopmentPath=${testExtensionRoot}`,
		`--extensionTestsPath=${testExtensionEntry}`,
		projectDir
	];
	if (args.some(argument => /--(?:user-data-dir|extensions-dir|shared-data-dir)(?:=|$)/.test(argument))) {
		throw new Error('Portable integration must not pass profile directory CLI overrides');
	}
	return { args, crashesPath, logsPath };
}

async function copyPortableLogs(appRoot, evidenceDir, phase) {
	const portableLogs = path.join(appRoot, 'data', 'user-data', 'logs');
	if (!await pathExists(portableLogs)) {
		return;
	}
	await fs.cp(portableLogs, path.join(evidenceDir, 'logs', `portable-${phase}`), { recursive: true }).catch(() => undefined);
}

async function registrySnapshot() {
	const script = [
		"$ErrorActionPreference='Stop'",
		"$payload = [ordered]@{",
		"  machinePath = [Environment]::GetEnvironmentVariable('Path','Machine')",
		"  userPath = [Environment]::GetEnvironmentVariable('Path','User')",
		"  machine = [ordered]@{}",
		"  user = [ordered]@{}",
		"}",
		"foreach ($scope in @('Machine','User')) {",
		"  $target = if ($scope -eq 'Machine') { $payload.machine } else { $payload.user }",
		"  foreach ($name in @('CARGO_HOME','RUSTUP_HOME','GOROOT','GOPATH','GOBIN','DOTNET_ROOT','PYTHONHOME','PYTHONPATH','LUA_PATH','LUA_CPATH','YK_LIBS_DIR')) {",
		"    $target[$name] = [Environment]::GetEnvironmentVariable($name,$scope)",
		"  }",
		"}",
		"$payload | ConvertTo-Json -Depth 5 -Compress"
	].join('\n');
	const { stdout } = await powershell(script, { timeoutMs: 30_000 });
	return JSON.parse(stdout.trim());
}

async function waitForFile(file, timeoutMs, description) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await pathExists(file)) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	throw new Error(`Timed out waiting for ${description}: ${file}`);
}

async function readState(file) {
	try {
		return await readJson(file);
	} catch {
		return {};
	}
}

async function collectCimProcesses() {
	const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Depth 4 -Compress";
	const { stdout } = await powershell(script, { timeoutMs: 60_000 });
	const parsed = JSON.parse(stdout.trim() || '[]');
	return Array.isArray(parsed) ? parsed : [parsed];
}

function descendants(processes, rootPid) {
	const byParent = new Map();
	for (const processInfo of processes) {
		const parent = Number(processInfo.ParentProcessId);
		const list = byParent.get(parent) ?? [];
		list.push(processInfo);
		byParent.set(parent, list);
	}
	const output = [];
	const queue = [Number(rootPid)];
	const visited = new Set(queue);
	while (queue.length > 0) {
		const parent = queue.shift();
		for (const child of byParent.get(parent) ?? []) {
			const pid = Number(child.ProcessId);
			if (visited.has(pid)) {
				continue;
			}
			visited.add(pid);
			output.push(child);
			queue.push(pid);
		}
	}
	return output;
}

async function writeProcessSnapshot(file, rootPid, extra = {}) {
	const all = await collectCimProcesses();
	const root = all.find(processInfo => Number(processInfo.ProcessId) === Number(rootPid));
	const tree = [root, ...descendants(all, rootPid)].filter(Boolean);
	await writeJson(file, { ...extra, capturedAt: timestamp(), rootPid, tree });
	return tree;
}

async function killPidTree(pid) {
	if (!pid || !Number.isInteger(Number(pid))) {
		return;
	}
	const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
	await runProcess(taskkill, ['/PID', String(pid), '/T', '/F'], { allowFailure: true, timeoutMs: 60_000 });
}

async function waitForTreeExit(pid, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const processes = await collectCimProcesses();
		if (!processes.some(processInfo => Number(processInfo.ProcessId) === Number(pid))) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 300));
	}
	throw new Error(`Process tree root ${pid} did not exit within ${timeoutMs}ms`);
}

async function collectExecutables(appRoot) {
	const roots = [path.join(appRoot, 'dev-env'), path.join(appRoot, 'resources', 'app', 'extensions')];
	const output = [path.join(appRoot, 'Code.exe')];
	const queue = [];
	for (const root of roots) {
		if (await pathExists(root)) {
			queue.push({ depth: 0, directory: root });
		}
	}
	while (queue.length > 0) {
		const current = queue.shift();
		const entries = await fs.readdir(current.directory, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const full = path.join(current.directory, entry.name);
			if (entry.isDirectory() && current.depth < 8) {
				queue.push({ depth: current.depth + 1, directory: full });
			} else if (entry.isFile() && /\.exe$/i.test(entry.name)) {
				output.push(full);
			}
		}
	}
	return [...new Set(output.map(nativeLongPath))];
}

class FirewallIsolation {
	constructor(evidenceDir) {
		this.evidenceDir = evidenceDir;
		this.rules = [];
	}

	async assertAvailable() {
		const probeName = `${FIREWALL_PREFIX}-Probe-${randomUUID()}`;
		const whereExe = nativeLongPath(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe')).replace(/'/g, "''");
		const add = await powershell(`$ErrorActionPreference = 'Stop'
try {
  New-NetFirewallRule -DisplayName '${probeName}' -Direction Outbound -Action Block -Program '${whereExe}' -RemoteAddress Internet -Profile Domain,Private,Public -Enabled True -ErrorAction Stop | Out-Null
} catch {
  New-NetFirewallRule -DisplayName '${probeName}' -Direction Outbound -Action Block -Program '${whereExe}' -RemoteAddress @('0.0.0.0-126.255.255.255','128.0.0.0-255.255.255.255') -Profile Domain,Private,Public -Enabled True -ErrorAction Stop | Out-Null
}`, {
			allowFailure: true,
			timeoutMs: 30_000
		});
		if (add.code !== 0) {
			throw new Error(`Windows Firewall isolation requires elevation and a running firewall service: ${(add.stderr || add.stdout).trim()}`);
		}
		await powershell(`Remove-NetFirewallRule -DisplayName '${probeName}' -ErrorAction SilentlyContinue`, { allowFailure: true, timeoutMs: 30_000 });
	}

	async block(appRoots) {
		await this.assertAvailable();
		const executables = [...new Set((await Promise.all(appRoots.map(root => collectExecutables(root)))).flat().map(nativeLongPath))];
		const listFile = path.join(this.evidenceDir, 'network', 'block-targets.json');
		await writeJson(listFile, executables);
		const escapedList = listFile.replace(/'/g, "''");
		const prefix = FIREWALL_PREFIX.replace(/'/g, "''");
		const result = await powershell(`$ErrorActionPreference = 'Stop'
$exes = Get-Content -LiteralPath '${escapedList}' -Encoding UTF8 -Raw | ConvertFrom-Json
$results = New-Object System.Collections.Generic.List[object]
foreach ($exe in @($exes)) {
  $path = [string]$exe
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Firewall target missing: $path"
  }
  $full = (Get-Item -LiteralPath $path).FullName
  $name = '${prefix}-' + [guid]::NewGuid().ToString('N')
  try {
    New-NetFirewallRule -Name $name -DisplayName $name -Direction Outbound -Action Block -Program $full -RemoteAddress Internet -Profile Domain,Private,Public -Enabled True -ErrorAction Stop | Out-Null
  } catch {
    $cimError = $_.Exception.Message
    $add = & netsh @('advfirewall', 'firewall', 'add', 'rule', ('name=' + $name), 'dir=out', 'action=block', ('program=' + $full), 'remoteip=Internet', 'enable=yes', 'profile=domain,private,public')
    if ($LASTEXITCODE -ne 0) {
      $ranges = @('0.0.0.0-126.255.255.255', '128.0.0.0-255.255.255.255')
      try {
        New-NetFirewallRule -Name $name -DisplayName $name -Direction Outbound -Action Block -Program $full -RemoteAddress $ranges -Profile Domain,Private,Public -Enabled True -ErrorAction Stop | Out-Null
      } catch {
        throw ('Firewall rule failed for ' + $full + ': ' + $cimError + '; netsh: ' + $add + '; ranges: ' + $_.Exception.Message)
      }
    }
  }
  $results.Add([ordered]@{ executable = $full; name = $name; remote = 'Internet' })
}
$results | ConvertTo-Json -Depth 6 -Compress`, { timeoutMs: 180_000 });
		const parsed = JSON.parse(result.stdout.trim() || '[]');
		this.rules = Array.isArray(parsed) ? parsed : [parsed];
		await writeJson(path.join(this.evidenceDir, 'network', 'firewall-active.json'), { activeAt: timestamp(), rules: this.rules });
	}

	async remove() {
		if (this.rules.length === 0) {
			await writeJson(path.join(this.evidenceDir, 'network', 'firewall-removed.json'), { failures: [], removedAt: timestamp(), rules: [] });
			return;
		}
		const names = this.rules.map(rule => rule.name);
		const listFile = path.join(this.evidenceDir, 'network', 'unblock-names.json');
		await writeJson(listFile, names);
		const escapedList = listFile.replace(/'/g, "''");
		const result = await powershell(`$ErrorActionPreference = 'Continue'
$names = Get-Content -LiteralPath '${escapedList}' -Raw | ConvertFrom-Json
$failures = New-Object System.Collections.Generic.List[object]
foreach ($name in @($names)) {
  try {
    Remove-NetFirewallRule -DisplayName $name -ErrorAction Stop
  } catch {
    $failures.Add([ordered]@{ name = [string]$name; error = $_.Exception.Message })
  }
}
[ordered]@{ failures = $failures } | ConvertTo-Json -Depth 6 -Compress`, { allowFailure: true, timeoutMs: 180_000 });
		let failures = [];
		try {
			const parsed = JSON.parse(result.stdout.trim() || '{"failures":[]}');
			failures = Array.isArray(parsed.failures) ? parsed.failures : [];
		} catch {
			failures = [{ name: '*', error: (result.stderr || result.stdout).trim() || `exit ${result.code}` }];
		}
		await writeJson(path.join(this.evidenceDir, 'network', 'firewall-removed.json'), { failures, removedAt: timestamp(), rules: this.rules });
		this.rules = [];
		if (failures.length > 0) {
			throw new Error(`Failed to remove ${failures.length} Windows Firewall rule(s)`);
		}
	}
}

async function compileTestExtension() {
	await ensureFile(path.join(TEST_EXTENSION_ROOT, 'package.json'), 'test extension package.json');
	const tsc = path.join(TEST_EXTENSION_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
	await ensureFile(tsc, 'test extension TypeScript compiler; run npm ci in the test extension directory');
	await runProcess(process.execPath, [tsc, '-p', TEST_EXTENSION_ROOT], { cwd: TEST_EXTENSION_ROOT, timeoutMs: 120_000 });
	await ensureFile(TEST_EXTENSION_ENTRY, 'compiled test extension entry');
}

async function ensureTestExtensionOutsidePackage(appRoot) {
	if (isUnder(appRoot, TEST_EXTENSION_ROOT)) {
		throw new Error('Test extension must remain outside the packaged application root');
	}
	const relative = path.relative(appRoot, TEST_EXTENSION_ROOT);
	if (!relative.startsWith('..')) {
		throw new Error('Test extension unexpectedly resides under product root');
	}
}

async function findExtensionPath(appRoot, id) {
	const roots = [
		path.join(appRoot, 'resources', 'app', 'extensions'),
		path.join(appRoot, 'data', 'extensions')
	];
	for (const extensionsRoot of roots) {
		const queue = [extensionsRoot];
		while (queue.length > 0) {
			const directory = queue.shift();
			for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
				const full = path.join(directory, entry.name);
				if (!entry.isDirectory()) {
					continue;
				}
				const manifestPath = path.join(full, 'package.json');
				if (await pathExists(manifestPath)) {
					try {
						const manifest = await readJson(manifestPath);
						if (`${manifest.publisher}.${manifest.name}`.toLowerCase() === id.toLowerCase()) {
							return { manifest, path: full };
						}
					} catch {
						// Continue searching other installed extensions.
					}
				}
				queue.push(full);
			}
		}
	}
	return undefined;
}

async function assertRemoteProVersion(appRoot) {
	const extension = await findExtensionPath(appRoot, REMOTEPRO_ID);
	if (!extension) {
		throw new Error(`${REMOTEPRO_ID} is not installed as a system extension: ${path.join(appRoot, 'resources', 'app', 'extensions')}`);
	}
	if (extension.manifest.version !== REMOTEPRO_VERSION) {
		throw new Error(`Expected ${REMOTEPRO_ID}@${REMOTEPRO_VERSION}, found ${extension.manifest.version}`);
	}
	return extension;
}

async function runTypeScriptInstall(appRoot, projectDir, evidenceDir, timeoutMs) {
	const node = await resolvePackagedCommand(appRoot, 'node');
	const npm = await resolvePackagedCommand(appRoot, 'npm');
	if (!node || !npm) {
		throw new Error('TypeScript dependency preparation requires packaged node and npm');
	}
	const npmCli = npm.toLowerCase().endsWith('.cmd') ? path.join(path.dirname(npm), 'node_modules', 'npm', 'bin', 'npm-cli.js') : npm;
	await ensureFile(npmCli, 'packaged npm CLI');
	const packageLock = path.join(projectDir, 'package-lock.json');
	const installArgs = npmCli === npm ? ['install', '--ignore-scripts'] : [npmCli, 'install', '--ignore-scripts'];
	await runProcess(npmCli === npm ? npm : node, installArgs, {
		cwd: projectDir,
		env: { ...strictBaseEnvironment(systemPaths().join(path.delimiter)), PATH: `${path.dirname(node)}${path.delimiter}${systemPaths().join(path.delimiter)}`, Path: `${path.dirname(node)}${path.delimiter}${systemPaths().join(path.delimiter)}` },
		timeoutMs
	});
	await ensureFile(packageLock, 'TypeScript project package-lock.json');
	const payload = { lockSha256: await sha256(packageLock), npmPath: npm, timestamp: timestamp() };
	await writeJson(path.join(evidenceDir, 'typescript-install.json'), payload);
	return payload;
}

async function resolvePackagedCommand(appRoot, command) {
	const entriesFile = path.join(appRoot, 'dev-env', 'path-entries.json');
	const entries = await readJson(entriesFile);
	const roots = Array.isArray(entries.path) ? entries.path.map(relative => path.resolve(path.join(appRoot, 'dev-env'), relative)) : [];
	const extensions = ['', '.exe', '.cmd', '.bat'];
	for (const root of roots) {
		if (!isUnder(path.join(appRoot, 'dev-env'), root)) {
			throw new Error(`path-entries.json escapes packaged dev-env: ${root}`);
		}
		for (const extension of extensions) {
			const candidate = path.join(root, `${command}${extension}`);
			if (await pathExists(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

async function seedPortableSettings(appRoot) {
	const userDir = path.join(appRoot, 'data', 'user-data', 'User');
	await fs.mkdir(userDir, { recursive: true });
	const settingsPath = path.join(userDir, 'settings.json');
	const settings = {
		'extensions.autoCheckUpdates': false,
		'extensions.autoUpdate': false,
		'extensions.ignoreRecommendations': true,
		'http.proxySupport': 'off',
		'python.terminal.activateEnvironment': false,
		'rust-analyzer.initializeStopped': true,
		'telemetry.telemetryLevel': 'off',
		'update.mode': 'none'
	};
	await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

async function removeRebuildableCaches(appRoot) {
	const data = path.join(appRoot, 'data');
	for (const relative of [
		'user-data/Cache',
		'user-data/Code Cache',
		'user-data/GPUCache',
		'user-data/CachedData',
		'user-data/ShaderCache',
		'user-data/logs',
		'user-data/Crashpad',
		'user-data/Service Worker/CacheStorage',
		'user-data/User/workspaceStorage'
	]) {
		await fs.rm(path.join(data, relative), { recursive: true, force: true });
	}
}

async function runEditorPhase(options) {
	const {
		actor = 'single', appRoot, barrierDir, concurrencyHoldMs, evidenceDir, language, mode, phase, projectDir, runId, timeoutMs
	} = options;
	let { peer } = options;
	await validateAppRoot(appRoot);
	await ensureTestExtensionOutsidePackage(appRoot);
	await seedPortableSettings(appRoot);
	const code = path.join(appRoot, 'Code.exe');
	const stateFile = path.join(evidenceDir, `state-${phase}.json`);
	const logFile = path.join(evidenceDir, 'logs', `host-${phase}.log`);
	const launch = buildEditorLaunchArgs({
		evidenceDir,
		phase,
		projectDir,
		testExtensionEntry: TEST_EXTENSION_ENTRY,
		testExtensionRoot: TEST_EXTENSION_ROOT
	});
	await fs.mkdir(launch.logsPath, { recursive: true });
	await fs.mkdir(launch.crashesPath, { recursive: true });
	await fs.mkdir(path.dirname(logFile), { recursive: true });
	await fs.rm(stateFile, { force: true });
	if (peer) {
		const peerLaunch = buildEditorLaunchArgs({
			evidenceDir: peer.evidenceDir,
			phase: 'concurrency',
			projectDir: peer.projectDir,
			testExtensionEntry: TEST_EXTENSION_ENTRY,
			testExtensionRoot: TEST_EXTENSION_ROOT
		});
		await fs.mkdir(peerLaunch.logsPath, { recursive: true });
		await fs.mkdir(peerLaunch.crashesPath, { recursive: true });
		peer = { ...peer, launchArgs: peerLaunch.args };
	}
	const config = {
		actor,
		appRoot,
		barrierDir,
		concurrencyHoldMs,
		controllerScript: SCRIPT_PATH,
		evidenceDir,
		language,
		mode,
		peer,
		phase,
		projectDir,
		runId,
		stateFile,
		testExtensionEntry: TEST_EXTENSION_ENTRY,
		testExtensionRoot: TEST_EXTENSION_ROOT,
		timeoutMs
	};
	const pathValue = systemPaths().join(path.delimiter);
	const env = hostEnvironment(pathValue, config);
	const child = spawn(code, launch.args, { cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
	if (!child.pid) {
		throw new Error(`Failed to launch ${code}`);
	}
	let output = '';
	const append = chunk => {
		const text = chunk.toString();
		output += text;
		process.stdout.write(text);
	};
	child.stdout.on('data', append);
	child.stderr.on('data', append);
	const started = Date.now();
	let lastHeartbeat = started;
	let launchError;
	child.once('error', error => launchError = error);
	console.log(`[packaged-devenv] launched Code.exe pid=${child.pid} phase=${phase} timeoutMs=${timeoutMs}`);
	const persistHostLog = async () => {
		await fs.writeFile(logFile, output, 'utf8');
		await copyPortableLogs(appRoot, evidenceDir, phase);
	};
	try {
		const expectedStage = phase === 'prepare' ? 'prepared' : 'complete';
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (launchError) {
				throw launchError;
			}
			const state = await readState(stateFile);
			if (state.stage === expectedStage) {
				await writeProcessSnapshot(path.join(evidenceDir, 'processes', `${phase}-before-kill.json`), child.pid, { actor, appRoot, phase });
				await killPidTree(child.pid);
				await waitForTreeExit(child.pid);
				await persistHostLog();
				return { elapsedMs: Date.now() - started, pid: child.pid, state };
			}
			if (state.stage === 'failed') {
				throw new Error(`Extension test reported failure: ${JSON.stringify(state)}`);
			}
			if (child.exitCode !== null) {
				throw new Error(`Code.exe exited ${child.exitCode} before ${expectedStage}`);
			}
			if (Date.now() - lastHeartbeat >= HOST_HEARTBEAT_MS) {
				lastHeartbeat = Date.now();
				await fs.writeFile(logFile, output, 'utf8');
				console.log(`[packaged-devenv] waiting for ${expectedStage} (${Math.round((Date.now() - started) / 1000)}s / ${Math.round(timeoutMs / 1000)}s)`);
			}
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		throw new Error(`Code.exe phase ${phase} exceeded ${timeoutMs}ms`);
	} catch (error) {
		await writeProcessSnapshot(path.join(evidenceDir, 'processes', `${phase}-failure.json`), child.pid, { actor, appRoot, error: String(error), phase }).catch(() => undefined);
		await persistHostLog().catch(() => undefined);
		await killPidTree(child.pid);
		throw error;
	}
}

async function prepareAndVerify(context, options) {
	const { actor = 'single', appRoot, evidenceDir, language, mode, projectDir, runId, timeoutMs, peer, barrierDir } = options;
	await fs.mkdir(evidenceDir, { recursive: true });
	await assertRemoteProVersion(appRoot);
	await runEditorPhase({ actor, appRoot, evidenceDir, language, mode, phase: 'prepare', projectDir, runId, timeoutMs });
	if (language === 'typescript') {
		if (context.firewall.rules.length > 0) {
			await context.firewall.remove();
		}
		await runTypeScriptInstall(appRoot, projectDir, evidenceDir, timeoutMs);
		if (context.offline) {
			await context.firewall.block(context.firewallRoots);
		}
	}
	return runEditorPhase({ actor, appRoot, barrierDir, concurrencyHoldMs: 2_000, evidenceDir, language, mode, peer, phase: mode === 'concurrency' ? 'concurrency' : 'verify', projectDir, runId, timeoutMs });
}

async function verifyExistingProject(context, options) {
	const { actor = 'single', appRoot, evidenceDir, language, mode, projectDir, runId, timeoutMs } = options;
	await fs.mkdir(evidenceDir, { recursive: true });
	return runEditorPhase({ actor, appRoot, evidenceDir, language, mode, phase: 'verify', projectDir, runId, timeoutMs });
}

async function readExtensionResult(evidenceDir) {
	return readJson(path.join(evidenceDir, 'extension-result.json'));
}

function assertEvidenceRoot(result, appRoot, label) {
	if (!samePath(result.appRoot, appRoot)) {
		throw new Error(`${label} appRoot mismatch: ${result.appRoot} != ${appRoot}`);
	}
	for (const command of result.commands ?? []) {
		if (!isUnder(appRoot, command.path)) {
			throw new Error(`${label} command escaped app root: ${command.command} -> ${command.path}`);
		}
	}
	for (const extension of [...(result.extensions ?? []), result.remotePro].filter(Boolean)) {
		if (!isUnder(appRoot, extension.extensionPath)) {
			throw new Error(`${label} extension escaped app root: ${extension.id} -> ${extension.extensionPath}`);
		}
	}
	for (const portablePath of Object.values(result.portable ?? {})) {
		if (!isUnder(appRoot, portablePath)) {
			throw new Error(`${label} portable path escaped app root: ${portablePath}`);
		}
	}
}

async function assertNoRunningProcessesUnder(root) {
	const processes = await collectCimProcesses();
	const offending = processes.filter(processInfo => {
		const executable = processInfo.ExecutablePath;
		const commandLine = processInfo.CommandLine;
		return typeof executable === 'string' && isUnder(root, executable) || typeof commandLine === 'string' && normalizedTextContainsPath(commandLine, root);
	});
	if (offending.length > 0) {
		throw new Error(`Processes remain under ${root}: ${JSON.stringify(offending)}`);
	}
}

function normalizedTextContainsPath(text, root) {
	return text.toLowerCase().includes(path.normalize(path.resolve(root)).toLowerCase());
}

async function scanExecutableNames(root, names, excludedRoots = []) {
	const expected = new Set(names.flatMap(name => [name.toLowerCase(), `${name}.exe`.toLowerCase(), `${name}.cmd`.toLowerCase(), `${name}.bat`.toLowerCase()]));
	const queue = [root];
	const hits = [];
	while (queue.length > 0) {
		const directory = queue.shift();
		if (excludedRoots.some(excluded => isUnder(excluded, directory))) {
			continue;
		}
		for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				queue.push(full);
			} else if (entry.isFile() && expected.has(entry.name.toLowerCase())) {
				hits.push(full);
			}
		}
	}
	return hits;
}

async function setupRun(args) {
	await fs.rm(args.evidenceDir, { recursive: true, force: true });
	await fs.mkdir(args.evidenceDir, { recursive: true });
	await compileTestExtension();
	const runRoot = await fs.mkdtemp(path.join(tempRoot(), 'vscode-packaged-devenv-'));
	const workspaceRoot = path.join(runRoot, 'workspaces');
	await fs.mkdir(workspaceRoot, { recursive: true });
	const registryBefore = await registrySnapshot();
	await writeJson(path.join(args.evidenceDir, 'path', 'registry-before.json'), registryBefore);
	return { registryBefore, runRoot, workspaceRoot };
}

async function finishRun(args, setup, result, error) {
	const registryAfter = await registrySnapshot();
	await writeJson(path.join(args.evidenceDir, 'path', 'registry-after.json'), registryAfter);
	if (JSON.stringify(setup.registryBefore) !== JSON.stringify(registryAfter)) {
		const mismatch = new Error('Machine/User PATH or language environment registry state changed during integration');
		if (!error) {
			error = mismatch;
		}
	}
	const finalResult = {
		...result,
		completedAt: timestamp(),
		durationMs: Date.now() - Date.parse(result.startedAt ?? timestamp()),
		error: error ? error instanceof Error ? error.stack ?? error.message : String(error) : undefined,
		status: error ? 'failed' : 'passed'
	};
	await writeJson(path.join(args.evidenceDir, 'result.json'), finalResult);
	return error;
}

async function runVerifyMode(args, setup, context) {
	const appRoot = await extractZipSafe(args.zip, path.join(setup.runRoot, 'extract'));
	context.firewallRoots = [appRoot];
	await assertPurifiedPath([args.language], args.evidenceDir);
	if (args.offline) {
		await context.firewall.block(context.firewallRoots);
	}
	const projectDir = path.join(setup.workspaceRoot, `${args.language}-privacy-survey`);
	await prepareAndVerify(context, { appRoot, evidenceDir: args.evidenceDir, language: args.language, mode: args.mode, projectDir, runId: context.runId, timeoutMs: args.timeoutMs });
	const extension = await readExtensionResult(args.evidenceDir);
	assertEvidenceRoot(extension, appRoot, 'verify');
	return {
		appRoot,
		extension,
		language: args.language,
		mode: args.mode,
		projectDir,
		runId: context.runId,
		zipSha256: await sha256(args.zip)
	};
}

async function runMoveMode(args, setup, context) {
	const appRootX = await extractZipSafe(args.zip, path.join(setup.runRoot, 'extract-x'));
	context.firewallRoots = [appRootX];
	await assertPurifiedPath([args.language], args.evidenceDir);
	if (args.offline) {
		await context.firewall.block(context.firewallRoots);
	}
	const projectDir = path.join(setup.workspaceRoot, `${args.language}-privacy-survey`);
	const firstDir = path.join(args.evidenceDir, 'x');
	await prepareAndVerify(context, { appRoot: appRootX, evidenceDir: firstDir, language: args.language, mode: args.mode, projectDir, runId: `${context.runId}-x`, timeoutMs: args.timeoutMs });
	const first = await readExtensionResult(firstDir);
	assertEvidenceRoot(first, appRootX, 'move X');
	await assertNoRunningProcessesUnder(appRootX);
	if (context.firewall.rules.length > 0) {
		await context.firewall.remove();
	}
	const appRootY = path.join(setup.runRoot, 'moved', path.basename(appRootX));
	await moveDirectory(appRootX, appRootY);
	await removeRebuildableCaches(appRootY);
	context.firewallRoots = [appRootY];
	if (args.offline) {
		await context.firewall.block(context.firewallRoots);
	}
	const secondDir = path.join(args.evidenceDir, 'y');
	await verifyExistingProject(context, { appRoot: appRootY, evidenceDir: secondDir, language: args.language, mode: args.mode, projectDir, runId: `${context.runId}-y`, timeoutMs: args.timeoutMs });
	const second = await readExtensionResult(secondDir);
	assertEvidenceRoot(second, appRootY, 'move Y');
	for (const command of second.commands ?? []) {
		if (normalizedTextContainsPath(command.path, appRootX)) {
			throw new Error(`Move Y evidence retained X path: ${command.path}`);
		}
	}
	return {
		appRootX,
		appRootY,
		first,
		language: args.language,
		mode: args.mode,
		projectDir,
		runId: context.runId,
		second,
		zipSha256: await sha256(args.zip)
	};
}

async function runReplacementMode(args, setup, context) {
	const canonicalParent = path.join(setup.runRoot, 'canonical-parent');
	const extractedA = await extractZipSafe(args.zipA, path.join(setup.runRoot, 'extract-a'));
	const canonicalRoot = path.join(canonicalParent, 'app');
	await moveDirectory(extractedA, canonicalRoot);
	context.firewallRoots = [canonicalRoot];
	await assertPurifiedPath([args.languageA, args.languageB], args.evidenceDir);
	if (args.offline) {
		await context.firewall.block(context.firewallRoots);
	}
	const projectA = path.join(setup.workspaceRoot, `${args.languageA}-privacy-survey`);
	const evidenceA = path.join(args.evidenceDir, 'a');
	await prepareAndVerify(context, { appRoot: canonicalRoot, evidenceDir: evidenceA, language: args.languageA, mode: args.mode, projectDir: projectA, runId: `${context.runId}-a`, timeoutMs: args.timeoutMs });
	const resultA = await readExtensionResult(evidenceA);
	assertEvidenceRoot(resultA, canonicalRoot, 'replacement A');
	await assertNoRunningProcessesUnder(canonicalRoot);
	if (context.firewall.rules.length > 0) {
		await context.firewall.remove();
	}
	let savedData;
	if (args.preserveData) {
		savedData = path.join(setup.runRoot, 'preserved-data');
		await moveDirectory(path.join(canonicalRoot, 'data'), savedData);
	}
	await fs.rm(canonicalRoot, { recursive: true, force: true });
	const extractedB = await extractZipSafe(args.zipB, path.join(setup.runRoot, 'extract-b'));
	await moveDirectory(extractedB, canonicalRoot);
	if (args.preserveData) {
		await fs.rm(path.join(canonicalRoot, 'data'), { recursive: true, force: true });
		await moveDirectory(savedData, path.join(canonicalRoot, 'data'));
	}
	await validateAppRoot(canonicalRoot);
	context.firewallRoots = [canonicalRoot];
	if (args.offline) {
		await context.firewall.block(context.firewallRoots);
	}
	const projectB = path.join(setup.workspaceRoot, `${args.languageB}-privacy-survey`);
	const evidenceB = path.join(args.evidenceDir, 'b');
	await prepareAndVerify(context, { appRoot: canonicalRoot, evidenceDir: evidenceB, language: args.languageB, mode: args.mode, projectDir: projectB, runId: `${context.runId}-b`, timeoutMs: args.timeoutMs });
	const resultB = await readExtensionResult(evidenceB);
	assertEvidenceRoot(resultB, canonicalRoot, 'replacement B');
	const uniqueA = UNIQUE_COMMANDS[args.languageA];
	const resolvedNames = new Set((resultB.commands ?? []).map(item => item.command.toLowerCase()));
	const resolvedOld = uniqueA.filter(command => resolvedNames.has(command));
	if (resolvedOld.length > 0) {
		throw new Error(`Replacement B resolved A-only commands: ${resolvedOld.join(', ')}`);
	}
	const executableHits = await scanExecutableNames(canonicalRoot, uniqueA, [path.join(canonicalRoot, 'data', 'user-data', 'logs')]);
	if (executableHits.length > 0) {
		throw new Error(`Replacement product/data retains A-only executables: ${executableHits.join(', ')}`);
	}
	return {
		canonicalRoot,
		languageA: args.languageA,
		languageB: args.languageB,
		mode: args.mode,
		pair: args.pair,
		preserveData: args.preserveData,
		projectA,
		projectB,
		resultA,
		resultB,
		runId: context.runId,
		zipASha256: await sha256(args.zipA),
		zipBSha256: await sha256(args.zipB)
	};
}

async function prepareConcurrencyActor(context, options) {
	await assertRemoteProVersion(options.appRoot);
	await runEditorPhase({ ...options, phase: 'prepare' });
	if (options.language === 'typescript') {
		if (context.firewall.rules.length > 0) {
			await context.firewall.remove();
		}
		await runTypeScriptInstall(options.appRoot, options.projectDir, options.evidenceDir, options.timeoutMs);
		if (context.offline) {
			await context.firewall.block(context.firewallRoots);
		}
	}
}

async function runConcurrencyMode(args, setup, context) {
	const appRootA = await extractZipSafe(args.zipA, path.join(setup.runRoot, 'extract-a'));
	const appRootB = await extractZipSafe(args.zipB, path.join(setup.runRoot, 'extract-b'));
	if (samePath(appRootA, appRootB)) {
		throw new Error('Concurrency roots must be distinct');
	}
	context.firewallRoots = [appRootA, appRootB];
	await assertPurifiedPath([args.languageA, args.languageB], args.evidenceDir);
	if (args.offline) {
		await context.firewall.block(context.firewallRoots);
	}
	const barrierDir = path.join(setup.runRoot, 'barrier');
	const evidenceA = path.join(args.evidenceDir, 'a');
	const evidenceB = path.join(args.evidenceDir, 'b');
	const projectA = path.join(setup.workspaceRoot, `${args.languageA}-privacy-survey`);
	const projectB = path.join(setup.workspaceRoot, `${args.languageB}-privacy-survey`);
	await prepareConcurrencyActor(context, { actor: 'a', appRoot: appRootA, evidenceDir: evidenceA, language: args.languageA, mode: args.mode, projectDir: projectA, runId: `${context.runId}-a`, timeoutMs: args.timeoutMs });
	await prepareConcurrencyActor(context, { actor: 'b', appRoot: appRootB, evidenceDir: evidenceB, language: args.languageB, mode: args.mode, projectDir: projectB, runId: `${context.runId}-b`, timeoutMs: args.timeoutMs });
	await fs.mkdir(barrierDir, { recursive: true });
	const peer = {
		appRoot: appRootB,
		evidenceDir: evidenceB,
		executable: path.join(appRootB, 'Code.exe'),
		language: args.languageB,
		projectDir: projectB,
		runId: `${context.runId}-b`
	};
	const actorAPromise = runEditorPhase({ actor: 'a', appRoot: appRootA, barrierDir, concurrencyHoldMs: 3_000, evidenceDir: evidenceA, language: args.languageA, mode: args.mode, peer, phase: 'concurrency', projectDir: projectA, runId: `${context.runId}-a`, timeoutMs: args.timeoutMs });
	await waitForFile(path.join(barrierDir, 'peer-launch.json'), args.timeoutMs, 'actor A peer launch evidence');
	await Promise.all([
		waitForFile(path.join(barrierDir, 'a-paused.json'), args.timeoutMs, 'actor A breakpoint'),
		waitForFile(path.join(barrierDir, 'b-paused.json'), args.timeoutMs, 'actor B breakpoint')
	]);
	const pausedA = await readJson(path.join(barrierDir, 'a-paused.json'));
	const pausedB = await readJson(path.join(barrierDir, 'b-paused.json'));
	const overlapSnapshot = await collectCimProcesses();
	await writeJson(path.join(args.evidenceDir, 'processes', 'concurrency-overlap.json'), { capturedAt: timestamp(), pausedA, pausedB, processes: overlapSnapshot });
	await actorAPromise;
	await waitForFile(path.join(evidenceB, 'state-concurrency.json'), args.timeoutMs, 'actor B completion state');
	const stateB = await readJson(path.join(evidenceB, 'state-concurrency.json'));
	if (stateB.stage !== 'complete') {
		throw new Error(`Actor B did not complete: ${JSON.stringify(stateB)}`);
	}
	const resultA = await readExtensionResult(evidenceA);
	const resultB = await readExtensionResult(evidenceB);
	assertEvidenceRoot(resultA, appRootA, 'concurrency A');
	assertEvidenceRoot(resultB, appRootB, 'concurrency B');
	assertConcurrencyIsolation(resultA, resultB, appRootA, appRootB);
	const startA = Date.parse(pausedA.timestamp);
	const startB = Date.parse(pausedB.timestamp);
	if (!Number.isFinite(startA) || !Number.isFinite(startB) || Math.abs(startA - startB) > args.timeoutMs) {
		throw new Error('Concurrency breakpoint timestamps do not establish overlap');
	}
	return {
		appRootA,
		appRootB,
		languageA: args.languageA,
		languageB: args.languageB,
		mode: args.mode,
		overlap: { actorA: pausedA.timestamp, actorB: pausedB.timestamp },
		pair: args.pair,
		projectA,
		projectB,
		resultA,
		resultB,
		runId: context.runId,
		zipASha256: await sha256(args.zipA),
		zipBSha256: await sha256(args.zipB)
	};
}

function assertConcurrencyIsolation(resultA, resultB, appRootA, appRootB) {
	const checks = [
		['A', resultA, appRootA, appRootB],
		['B', resultB, appRootB, appRootA]
	];
	for (const [label, result, ownRoot, peerRoot] of checks) {
		if (samePath(result.portable.dataRoot, resultA === resultB ? appRootB : appRootA)) {
			throw new Error(`Concurrency ${label} portable data root is not product-local`);
		}
		if (samePath(result.portable.sharedDataRoot, resultA === resultB ? resultA.portable.sharedDataRoot : resultB.portable.sharedDataRoot)) {
			throw new Error('Concurrency portable shared-data roots collide');
		}
		for (const command of result.commands ?? []) {
			if (!isUnder(ownRoot, command.path) || normalizedTextContainsPath(command.path, peerRoot)) {
				throw new Error(`Concurrency ${label} tool cross-contamination: ${command.path}`);
			}
		}
		for (const extension of [...(result.extensions ?? []), result.remotePro].filter(Boolean)) {
			if (!isUnder(ownRoot, extension.extensionPath) || normalizedTextContainsPath(extension.extensionPath, peerRoot)) {
				throw new Error(`Concurrency ${label} extension cross-contamination: ${extension.extensionPath}`);
			}
		}
		for (const value of Object.values(result.process?.environment ?? {})) {
			if (normalizedTextContainsPath(value, peerRoot)) {
				throw new Error(`Concurrency ${label} environment contains peer root`);
			}
		}
	}
	if (samePath(resultA.portable.dataRoot, resultB.portable.dataRoot) || samePath(resultA.portable.sharedDataRoot, resultB.portable.sharedDataRoot)) {
		throw new Error('Concurrency portable data/shared-data roots must be distinct');
	}
}

async function runInternalPeer(args) {
	await compileTestExtension();
	await validateAppRoot(args.appRoot);
	const firewall = new FirewallIsolation(args.evidenceDir);
	const context = { firewall, firewallRoots: [args.appRoot], offline: args.offline, runId: args.runId };
	let error;
	try {
		if (args.offline) {
			await firewall.block(context.firewallRoots);
		}
		await runEditorPhase({
			actor: 'b',
			appRoot: args.appRoot,
			barrierDir: args.barrierDir,
			concurrencyHoldMs: 3_000,
			evidenceDir: args.evidenceDir,
			language: args.language,
			mode: 'concurrency',
			phase: 'concurrency',
			projectDir: args.workspace,
			runId: args.runId,
			timeoutMs: args.timeoutMs
		});
	} catch (caught) {
		error = caught;
		await writeJson(path.join(args.evidenceDir, 'peer-controller-failure.json'), { error: caught instanceof Error ? caught.stack ?? caught.message : String(caught), timestamp: timestamp() });
	} finally {
		try {
			await firewall.remove();
		} catch (cleanupError) {
			error ??= cleanupError;
		}
	}
	if (error) {
		throw error;
	}
}

async function main() {
	let args;
	try {
		args = validateArgs(parseArgs(process.argv.slice(2)));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		printHelp();
		process.exitCode = 2;
		return;
	}
	if (args.help) {
		printHelp();
		return;
	}
	if (args.internalPeer) {
		await runInternalPeer(args);
		return;
	}

	const started = Date.now();
	const setup = await setupRun(args);
	const firewall = new FirewallIsolation(args.evidenceDir);
	const context = { firewall, firewallRoots: [], offline: args.offline, runId: randomUUID() };
	let result = { mode: args.mode, runId: context.runId, startedAt: timestamp() };
	let error;
	try {
		if (args.mode === 'verify') {
			result = { ...result, ...await runVerifyMode(args, setup, context) };
		} else if (args.mode === 'move') {
			result = { ...result, ...await runMoveMode(args, setup, context) };
		} else if (args.mode === 'replacement') {
			result = { ...result, ...await runReplacementMode(args, setup, context) };
		} else {
			result = { ...result, ...await runConcurrencyMode(args, setup, context) };
		}
	} catch (caught) {
		error = caught;
		await writeJson(path.join(args.evidenceDir, 'failure-context.json'), {
			error: caught instanceof Error ? caught.stack ?? caught.message : String(caught),
			processes: await collectCimProcesses().catch(processError => [{ error: String(processError) }]),
			timestamp: timestamp()
		});
	} finally {
		try {
			await firewall.remove();
		} catch (cleanupError) {
			error ??= cleanupError;
		}
		if (!args.keepTemp) {
			await fs.rm(setup.runRoot, { recursive: true, force: true }).catch(cleanupError => {
				error ??= cleanupError;
			});
		} else {
			result.tempRoot = setup.runRoot;
		}
	}
	error = await finishRun(args, setup, result, error);
	await writeJUnit(path.join(args.evidenceDir, 'junit.xml'), `${args.mode}${args.pair ? `-${args.pair}` : `-${args.language}`}`, started, error);
	if (error) {
		throw error;
	}
}

main().catch(error => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
