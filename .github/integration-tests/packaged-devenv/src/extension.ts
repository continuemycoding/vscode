/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

interface PackagedIntegrationConfig {
	actor: 'single' | 'a' | 'b';
	appRoot: string;
	barrierDir?: string;
	concurrencyHoldMs?: number;
	controllerScript: string;
	evidenceDir: string;
	language: Language;
	mode: 'verify' | 'move' | 'replacement' | 'concurrency';
	peer?: PeerLaunchConfig;
	phase: 'prepare' | 'verify' | 'concurrency';
	projectDir: string;
	runId: string;
	stateFile: string;
	testExtensionEntry: string;
	testExtensionRoot: string;
	timeoutMs: number;
}

interface PeerLaunchConfig {
	appRoot: string;
	evidenceDir: string;
	executable: string;
	language: Language;
	launchArgs: string[];
	projectDir: string;
	runId: string;
}

interface ProbeResult {
	language: string;
	missingCommands: string[];
	missingExtensions: Array<{ id: string; label: string }>;
	ready: boolean;
	requiredCommands: string[];
	requiredExtensions: Array<{ id: string; label: string }>;
	supported: boolean;
}

interface CommandEvidence {
	command: string;
	path: string;
	source: 'probe' | 'language';
}

interface ExtensionEvidence {
	active: boolean;
	extensionPath: string;
	id: string;
	packageVersion?: string;
}

interface DapEvidence {
	adapterExecutable?: string;
	adapterProcessId?: number;
	breakpoint?: { line?: number; source: 'setBreakpoints' | 'breakpointEvent' };
	breakpointLine: number;
	observedSessions: Array<{
		id: string;
		name: string;
		preLaunchTask?: unknown;
		type: string;
		workspaceFolder?: string;
	}>;
	processIds: number[];
	stackTrace?: { line: number; source: string };
	stopped?: { at: string; reason: string; threadId: number };
}

interface LanguageEvidence {
	diagnostics?: Array<{ message: string; severity: number; source?: string }>;
	kind: 'completion' | 'diagnostics' | 'document';
	position: { character: number; line: number };
	token: string;
	value: string | string[];
}

interface StageResult {
	actor: PackagedIntegrationConfig['actor'];
	appRoot: string;
	commands: CommandEvidence[];
	dap?: DapEvidence;
	extensions: ExtensionEvidence[];
	language: Language;
	languageEvidence?: LanguageEvidence;
	mode: PackagedIntegrationConfig['mode'];
	phase: PackagedIntegrationConfig['phase'];
	portable: {
		dataRoot: string;
		extensionsRoot: string;
		sharedDataRoot: string;
		userDataRoot: string;
	};
	process: {
		cwd: string;
		environment: Record<string, string>;
		executable: string;
		pid: number;
	};
	probe?: ProbeResult;
	projectDir: string;
	remotePro?: ExtensionEvidence;
	runId: string;
	status: 'passed';
	timestamps: {
		completed: string;
		started: string;
	};
	typescriptInstall?: {
		lockSha256: string;
		npmPath: string;
	};
}

type Language = 'cpp' | 'go' | 'rust' | 'csharp' | 'javascript' | 'typescript' | 'python' | 'lua';
type DapMessage = {
	body?: Record<string, unknown>;
	command?: string;
	event?: string;
	message?: string;
	request_seq?: number;
	seq?: number;
	success?: boolean;
	type?: string;
};

