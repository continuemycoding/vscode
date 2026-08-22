/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import { tmpdir } from 'os';
import * as path from '../../common/path.js';
import { BUNDLED_DEV_ENVIRONMENT_MANAGED_ENV, BUNDLED_DEV_ENVIRONMENT_ROOT, BUNDLED_DEV_ENVIRONMENT_VALUES, createBundledDevEnvironmentEnvironment, loadBundledDevEnvironmentConfiguration, parseBundledDevEnvironmentManifest, resolveBundledDevEnvironmentManifest } from '../../node/bundledDevEnvironment.js';
import { Promises } from '../../node/pfs.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';
import { getRandomTestPath } from './testUtils.js';

suite('Bundled Development Environment', () => {

	const rootA = 'C:\\Apps\\A';
	const rootB = 'C:\\Apps\\B';
	let testDir: string;

	ensureNoDisposablesAreLeakedInTestSuite();

	setup(async () => {
		testDir = getRandomTestPath(tmpdir(), 'vsctests', 'bundledDevEnvironment');
		await fs.promises.mkdir(testDir, { recursive: true });
	});

	teardown(() => Promises.rm(testDir));

	test('capability disabled leaves the environment unchanged', () => {
		const environment = {
			PATH: 'C:\\Apps\\A\\dev-env\\bin;C:\\Windows',
			VSCODE_PORTABLE: 'C:\\foreign-data',
			VSCODE_IPC_HOOK: '\\\\.\\pipe\\foreign',
		};

		assert.deepStrictEqual(createBundledDevEnvironmentEnvironment(environment, undefined, true), environment);
	});

	test('loads a valid manifest with dev-env and state paths', async () => {
		const productRoot = path.join(testDir, 'product');
		await createProduct(productRoot, {
			path: ['bin', 'tools'],
			env: { CARGO_HOME: '.cargo' },
			state: { NUGET_PACKAGES: 'nuget/packages' },
		}, ['bin', 'tools', '.cargo']);

		const configuration = loadBundledDevEnvironmentConfiguration(productRoot, process.platform === 'win32');
		assert.deepStrictEqual(configuration, {
			productRoot,
			dataRoot: path.join(productRoot, 'data'),
			devEnvironmentRoot: path.join(productRoot, 'dev-env'),
			stateRoot: path.join(productRoot, 'data', 'dev-env-state'),
			pathEntries: [path.join(productRoot, 'dev-env', 'bin'), path.join(productRoot, 'dev-env', 'tools')],
			environment: {
				CARGO_HOME: path.join(productRoot, 'dev-env', '.cargo'),
				NUGET_PACKAGES: path.join(productRoot, 'data', 'dev-env-state', 'nuget', 'packages'),
			},
			literalEnvironment: {},
			devEnvironmentVariableNames: ['CARGO_HOME'],
			stateEnvironmentVariableNames: ['NUGET_PACKAGES'],
			literalEnvironmentVariableNames: [],
			managedEnvironmentVariableNames: ['CARGO_HOME', 'NUGET_PACKAGES'],
		});
	});

	test('rejects absolute, drive-relative, empty, traversal, and invalid env entries', () => {
		for (const manifest of [
			{ path: ['C:\\tools'], env: {}, state: {} },
			{ path: ['C:tools'], env: {}, state: {} },
			{ path: ['\\\\server\\share'], env: {}, state: {} },
			{ path: [''], env: {}, state: {} },
			{ path: ['..\\outside'], env: {}, state: {} },
			{ path: ['tools\\..\\bin'], env: {}, state: {} },
			{ path: ['bin;C:\\Windows'], env: {}, state: {} },
			{ path: [], env: { 'BAD-NAME': 'tools' }, state: {} },
			{ path: [], env: { PATH: 'tools' }, state: {} },
		]) {
			assert.throws(() => resolveBundledDevEnvironmentManifest(rootB, parseBundledDevEnvironmentManifest(JSON.stringify(manifest)), true));
		}
	});

	test('rejects unknown manifest properties', () => {
		assert.throws(() => parseBundledDevEnvironmentManifest('{"path":[],"unexpected":true}'), /Unknown bundled development environment manifest property/);
	});

	test('invalid manifest fails atomically', () => {
		const environment = {
			PATH: 'C:\\Windows',
			VSCODE_PORTABLE: 'C:\\foreign-data',
			VSCODE_IPC_HOOK: '\\\\.\\pipe\\foreign',
		};
		const snapshot = { ...environment };

		assert.throws(() => resolveBundledDevEnvironmentManifest(rootB, parseBundledDevEnvironmentManifest('{"path":["bin"],"env":{"BAD-NAME":"tools"}}'), true));
		assert.deepStrictEqual(environment, snapshot);
	});

	test('A to B removes inherited product state and binds B', () => {
		const configuration = configurationFor(rootB, ['bin'], { CARGO_HOME: '.cargo' }, { NUGET_PACKAGES: 'nuget' }, { GOTOOLCHAIN: 'local' });
		const environment = createBundledDevEnvironmentEnvironment({
			Path: 'C:\\Apps\\A\\dev-env\\bin\\;C:\\Windows;C:\\Apps\\Alphabet\\dev-env\\bin',
			[BUNDLED_DEV_ENVIRONMENT_ROOT]: `${rootA}\\`,
			[BUNDLED_DEV_ENVIRONMENT_MANAGED_ENV]: '["CARGO_HOME","NUGET_PACKAGES","GOTOOLCHAIN","UNRELATED"]',
			CARGO_HOME: 'c:\\apps\\a\\dev-env\\.cargo',
			NUGET_PACKAGES: 'C:\\Apps\\A\\data\\dev-env-state\\nuget',
			GOTOOLCHAIN: 'local',
			UNRELATED: 'C:\\Elsewhere',
			VSCODE_PORTABLE: 'C:\\Apps\\A\\data',
			VSCODE_IPC_HOOK: '\\\\.\\pipe\\a',
			VSCODE_IPC_HOOK_CLI: '\\\\.\\pipe\\a-cli',
			VSCODE_ENV_PREPEND: '{}',
			VSCODE_ENV_REPLACE: '{}',
			VSCODE_ENV_APPEND: '{}',
			VSCODE_CLI: '1',
			VSCODE_PID: '42',
			TEMP: 'C:\\Apps\\A\\data\\tmp',
			TMP: 'c:\\apps\\a\\data\\tmp\\nested',
		}, configuration, true);

		assert.deepStrictEqual(environment, {
			PATH: 'C:\\Apps\\B\\dev-env\\bin;C:\\Windows;C:\\Apps\\Alphabet\\dev-env\\bin',
			UNRELATED: 'C:\\Elsewhere',
			CARGO_HOME: 'C:\\Apps\\B\\dev-env\\.cargo',
			NUGET_PACKAGES: 'C:\\Apps\\B\\data\\dev-env-state\\nuget',
			GOTOOLCHAIN: 'local',
			VSCODE_PORTABLE: 'C:\\Apps\\B\\data',
			[BUNDLED_DEV_ENVIRONMENT_ROOT]: rootB,
			[BUNDLED_DEV_ENVIRONMENT_MANAGED_ENV]: '["CARGO_HOME","NUGET_PACKAGES","GOTOOLCHAIN"]',
			[BUNDLED_DEV_ENVIRONMENT_VALUES]: JSON.stringify({
				env: {
					CARGO_HOME: 'C:\\Apps\\B\\dev-env\\.cargo',
					NUGET_PACKAGES: 'C:\\Apps\\B\\data\\dev-env-state\\nuget',
					GOTOOLCHAIN: 'local',
				},
				path: ['C:\\Apps\\B\\dev-env\\bin'],
			}),
		});
	});

	test('same-root reentry is idempotent and preserves CLI routing', () => {
		const configuration = configurationFor(rootB, ['bin', 'tools'], { CARGO_HOME: '.cargo' });
		const once = createBundledDevEnvironmentEnvironment({
			PATH: 'C:\\Windows',
			VSCODE_CLI: '1',
			VSCODE_IPC_HOOK: '\\\\.\\pipe\\b',
			VSCODE_IPC_HOOK_CLI: '\\\\.\\pipe\\b-cli',
			VSCODE_PID: '42',
		}, configuration, true);
		const twice = createBundledDevEnvironmentEnvironment(once, configuration, true);

		assert.deepStrictEqual(twice, once);
	});

	test('PATH cleanup is case-insensitive, segment-based, and preserves prefixes', () => {
		const configuration = configurationFor(rootB, ['bin']);
		const environment = createBundledDevEnvironmentEnvironment({
			PATH: [
				'C:\\APPS\\B\\DEV-ENV\\BIN\\',
				'C:\\Apps\\B\\dev-env-tools\\bin',
				'C:\\Apps\\Bee\\dev-env\\bin',
				'C:\\Windows',
			].join(';'),
		}, configuration, true);

		assert.strictEqual(environment.PATH, 'C:\\Apps\\B\\dev-env\\bin;C:\\Apps\\B\\dev-env-tools\\bin;C:\\Apps\\Bee\\dev-env\\bin;C:\\Windows');
	});

	test('forged marker cannot clear arbitrary values', () => {
		const configuration = configurationFor(rootB, ['bin'], { CARGO_HOME: '.cargo' });
		const environment = createBundledDevEnvironmentEnvironment({
			PATH: 'C:\\Windows',
			[BUNDLED_DEV_ENVIRONMENT_ROOT]: 'not-an-absolute-root',
			[BUNDLED_DEV_ENVIRONMENT_MANAGED_ENV]: '["USERPROFILE"]',
			USERPROFILE: 'C:\\Users\\me',
			VSCODE_IPC_HOOK: '\\\\.\\pipe\\current',
			VSCODE_ENV_PREPEND: '{}',
		}, configuration, true);

		assert.deepStrictEqual({
			USERPROFILE: environment.USERPROFILE,
			VSCODE_IPC_HOOK: environment.VSCODE_IPC_HOOK,
			VSCODE_ENV_PREPEND: environment.VSCODE_ENV_PREPEND,
		}, {
			USERPROFILE: 'C:\\Users\\me',
			VSCODE_IPC_HOOK: '\\\\.\\pipe\\current',
			VSCODE_ENV_PREPEND: '{}',
		});
	});

	test('cross-root cleanup preserves TEMP and managed values outside old roots', () => {
		const configuration = configurationFor(rootB, []);
		const environment = createBundledDevEnvironmentEnvironment({
			PATH: 'C:\\Windows',
			[BUNDLED_DEV_ENVIRONMENT_ROOT]: rootA,
			[BUNDLED_DEV_ENVIRONMENT_MANAGED_ENV]: '["CARGO_HOME"]',
			CARGO_HOME: 'D:\\Shared\\cargo',
			TEMP: 'D:\\Temp',
			TMP: 'C:\\Apps\\A\\data-other\\tmp',
		}, configuration, true);

		assert.deepStrictEqual({
			CARGO_HOME: environment.CARGO_HOME,
			TEMP: environment.TEMP,
			TMP: environment.TMP,
		}, {
			CARGO_HOME: 'D:\\Shared\\cargo',
			TEMP: 'D:\\Temp',
			TMP: 'C:\\Apps\\A\\data-other\\tmp',
		});
	});

	async function createProduct(productRoot: string, manifest: object, directories: readonly string[]): Promise<void> {
		await fs.promises.mkdir(path.join(productRoot, 'data'), { recursive: true });
		await fs.promises.mkdir(path.join(productRoot, 'dev-env'), { recursive: true });
		for (const directory of directories) {
			await fs.promises.mkdir(path.join(productRoot, 'dev-env', directory), { recursive: true });
		}
		await fs.promises.writeFile(path.join(productRoot, 'dev-env', 'path-entries.json'), JSON.stringify(manifest));
	}

	function configurationFor(productRoot: string, pathEntries: readonly string[], env: Readonly<Record<string, string>> = {}, state: Readonly<Record<string, string>> = {}, values: Readonly<Record<string, string>> = {}) {
		return resolveBundledDevEnvironmentManifest(productRoot, { path: pathEntries, env, state, values }, true);
	}
});
