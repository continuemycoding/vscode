/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promisify } from 'util';
import { dirname, isAbsolute, join } from '../../../../base/common/path.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { IProductService } from '../../../../platform/product/common/productService.js';

const execFileAsync = promisify(execFile);

const defaultDevEnvInitStatusKey = 'initializing-default-dev-env';

type PathEntriesFile = {
	path?: string[];
	env?: Record<string, string>;
};

/**
 * First-run helper: register prebundled toolchain directories from
 * `{installRoot}/bootstrap/dev-env/path-entries.json` into the user PATH / env.
 * Does not copy files or download anything — mirrors RemotePro's final addUserPath step.
 */
export class DefaultDevEnvInitializer extends Disposable {
	constructor(
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IProductService private readonly productService: IProductService,
	) {
		super();

		if (isWindows && storageService.getBoolean(defaultDevEnvInitStatusKey, StorageScope.APPLICATION, true)) {
			storageService.store(defaultDevEnvInitStatusKey, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
			this.initializeDefaultDevEnv().then(() => storageService.store(defaultDevEnvInitStatusKey, false, StorageScope.APPLICATION, StorageTarget.MACHINE));
		}
	}

	private async initializeDefaultDevEnv(): Promise<void> {
		const entriesUri = this.getPathEntriesLocation();
		let raw: string;
		try {
			const content = await this.fileService.readFile(entriesUri);
			raw = content.value.toString();
		} catch (error) {
			if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) {
				this.logService.debug('There is no default dev-env path-entries.json', entriesUri.toString());
				return;
			}
			this.logService.error('Error reading default dev-env path-entries.json', getErrorMessage(error));
			return;
		}

		let parsed: PathEntriesFile;
		try {
			parsed = JSON.parse(raw) as PathEntriesFile;
		} catch (error) {
			this.logService.error('Invalid default dev-env path-entries.json', getErrorMessage(error));
			return;
		}

		const root = this.getDevEnvRoot();
		const pathDirs = (parsed.path ?? [])
			.map(rel => this.resolveUnderRoot(root, rel))
			.filter(Boolean) as string[];
		const envEntries = Object.entries(parsed.env ?? {})
			.map(([name, rel]) => {
				const value = this.resolveUnderRoot(root, rel);
				return value ? { name, value } : undefined;
			})
			.filter((e): e is { name: string; value: string } => Boolean(e));

		if (pathDirs.length === 0 && envEntries.length === 0) {
			this.logService.debug('Default dev-env path-entries.json has no entries', entriesUri.toString());
			return;
		}

		this.logService.info('Initializing default dev-env PATH/env', root.fsPath);
		try {
			await this.applyUserPathAndEnv(pathDirs, envEntries);
			this.logService.info('Default dev-env PATH/env initialized', {
				path: pathDirs,
				env: envEntries.map(e => e.name),
			});
		} catch (error) {
			this.logService.error('Error initializing default dev-env PATH/env', getErrorMessage(error));
		}
	}

	private resolveUnderRoot(root: URI, relativeOrAbsolute: string): string | undefined {
		const trimmed = relativeOrAbsolute.trim();
		if (!trimmed) {
			return undefined;
		}
		const absolute = isAbsolute(trimmed) ? trimmed : join(root.fsPath, trimmed);
		return absolute;
	}

	private getDevEnvRoot(): URI {
		return URI.file(join(this.getBootstrapRoot(), 'dev-env'));
	}

	private getPathEntriesLocation(): URI {
		return URI.file(join(this.getBootstrapRoot(), 'dev-env', 'path-entries.json'));
	}

	private getBootstrapRoot(): string {
		if (this.productService.win32VersionedUpdate) {
			// appRoot = ...\<version>\resources\app → bootstrap = ...\<version>\bootstrap
			return join(dirname(dirname(dirname(this.environmentService.appRoot))), 'bootstrap');
		}
		// appRoot = ...\resources\app → bootstrap = ...\bootstrap
		return join(dirname(dirname(this.environmentService.appRoot)), 'bootstrap');
	}

	/**
	 * Idempotently prepend directories to the user PATH and set user env vars via PowerShell
	 * (same approach as RemotePro windowsDevEnvInstaller.addUserPath).
	 */
	private async applyUserPathAndEnv(
		pathDirs: string[],
		envEntries: Array<{ name: string; value: string }>,
	): Promise<void> {
		const escapePs = (value: string) => value.replace(/'/g, "''");
		const pathArrayLiteral = pathDirs.map(d => `'${escapePs(d)}'`).join(',');
		const envStatements = envEntries.map(({ name, value }) => [
			`$name = '${escapePs(name)}'`,
			`$val = '${escapePs(value)}'`,
			`$cur = [Environment]::GetEnvironmentVariable($name, 'User')`,
			`if (-not [string]::Equals($cur, $val, [StringComparison]::OrdinalIgnoreCase)) {`,
			`  [Environment]::SetEnvironmentVariable($name, $val, 'User')`,
			`}`,
		].join('\n')).join('\n');

		const script = [
			`$ErrorActionPreference = 'Stop'`,
			`$dirs = @(${pathArrayLiteral})`,
			`if ($dirs.Count -gt 0) {`,
			`  $user = [Environment]::GetEnvironmentVariable('Path','User')`,
			`  if ($null -eq $user) { $user = '' }`,
			`  $parts = @($user -split ';' | Where-Object { $_ -and $_.Trim() -ne '' })`,
			`  foreach ($dir in $dirs) {`,
			`    $parts = @($parts | Where-Object { -not [string]::Equals($_, $dir, [StringComparison]::OrdinalIgnoreCase) })`,
			`  }`,
			`  $new = (@($dirs) + $parts) -join ';'`,
			`  [Environment]::SetEnvironmentVariable('Path', $new, 'User')`,
			`}`,
			envStatements,
			`Write-Output 'ok'`,
		].join('\n');

		const { stdout, stderr } = await execFileAsync(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
			{ windowsHide: true, timeout: 30_000, encoding: 'utf8' },
		);
		if (!String(stdout || '').includes('ok')) {
			throw new Error((stderr || stdout || 'failed to update user PATH/env').toString().trim());
		}
	}
}