const DEBUG_CONFIGURATION_NAME = '远控Pro: 本地运行';
const REMOTEPRO_ID = 'remotepro-cn.remotepro';
const REMOTEPRO_VERSION = '1.4.4';
const execFileAsync = promisify(execFile);
const sourceFiles: Record<Language, string> = {
	cpp: 'src/main.cpp',
	go: 'src/main.go',
	rust: 'src/main.rs',
	csharp: 'src/Program.cs',
	javascript: 'src/main.js',
	typescript: 'src/main.ts',
	python: 'src/main.py',
	lua: 'src/main.lua'
};
const connectionMarkers: Record<Language, RegExp> = {
	cpp: /RemotePro remote\(/,
	go: /remote := NewRemotePro\(/,
	rust: /RemotePro::new\(/,
	csharp: /RemotePro\.CreateAsync\(/,
	javascript: /RemotePro\.create\(/,
	typescript: /RemotePro\.create\(/,
	python: /with RemotePro\(/,
	lua: /RemotePro\.new\(/
};
const languageChecks: Record<Language, {
	kind: 'completion' | 'diagnostics' | 'document';
	needle: RegExp;
	token: string;
}> = {
	cpp: { kind: 'document', needle: /std::cout/, token: 'std::cout' },
	go: { kind: 'completion', needle: /fmt\.Print/, token: 'fmt.Pr' },
	rust: { kind: 'completion', needle: /std::process/, token: 'std::pro' },
	csharp: { kind: 'completion', needle: /Console\.WriteLine/, token: 'Console.Wri' },
	javascript: { kind: 'completion', needle: /console\.log/, token: 'console.lo' },
	typescript: { kind: 'diagnostics', needle: /console\.log/, token: '__packagedTypeError' },
	python: { kind: 'completion', needle: /sys\.stderr/, token: 'sys.std' },
	lua: { kind: 'completion', needle: /string\.format/, token: 'string.for' }
};

let currentContext: vscode.ExtensionContext | undefined;

function readConfig(): PackagedIntegrationConfig {
	const raw = process.env.PACKAGED_DEVENV_INTEGRATION_CONFIG;
	assert.ok(raw, 'PACKAGED_DEVENV_INTEGRATION_CONFIG is required');
	return JSON.parse(raw) as PackagedIntegrationConfig;
}

function normalize(value: string): string {
	const resolved = path.normalize(path.resolve(value));
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isUnder(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function samePath(left: string | undefined, right: string): boolean {
	return Boolean(left) && normalize(left!) === normalize(right);
}

function writeJson(file: string, value: object): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function now(): string {
	return new Date().toISOString();
}

async function waitFor<T>(get: () => T | undefined | Promise<T | undefined>, description: string, timeoutMs: number): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await get();
		if (value !== undefined) {
			return value;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

function filteredEnvironment(): Record<string, string> {
	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!value) {
			continue;
		}
		if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|COMMONPROGRAMFILES|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|VSCODE_PORTABLE|PACKAGED_DEVENV_|CARGO_HOME|RUSTUP_HOME|DOTNET_ROOT|GOROOT)$/i.test(key)) {
			output[key.toUpperCase() === 'PATH' ? 'PATH' : key] = value;
		}
	}
	return output;
}

async function resolveCommand(command: string): Promise<string> {
	const commandPath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe');
	const { stdout } = await execFileAsync(commandPath, [command], {
		env: process.env,
		encoding: 'utf8',
		timeout: 15_000,
		windowsHide: true
	});
	const matches = stdout.split(/\r?\n/).filter(Boolean);
	const found = matches.find(candidate => fs.existsSync(candidate));
	assert.ok(found, `where.exe did not resolve ${command}`);
	return path.resolve(found);
}

async function activateRemotePro(): Promise<vscode.Extension<unknown>> {
	const extension = vscode.extensions.getExtension(REMOTEPRO_ID);
	assert.ok(extension, `${REMOTEPRO_ID} must be installed as a system extension`);
	assert.equal(extension.packageJSON.version, REMOTEPRO_VERSION, `expected RemotePro ${REMOTEPRO_VERSION}`);
	assert.ok(!extension.extensionPath.includes('.github\\integration-tests\\packaged-devenv'), 'RemotePro must not be loaded from the test extension path');
	await extension.activate();
	return extension;
}

function extensionEvidence(extension: vscode.Extension<unknown>): ExtensionEvidence {
	return {
		active: extension.isActive,
		extensionPath: extension.extensionPath,
		id: extension.id,
		packageVersion: typeof extension.packageJSON.version === 'string' ? extension.packageJSON.version : undefined
	};
}

function assertRootedEvidence(cfg: PackagedIntegrationConfig, commands: CommandEvidence[], extensions: ExtensionEvidence[]): void {
	for (const command of commands) {
		assert.ok(isUnder(cfg.appRoot, command.path), `${command.command} resolved outside current app root: ${command.path}`);
	}
	for (const extension of extensions) {
		assert.ok(isUnder(cfg.appRoot, extension.extensionPath), `${extension.id} loaded outside current app root: ${extension.extensionPath}`);
	}
}

async function probeAndCollect(cfg: PackagedIntegrationConfig): Promise<{
	commands: CommandEvidence[];
	extensions: ExtensionEvidence[];
	probe: ProbeResult;
	remotePro: ExtensionEvidence;
}> {
	const remoteProExtension = await activateRemotePro();
	const probe = await vscode.commands.executeCommand<ProbeResult>('remotepro.internal.integration.probe', { language: cfg.language });
	assert.ok(probe, 'RemotePro probe returned no result');
	assert.equal(probe.supported, true, `language is unsupported: ${JSON.stringify(probe)}`);
	assert.equal(probe.ready, true, `packaged environment is not ready: ${JSON.stringify(probe)}`);
	assert.deepEqual(probe.missingCommands, [], 'probe reported missing commands');
	assert.deepEqual(probe.missingExtensions, [], 'probe reported missing extensions');

	const commands: CommandEvidence[] = [];
	for (const command of probe.requiredCommands) {
		if (command === 'rust-gnu-toolchain') {
			for (const concrete of ['rustup', 'rustc', 'gcc']) {
				commands.push({ command: concrete, path: await resolveCommand(concrete), source: 'probe' });
			}
			continue;
		}
		commands.push({ command, path: await resolveCommand(command), source: 'probe' });
	}
	const extensions: ExtensionEvidence[] = [];
	for (const required of probe.requiredExtensions) {
		const extension = vscode.extensions.getExtension(required.id);
		assert.ok(extension, `required extension is not installed: ${required.id}`);
		if (!extension.isActive) {
			await extension.activate();
		}
		extensions.push(extensionEvidence(extension));
	}
	const remotePro = extensionEvidence(remoteProExtension);
	assertRootedEvidence(cfg, commands, [...extensions, remotePro]);
	return { commands, extensions, probe, remotePro };
}

async function createProject(cfg: PackagedIntegrationConfig): Promise<void> {
	const parent = path.dirname(cfg.projectDir);
	fs.mkdirSync(parent, { recursive: true });
	await vscode.commands.executeCommand('remotepro.internal.integration.create', {
		overwrite: true,
		projectDir: cfg.projectDir,
		projectName: path.basename(cfg.projectDir),
		templateId: `${cfg.language}-privacy-survey`
	});
	for (const required of ['.remotepro/project.json', '.vscode/launch.json', sourceFiles[cfg.language]]) {
		assert.ok(fs.existsSync(path.join(cfg.projectDir, required)), `missing generated file ${required}`);
	}
	const launchPath = path.join(cfg.projectDir, '.vscode', 'launch.json');
	const launchText = fs.readFileSync(launchPath, 'utf8').replace(/127\.0\.0\.1|localhost/g, '192.0.2.1');
	assert.ok(launchText.includes('192.0.2.1'), 'launch host was not replaced with documentation address');
	fs.writeFileSync(launchPath, launchText, 'utf8');
}

function findSingleMarkerLine(sourcePath: string, language: Language): number {
	const lines = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/);
	const matching = lines.flatMap((line, index) => connectionMarkers[language].test(line) ? [index] : []);
	assert.equal(matching.length, 1, `expected exactly one RemotePro connection marker in ${sourcePath}`);
	return matching[0];
}

async function openAndExerciseLanguage(cfg: PackagedIntegrationConfig): Promise<LanguageEvidence> {
	const sourcePath = path.join(cfg.projectDir, sourceFiles[cfg.language]);
	const document = await vscode.workspace.openTextDocument(sourcePath);
	await vscode.window.showTextDocument(document);
	const check = languageChecks[cfg.language];
	const marker = check.needle.exec(document.getText());
	assert.ok(marker, `language token anchor not found in ${sourcePath}`);
	const anchor = document.positionAt(marker.index + marker[0].length);

	if (check.kind === 'document') {
		assert.equal(document.languageId, cfg.language === 'cpp' ? 'cpp' : cfg.language, `${cfg.language} document language id`);
		return {
			kind: 'document',
			position: { character: anchor.character, line: anchor.line },
			token: check.token,
			value: [document.languageId]
		};
	}

	if (check.kind === 'completion') {
		const completion = await waitFor(async () => {
			const current = await vscode.commands.executeCommand<vscode.CompletionList>(
				'vscode.executeCompletionItemProvider',
				document.uri,
				anchor,
				'.'
			);
			return current && current.items.length > 0 ? current : undefined;
		}, `${cfg.language} completion items`, Math.min(cfg.timeoutMs, 120_000));
		return {
			kind: 'completion',
			position: { character: anchor.character, line: anchor.line },
			token: check.token,
			value: completion.items.slice(0, 50).map(item => typeof item.label === 'string' ? item.label : item.label.label)
		};
	}

	const edit = new vscode.WorkspaceEdit();
	const injected = `\nconst ${check.token}: number = "packaged-devenv";\n`;
	edit.insert(document.uri, new vscode.Position(document.lineCount, 0), injected);
	assert.equal(await vscode.workspace.applyEdit(edit), true, 'failed to inject TypeScript diagnostic sentinel');
	try {
		const diagnostics = await waitFor(() => {
			const current = vscode.languages.getDiagnostics(document.uri);
			return current.some(item => item.message.includes('string') && item.message.includes('number')) ? current : undefined;
		}, 'TypeScript semantic diagnostic', Math.min(cfg.timeoutMs, 120_000));
		return {
			diagnostics: diagnostics.map(item => ({ message: item.message, severity: item.severity, source: item.source })),
			kind: 'diagnostics',
			position: { character: 0, line: document.lineCount - 1 },
			token: check.token,
			value: diagnostics.map(item => item.message)
		};
	} finally {
		await vscode.commands.executeCommand('workbench.action.files.revert');
	}
}

async function runBuildTask(cfg: PackagedIntegrationConfig): Promise<void> {
	const tasks = await vscode.tasks.fetchTasks({ type: 'remotepro' });
	const task = tasks.find(candidate => candidate.name === 'remotepro: build' || candidate.definition.command === 'build');
	assert.ok(task, 'remotepro build task was not provided');
	const execution = await vscode.tasks.executeTask(task);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			disposable.dispose();
			void execution.terminate();
			reject(new Error(`remotepro build task exceeded ${cfg.timeoutMs}ms`));
		}, cfg.timeoutMs);
		const disposable = vscode.tasks.onDidEndTaskProcess(event => {
			if (event.execution !== execution) {
				return;
			}
			clearTimeout(timer);
			disposable.dispose();
			if (event.exitCode === 0) {
				resolve();
			} else {
				reject(new Error(`remotepro build task exited ${event.exitCode ?? 'without a process exit code'} (CARGO_HOME=${process.env.CARGO_HOME ?? ''} RUSTUP_HOME=${process.env.RUSTUP_HOME ?? ''} CARGO_NET_OFFLINE=${process.env.CARGO_NET_OFFLINE ?? ''})`));
			}
		});
	});
}

function dapBody(message: DapMessage): Record<string, unknown> {
	return message.body ?? {};
}

function arrayField(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? value.filter(item => typeof item === 'object' && item !== null) as Array<Record<string, unknown>> : [];
}

async function runDebug(cfg: PackagedIntegrationConfig, holdAtBreakpoint: boolean): Promise<DapEvidence> {
	const sourcePath = path.join(cfg.projectDir, sourceFiles[cfg.language]);
	const sourceLineIndex = findSingleMarkerLine(sourcePath, cfg.language);
	const breakpointLine = sourceLineIndex + 1;
	const evidence: DapEvidence = { breakpointLine, observedSessions: [], processIds: [] };
	const requests = new Set<number>();
	let stackTraceError: Error | undefined;
	let targetSession: vscode.DebugSession | undefined;
	const sourceBreakpoint = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(sourcePath), new vscode.Position(sourceLineIndex, 0)));
	vscode.debug.addBreakpoints([sourceBreakpoint]);

	const tracker = vscode.debug.registerDebugAdapterTrackerFactory('*', {
		createDebugAdapterTracker(session) {
			evidence.observedSessions.push({
				id: session.id,
				name: session.configuration.name,
				preLaunchTask: session.configuration.preLaunchTask,
				type: session.type,
				workspaceFolder: session.workspaceFolder?.uri.fsPath
			});
			return {
				onDidSendMessage(message: DapMessage) {
					const body = dapBody(message);
					if (message.type === 'response' && message.command === 'runInTerminal') {
						const processId = Number(body.processId ?? body.shellProcessId);
						if (Number.isInteger(processId)) {
							evidence.processIds.push(processId);
						}
					}
					if (message.type === 'response' && message.command === 'setBreakpoints' && message.success !== false && message.request_seq !== undefined && requests.has(message.request_seq)) {
						const hit = arrayField(body.breakpoints).find(item => item.verified === true && item.line === breakpointLine);
						if (hit) {
							evidence.breakpoint ??= { line: Number(hit.line), source: 'setBreakpoints' };
						}
					}
					if (message.type === 'event' && message.event === 'breakpoint') {
						const item = typeof body.breakpoint === 'object' && body.breakpoint !== null ? body.breakpoint as Record<string, unknown> : undefined;
						if (item?.verified === true && item.line === breakpointLine) {
							evidence.breakpoint ??= { line: Number(item.line), source: 'breakpointEvent' };
						}
					}
					if (message.type === 'event' && message.event === 'process') {
						const processId = Number(body.systemProcessId);
						if (Number.isInteger(processId)) {
							evidence.processIds.push(processId);
						}
					}
					if (message.type === 'event' && message.event === 'stopped' && Number.isInteger(body.threadId)) {
						const threadId = Number(body.threadId);
						const reason = String(body.reason ?? '');
						if (reason !== 'breakpoint') {
							void session.customRequest('continue', { threadId });
							return;
						}
						targetSession = session;
						evidence.stopped = { at: now(), reason, threadId };
						void session.customRequest('stackTrace', { levels: 20, startFrame: 0, threadId }).then((response: { stackFrames?: Array<{ line?: number; source?: { path?: string } }> }) => {
							const frame = response.stackFrames?.find(candidate => samePath(candidate.source?.path, sourcePath));
							if (frame?.source?.path && Number.isInteger(frame.line)) {
								evidence.stackTrace = { line: frame.line!, source: frame.source.path };
							}
						}, error => {
							stackTraceError = error instanceof Error ? error : new Error(String(error));
						});
					}
				},
				onWillReceiveMessage(message: DapMessage) {
					if (message.type === 'request' && message.command === 'setBreakpoints' && Number.isInteger(message.seq)) {
						const body = (message as DapMessage & { arguments?: { source?: { path?: string } } }).arguments;
						if (samePath(body?.source?.path, sourcePath)) {
							requests.add(message.seq!);
						}
					}
				}
			};
		}
	});

	try {
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(sourcePath));
		assert.ok(folder, 'generated project is not the active workspace folder');
		assert.equal(await vscode.debug.startDebugging(folder, DEBUG_CONFIGURATION_NAME), true, 'debug session did not start');
		await waitFor(() => evidence.stopped, 'breakpoint stop', cfg.timeoutMs);
		await waitFor(() => evidence.breakpoint, 'verified breakpoint', Math.min(cfg.timeoutMs, 30_000));
		await waitFor(() => {
			if (stackTraceError) {
				throw stackTraceError;
			}
			return evidence.stackTrace;
		}, 'matching stack frame', Math.min(cfg.timeoutMs, 30_000));
		assert.equal(evidence.stopped?.reason, 'breakpoint');
		assert.equal(evidence.stackTrace?.line, breakpointLine, 'stack frame line mismatch');
		assert.ok(samePath(evidence.stackTrace?.source, sourcePath), 'stack frame source mismatch');
		if (holdAtBreakpoint) {
			await holdConcurrencyBreakpoint(cfg, evidence);
		}
		return evidence;
	} finally {
		try {
			await vscode.debug.stopDebugging(targetSession);
		} catch {
			// The adapter may have terminated while collecting failure evidence.
		}
		tracker.dispose();
		vscode.debug.removeBreakpoints([sourceBreakpoint]);
	}
}

async function holdConcurrencyBreakpoint(cfg: PackagedIntegrationConfig, evidence: DapEvidence): Promise<void> {
	assert.ok(cfg.barrierDir, 'concurrency barrier directory is required');
	fs.mkdirSync(cfg.barrierDir, { recursive: true });
	const pausedFile = path.join(cfg.barrierDir, `${cfg.actor}-paused.json`);
	writeJson(pausedFile, { actor: cfg.actor, appRoot: cfg.appRoot, dap: evidence, pid: process.pid, timestamp: now() });
	if (cfg.actor === 'a') {
		await vscode.commands.executeCommand('packagedDevenv.launchPeer');
	}
	const peer = cfg.actor === 'a' ? 'b' : 'a';
	await waitFor(() => fs.existsSync(path.join(cfg.barrierDir!, `${peer}-paused.json`)) ? true : undefined, `${peer} breakpoint barrier`, cfg.timeoutMs);
	await new Promise(resolve => setTimeout(resolve, cfg.concurrencyHoldMs ?? 2_000));
}

async function launchPeer(cfg: PackagedIntegrationConfig): Promise<void> {
	assert.equal(cfg.mode, 'concurrency', 'peer launch is only valid in concurrency mode');
	assert.equal(cfg.actor, 'a', 'only actor A may launch actor B');
	assert.ok(cfg.peer, 'peer launch config is missing');
	assert.ok(cfg.testExtensionRoot && fs.existsSync(cfg.testExtensionRoot), 'test extension root is missing');
	assert.ok(cfg.testExtensionEntry && fs.existsSync(cfg.testExtensionEntry), 'test extension entry is missing');
	assert.ok(fs.existsSync(cfg.peer.executable), `peer Code.exe is missing: ${cfg.peer.executable}`);
	assert.ok(Array.isArray(cfg.peer.launchArgs) && cfg.peer.launchArgs.length > 0, 'peer launch args missing');
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	env.ELECTRON_ENABLE_LOGGING = '1';
	env.NO_PROXY = '*';
	env.no_proxy = '*';
	env.PACKAGED_DEVENV_INTEGRATION_CONFIG = JSON.stringify({
		actor: 'b',
		appRoot: cfg.peer.appRoot,
		barrierDir: cfg.barrierDir,
		concurrencyHoldMs: cfg.concurrencyHoldMs ?? 2_000,
		controllerScript: cfg.controllerScript,
		evidenceDir: cfg.peer.evidenceDir,
		language: cfg.peer.language,
		mode: 'concurrency',
		phase: 'concurrency',
		projectDir: cfg.peer.projectDir,
		runId: cfg.peer.runId,
		stateFile: path.join(cfg.peer.evidenceDir, 'state-concurrency.json'),
		testExtensionEntry: cfg.testExtensionEntry,
		testExtensionRoot: cfg.testExtensionRoot,
		timeoutMs: cfg.timeoutMs
	});
	env.REMOTEPRO_INTEGRATION_TEST = '1';
	const args = cfg.peer.launchArgs;
	const child = execFile(cfg.peer.executable, args, {
		cwd: cfg.peer.appRoot,
		env
	});
	assert.ok(child.pid, 'failed to launch actor B');
	writeJson(path.join(cfg.barrierDir!, 'peer-launch.json'), {
		args,
		codeExecutable: cfg.peer.executable,
		controllerPid: child.pid,
		launcherAppRoot: cfg.appRoot,
		peerAppRoot: cfg.peer.appRoot,
		timestamp: now()
	});
	child.unref();
}

function portableEvidence(cfg: PackagedIntegrationConfig): StageResult['portable'] {
	const dataRoot = process.env.VSCODE_PORTABLE;
	assert.ok(dataRoot, 'VSCODE_PORTABLE was not set by the packaged application');
	const expected = path.join(cfg.appRoot, 'data');
	assert.ok(samePath(dataRoot, expected), `portable data root mismatch: ${dataRoot}`);
	const portable = {
		dataRoot,
		extensionsRoot: path.join(dataRoot, 'extensions'),
		sharedDataRoot: path.join(dataRoot, 'shared-data'),
		userDataRoot: path.join(dataRoot, 'user-data')
	};
	for (const location of Object.values(portable)) {
		assert.ok(isUnder(cfg.appRoot, location), `portable location escaped app root: ${location}`);
	}
	return portable;
}

async function runPrepare(cfg: PackagedIntegrationConfig): Promise<void> {
	await activateRemotePro();
	await createProject(cfg);
	writeJson(cfg.stateFile, {
		actor: cfg.actor,
		appRoot: cfg.appRoot,
		language: cfg.language,
		mode: cfg.mode,
		phase: cfg.phase,
		projectDir: cfg.projectDir,
		stage: 'prepared',
		timestamp: now()
	});
}

async function runVerification(cfg: PackagedIntegrationConfig): Promise<StageResult> {
	const started = now();
	const folder = vscode.workspace.workspaceFolders?.[0];
	assert.ok(folder && samePath(folder.uri.fsPath, cfg.projectDir), `verification must open ${cfg.projectDir}`);
	const collected = await probeAndCollect(cfg);
	const languageEvidence = await openAndExerciseLanguage(cfg);
	await runBuildTask(cfg);
	const dap = await runDebug(cfg, cfg.mode === 'concurrency');
	const adapterPaths = collectAdapterPaths(cfg, dap, collected.extensions);
	assertRootedEvidence(cfg, adapterPaths, []);
	const result: StageResult = {
		actor: cfg.actor,
		appRoot: cfg.appRoot,
		commands: [...collected.commands, ...adapterPaths],
		dap,
		extensions: collected.extensions,
		language: cfg.language,
		languageEvidence,
		mode: cfg.mode,
		phase: cfg.phase,
		portable: portableEvidence(cfg),
		process: {
			cwd: process.cwd(),
			environment: filteredEnvironment(),
			executable: process.execPath,
			pid: process.pid
		},
		probe: collected.probe,
		projectDir: cfg.projectDir,
		remotePro: collected.remotePro,
		runId: cfg.runId,
		status: 'passed',
		timestamps: { completed: now(), started }
	};
	const typescriptInstallFile = path.join(cfg.evidenceDir, 'typescript-install.json');
	if (fs.existsSync(typescriptInstallFile)) {
		result.typescriptInstall = JSON.parse(fs.readFileSync(typescriptInstallFile, 'utf8')) as StageResult['typescriptInstall'];
	}
	return result;
}

function collectAdapterPaths(cfg: PackagedIntegrationConfig, dap: DapEvidence, extensions: ExtensionEvidence[]): CommandEvidence[] {
	const candidates: Array<{ command: string; path: string }> = [];
	for (const extension of extensions) {
		for (const relative of [
			'extension/debugAdapters',
			'extension/debugpy',
			'dist/debugpy',
			'adapter',
			'debugAdapters',
			'bin'
		]) {
			const root = path.join(extension.extensionPath, relative);
			if (!fs.existsSync(root)) {
				continue;
			}
			for (const file of walkExecutables(root, 4)) {
				candidates.push({ command: `adapter:${path.basename(file)}`, path: file });
			}
		}
	}
	if (dap.adapterExecutable) {
		candidates.push({ command: 'adapter:descriptor', path: dap.adapterExecutable });
	}
	return candidates.map(candidate => ({ ...candidate, source: 'language' as const })).filter(candidate => isUnder(cfg.appRoot, candidate.path));
}

function walkExecutables(root: string, maxDepth: number): string[] {
	const output: string[] = [];
	const queue: Array<{ depth: number; directory: string }> = [{ depth: 0, directory: root }];
	while (queue.length > 0 && output.length < 200) {
		const current = queue.shift()!;
		for (const entry of fs.readdirSync(current.directory, { withFileTypes: true })) {
			const full = path.join(current.directory, entry.name);
			if (entry.isDirectory() && current.depth < maxDepth) {
				queue.push({ depth: current.depth + 1, directory: full });
			} else if (entry.isFile() && /\.(exe|cmd|bat|ps1|js|cjs|mjs|py)$/i.test(entry.name)) {
				output.push(full);
			}
		}
	}
	return output;
}

async function execute(): Promise<void> {
	const cfg = readConfig();
	try {
		if (cfg.phase === 'prepare') {
			await runPrepare(cfg);
			return;
		}
		const result = await runVerification(cfg);
		writeJson(path.join(cfg.evidenceDir, 'extension-result.json'), result);
		writeJson(cfg.stateFile, {
			actor: cfg.actor,
			appRoot: cfg.appRoot,
			language: cfg.language,
			mode: cfg.mode,
			phase: cfg.phase,
			stage: 'complete',
			timestamp: now()
		});
	} catch (error) {
		writeJson(path.join(cfg.evidenceDir, 'extension-failure.json'), {
			actor: cfg.actor,
			appRoot: cfg.appRoot,
			environment: filteredEnvironment(),
			error: error instanceof Error ? error.stack ?? error.message : String(error),
			language: cfg.language,
			mode: cfg.mode,
			phase: cfg.phase,
			pid: process.pid,
			timestamp: now()
		});
		throw error;
	}
}

export function activate(context: vscode.ExtensionContext): void {
	currentContext = context;
	context.subscriptions.push(
		vscode.commands.registerCommand('packagedDevenv.run', execute),
		vscode.commands.registerCommand('packagedDevenv.launchPeer', async () => launchPeer(readConfig()))
	);
}

export function deactivate(): void {
	currentContext = undefined;
}

export async function run(): Promise<void> {
	assert.ok(currentContext, 'test extension must activate before the test entry runs');
	await vscode.commands.executeCommand('packagedDevenv.run');
}
