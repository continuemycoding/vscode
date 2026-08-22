/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from '../common/path.js';
import { IProcessEnvironment } from '../common/platform.js';

export const BUNDLED_DEV_ENVIRONMENT_ROOT = 'VSCODE_BUNDLED_DEV_ENV_ROOT';
export const BUNDLED_DEV_ENVIRONMENT_MANAGED_ENV = 'VSCODE_BUNDLED_DEV_ENV_MANAGED_ENV';
export const BUNDLED_DEV_ENVIRONMENT_VALUES = 'VSCODE_BUNDLED_DEV_ENV_VALUES';

const MAX_MANIFEST_SIZE = 1024 * 1024;
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:/;
const CROSS_ROOT_ENVIRONMENT_VARIABLES = [
	'VSCODE_PORTABLE',
	'VSCODE_IPC_HOOK',
	'VSCODE_IPC_HOOK_CLI',
	'VSCODE_ENV_PREPEND',
	'VSCODE_ENV_REPLACE',
	'VSCODE_ENV_APPEND',
	'VSCODE_CLI',
	'VSCODE_PID',
] as const;
const RESERVED_ENVIRONMENT_VARIABLES = new Set([
	'PATH',
	'TEMP',
	'TMP',
	'TMPDIR',
	'__PROTO__',
	'CONSTRUCTOR',
	'PROTOTYPE',
]);

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject { readonly [key: string]: JsonValue }

export interface IBundledDevEnvironmentManifest {
	readonly path: readonly string[];
	readonly env: Readonly<Record<string, string>>;

	/** Paths are resolved relative to `<productRoot>/data/dev-env-state`. */
	readonly state: Readonly<Record<string, string>>;

	/** Literal environment values that are not filesystem paths. */
	readonly values: Readonly<Record<string, string>>;
}

export interface IBundledDevEnvironmentConfiguration {
	readonly productRoot: string;
	readonly dataRoot: string;
	readonly devEnvironmentRoot: string;
	readonly stateRoot: string;
	readonly pathEntries: readonly string[];
	readonly environment: Readonly<Record<string, string>>;
	readonly literalEnvironment: Readonly<Record<string, string>>;
	readonly devEnvironmentVariableNames: readonly string[];
	readonly stateEnvironmentVariableNames: readonly string[];
	readonly literalEnvironmentVariableNames: readonly string[];
	readonly managedEnvironmentVariableNames: readonly string[];
}

export function parseBundledDevEnvironmentManifest(raw: string): IBundledDevEnvironmentManifest {
	const parsed = JSON.parse(raw) as JsonValue;
	if (!isJsonObject(parsed)) {
		throw new Error('Bundled development environment manifest must be an object.');
	}
	for (const property of Object.keys(parsed)) {
		if (property !== 'path' && property !== 'env' && property !== 'state' && property !== 'values') {
			throw new Error(`Unknown bundled development environment manifest property: ${property}`);
		}
	}

	return {
		path: parseRelativePathArray(parsed.path, 'path'),
		env: parseRelativePathRecord(parsed.env, 'env'),
		state: parseRelativePathRecord(parsed.state, 'state'),
		values: parseLiteralRecord(parsed.values, 'values'),
	};
}

export function resolveBundledDevEnvironmentManifest(productRoot: string, manifest: IBundledDevEnvironmentManifest, windows: boolean): IBundledDevEnvironmentConfiguration {
	const pathModule = windows ? path.win32 : path.posix;
	if (!pathModule.isAbsolute(productRoot)) {
		throw new Error('Bundled development environment product root must be absolute.');
	}

	const normalizedProductRoot = pathModule.normalize(productRoot);
	const dataRoot = pathModule.join(normalizedProductRoot, 'data');
	const devEnvironmentRoot = pathModule.join(normalizedProductRoot, 'dev-env');
	const stateRoot = pathModule.join(dataRoot, 'dev-env-state');
	const pathEntries = distinctPaths(manifest.path.map(entry => resolveRelativePath(devEnvironmentRoot, entry, 'path', windows)), windows);
	const environment = resolveRelativePathRecord(devEnvironmentRoot, manifest.env, 'env', windows);
	const stateEnvironment = resolveRelativePathRecord(stateRoot, manifest.state, 'state', windows);
	const literalEnvironment = { ...manifest.values };
	const devEnvironmentVariableNames = Object.keys(environment);
	const stateEnvironmentVariableNames = Object.keys(stateEnvironment);
	const literalEnvironmentVariableNames = Object.keys(literalEnvironment);
	const managedEnvironmentVariableNames = distinctEnvironmentVariableNames([
		...devEnvironmentVariableNames,
		...stateEnvironmentVariableNames,
		...literalEnvironmentVariableNames,
	], windows);

	if (managedEnvironmentVariableNames.length !== devEnvironmentVariableNames.length + stateEnvironmentVariableNames.length + literalEnvironmentVariableNames.length) {
		throw new Error('Bundled development environment variable names must be unique.');
	}

	return {
		productRoot: normalizedProductRoot,
		dataRoot,
		devEnvironmentRoot,
		stateRoot,
		pathEntries,
		environment: { ...environment, ...stateEnvironment },
		literalEnvironment,
		devEnvironmentVariableNames,
		stateEnvironmentVariableNames,
		literalEnvironmentVariableNames,
		managedEnvironmentVariableNames,
	};
}

export function loadBundledDevEnvironmentConfiguration(productRoot: string, windows: boolean): IBundledDevEnvironmentConfiguration {
	const pathModule = windows ? path.win32 : path.posix;
	const normalizedProductRoot = pathModule.normalize(productRoot);
	const dataRoot = pathModule.join(normalizedProductRoot, 'data');
	const devEnvironmentRoot = pathModule.join(normalizedProductRoot, 'dev-env');
	const manifestPath = pathModule.join(devEnvironmentRoot, 'path-entries.json');

	const productRootRealPath = realDirectoryPath(normalizedProductRoot, 'product root');
	const dataRootRealPath = realDirectoryPath(dataRoot, 'data root');
	const devEnvironmentRootRealPath = realDirectoryPath(devEnvironmentRoot, 'development environment root');
	assertPathInside(dataRootRealPath, productRootRealPath, 'Bundled development environment data root escapes the product root.', windows);
	assertPathInside(devEnvironmentRootRealPath, productRootRealPath, 'Bundled development environment root escapes the product root.', windows);

	const manifestStat = fs.statSync(manifestPath);
	if (!manifestStat.isFile()) {
		throw new Error('Bundled development environment manifest must be a file.');
	}
	if (manifestStat.size > MAX_MANIFEST_SIZE) {
		throw new Error('Bundled development environment manifest is too large.');
	}
	assertPathInside(fs.realpathSync.native(manifestPath), devEnvironmentRootRealPath, 'Bundled development environment manifest escapes its root.', windows);

	const configuration = resolveBundledDevEnvironmentManifest(normalizedProductRoot, parseBundledDevEnvironmentManifest(fs.readFileSync(manifestPath, 'utf8')), windows);
	for (const entry of configuration.pathEntries) {
		const realEntry = realDirectoryPath(entry, 'PATH entry');
		assertPathInside(realEntry, devEnvironmentRootRealPath, 'Bundled development environment PATH entry escapes its root.', windows);
	}
	for (const name of configuration.devEnvironmentVariableNames) {
		const realEntry = realExistingPath(configuration.environment[name], `environment variable ${name}`);
		assertPathInside(realEntry, devEnvironmentRootRealPath, `Bundled development environment variable ${name} escapes its root.`, windows);
	}
	for (const name of configuration.stateEnvironmentVariableNames) {
		assertExistingAncestorInside(configuration.environment[name], dataRoot, dataRootRealPath, `Bundled development environment state variable ${name} escapes its root.`, windows);
	}

	return configuration;
}

export function createBundledDevEnvironmentEnvironment(environment: IProcessEnvironment, configuration: IBundledDevEnvironmentConfiguration | undefined, windows: boolean): IProcessEnvironment {
	const result = { ...environment };
	if (!configuration) {
		return result;
	}

	const inheritedRootValue = getEnvironmentVariable(result, BUNDLED_DEV_ENVIRONMENT_ROOT, windows);
	const inheritedRoot = inheritedRootValue ? normalizeAbsolutePath(inheritedRootValue, windows) : undefined;
	const sameRoot = inheritedRoot ? pathsEqual(inheritedRoot, configuration.productRoot, windows) : false;

	if (inheritedRoot && !sameRoot) {
		const inheritedManagedNames = parseManagedEnvironmentVariableNames(getEnvironmentVariable(result, BUNDLED_DEV_ENVIRONMENT_MANAGED_ENV, windows), windows);
		const inheritedDataRoot = joinPath(inheritedRoot, 'data', windows);
		const inheritedDevEnvironmentRoot = joinPath(inheritedRoot, 'dev-env', windows);
		for (const name of inheritedManagedNames) {
			const value = getEnvironmentVariable(result, name, windows);
			if (value && (pathIsEqualOrInside(value, inheritedDataRoot, windows) || pathIsEqualOrInside(value, inheritedDevEnvironmentRoot, windows) || !normalizeAbsolutePath(value, windows))) {
				deleteEnvironmentVariable(result, name, windows);
			}
		}
		for (const name of CROSS_ROOT_ENVIRONMENT_VARIABLES) {
			deleteEnvironmentVariable(result, name, windows);
		}
		for (const name of ['TEMP', 'TMP']) {
			const value = getEnvironmentVariable(result, name, windows);
			if (value && pathIsEqualOrInside(value, joinPath(inheritedDataRoot, 'tmp', windows), windows)) {
				deleteEnvironmentVariable(result, name, windows);
			}
		}
	}

	const inheritedDevEnvironmentRoot = inheritedRoot && !sameRoot ? joinPath(inheritedRoot, 'dev-env', windows) : undefined;
	const pathValue = getEnvironmentVariable(result, 'PATH', windows);
	const delimiter = windows ? ';' : ':';
	const retainedPathEntries = pathValue === undefined ? [] : pathValue.split(delimiter).filter(entry => {
		return !pathSegmentIsEqualOrInside(entry, configuration.devEnvironmentRoot, windows)
			&& (!inheritedDevEnvironmentRoot || !pathSegmentIsEqualOrInside(entry, inheritedDevEnvironmentRoot, windows));
	});
	if (configuration.pathEntries.length > 0 || pathValue !== undefined) {
		setEnvironmentVariable(result, 'PATH', [...configuration.pathEntries, ...retainedPathEntries].join(delimiter), windows);
	}

	for (const [name, value] of Object.entries(configuration.environment)) {
		setEnvironmentVariable(result, name, value, windows);
	}
	for (const [name, value] of Object.entries(configuration.literalEnvironment)) {
		setEnvironmentVariable(result, name, value, windows);
	}
	setEnvironmentVariable(result, 'VSCODE_PORTABLE', configuration.dataRoot, windows);
	setEnvironmentVariable(result, BUNDLED_DEV_ENVIRONMENT_ROOT, configuration.productRoot, windows);
	setEnvironmentVariable(result, BUNDLED_DEV_ENVIRONMENT_MANAGED_ENV, JSON.stringify(configuration.managedEnvironmentVariableNames), windows);
	setEnvironmentVariable(result, BUNDLED_DEV_ENVIRONMENT_VALUES, JSON.stringify({
		env: { ...configuration.environment, ...configuration.literalEnvironment },
		path: [...configuration.pathEntries],
	}), windows);

	return result;
}

function parseRelativePathArray(value: JsonValue | undefined, property: string): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new Error(`Bundled development environment ${property} must be an array.`);
	}

	return value.map(entry => {
		if (typeof entry !== 'string') {
			throw new Error(`Bundled development environment ${property} entries must be strings.`);
		}
		assertRelativePath(entry, property);
		return entry;
	});
}

function parseRelativePathRecord(value: JsonValue | undefined, property: string): Record<string, string> {
	if (value === undefined) {
		return {};
	}
	if (!isJsonObject(value)) {
		throw new Error(`Bundled development environment ${property} must be an object.`);
	}

	const result: Record<string, string> = {};
	for (const [name, entry] of Object.entries(value)) {
		assertEnvironmentVariableName(name);
		if (typeof entry !== 'string') {
			throw new Error(`Bundled development environment ${property}.${name} must be a string.`);
		}
		assertRelativePath(entry, `${property}.${name}`);
		result[name] = entry;
	}
	return result;
}

function parseLiteralRecord(value: JsonValue | undefined, property: string): Record<string, string> {
	if (value === undefined) {
		return {};
	}
	if (!isJsonObject(value)) {
		throw new Error(`Bundled development environment ${property} must be an object.`);
	}

	const result: Record<string, string> = {};
	for (const [name, entry] of Object.entries(value)) {
		assertEnvironmentVariableName(name);
		if (typeof entry !== 'string') {
			throw new Error(`Bundled development environment ${property}.${name} must be a string.`);
		}
		if (!entry || /^\s+$/.test(entry)) {
			throw new Error(`Bundled development environment ${property}.${name} contains an empty value.`);
		}
		if (/^\s|\s$/.test(entry)) {
			throw new Error(`Bundled development environment ${property}.${name} cannot start or end with whitespace.`);
		}
		if (entry.includes('\0') || entry.includes('\r') || entry.includes('\n') || entry.length > 4096) {
			throw new Error(`Bundled development environment ${property}.${name} contains an invalid value.`);
		}
		result[name] = entry;
	}
	return result;
}

function assertRelativePath(value: string, property: string): void {
	if (!value || /^\s+$/.test(value)) {
		throw new Error(`Bundled development environment ${property} contains an empty path.`);
	}
	if (/^\s|\s$/.test(value)) {
		throw new Error(`Bundled development environment ${property} paths cannot start or end with whitespace.`);
	}
	if (value.includes('\0') || value.includes(';')) {
		throw new Error(`Bundled development environment ${property} contains an invalid path.`);
	}
	if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || WINDOWS_DRIVE_PATH.test(value)) {
		throw new Error(`Bundled development environment ${property} paths must be relative.`);
	}
	if (value.split(/[\\/]+/).includes('..')) {
		throw new Error(`Bundled development environment ${property} paths cannot contain parent traversal.`);
	}
}

function assertEnvironmentVariableName(name: string): void {
	const upperName = name.toUpperCase();
	if (!ENVIRONMENT_VARIABLE_NAME.test(name)
		|| RESERVED_ENVIRONMENT_VARIABLES.has(upperName)
		|| upperName.startsWith('VSCODE_')
		|| upperName.startsWith('ELECTRON_')) {
		throw new Error(`Invalid bundled development environment variable name: ${name}`);
	}
}

function resolveRelativePath(root: string, entry: string, property: string, windows: boolean): string {
	assertRelativePath(entry, property);
	const pathModule = windows ? path.win32 : path.posix;
	const resolved = pathModule.resolve(root, entry);
	assertPathInside(resolved, root, `Bundled development environment ${property} path escapes its root.`, windows);
	return resolved;
}

function resolveRelativePathRecord(root: string, entries: Readonly<Record<string, string>>, property: string, windows: boolean): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, entry] of Object.entries(entries)) {
		assertEnvironmentVariableName(name);
		result[name] = resolveRelativePath(root, entry, `${property}.${name}`, windows);
	}
	return result;
}

function distinctPaths(entries: readonly string[], windows: boolean): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const key = pathComparisonKey(entry, windows);
		if (!seen.has(key)) {
			seen.add(key);
			result.push(entry);
		}
	}
	return result;
}

function distinctEnvironmentVariableNames(names: readonly string[], windows: boolean): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const key = windows ? name.toUpperCase() : name;
		if (!seen.has(key)) {
			seen.add(key);
			result.push(name);
		}
	}
	return result;
}

function normalizeAbsolutePath(value: string, windows: boolean): string | undefined {
	const pathModule = windows ? path.win32 : path.posix;
	if (!value || /^\s|\s$/.test(value) || value.includes('\0') || !pathModule.isAbsolute(value)) {
		return undefined;
	}
	return pathModule.normalize(value);
}

function joinPath(root: string, entry: string, windows: boolean): string {
	return (windows ? path.win32 : path.posix).join(root, entry);
}

function pathsEqual(first: string, second: string, windows: boolean): boolean {
	return pathComparisonKey(first, windows) === pathComparisonKey(second, windows);
}

function pathIsEqualOrInside(candidate: string, root: string, windows: boolean): boolean {
	const normalizedCandidate = normalizeAbsolutePath(candidate, windows);
	const normalizedRoot = normalizeAbsolutePath(root, windows);
	if (!normalizedCandidate || !normalizedRoot) {
		return false;
	}
	const pathModule = windows ? path.win32 : path.posix;
	const relative = pathModule.relative(normalizedRoot, normalizedCandidate);
	return relative === '' || (!pathModule.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${pathModule.sep}`));
}

function pathSegmentIsEqualOrInside(segment: string, root: string, windows: boolean): boolean {
	const unquoted = segment.length >= 2 && segment.startsWith('"') && segment.endsWith('"') ? segment.slice(1, -1) : segment;
	return pathIsEqualOrInside(unquoted, root, windows);
}

function pathComparisonKey(value: string, windows: boolean): string {
	const pathModule = windows ? path.win32 : path.posix;
	const normalized = pathModule.normalize(value);
	const root = pathModule.parse(normalized).root;
	const withoutTrailingSeparators = normalized.length > root.length ? normalized.replace(/[\\/]+$/, '') : normalized;
	return windows ? withoutTrailingSeparators.toLowerCase() : withoutTrailingSeparators;
}

function assertPathInside(candidate: string, root: string, message: string, windows: boolean): void {
	if (!pathIsEqualOrInside(candidate, root, windows)) {
		throw new Error(message);
	}
}

function realDirectoryPath(value: string, description: string): string {
	const stat = fs.statSync(value);
	if (!stat.isDirectory()) {
		throw new Error(`Bundled development environment ${description} must be a directory.`);
	}
	return fs.realpathSync.native(value);
}

function realExistingPath(value: string, description: string): string {
	fs.statSync(value);
	try {
		return fs.realpathSync.native(value);
	} catch (error) {
		throw new Error(`Cannot resolve bundled development environment ${description}: ${error}`);
	}
}

function assertExistingAncestorInside(candidate: string, lexicalRoot: string, realRoot: string, message: string, windows: boolean): void {
	const pathModule = windows ? path.win32 : path.posix;
	let existingPath = candidate;
	while (!fs.existsSync(existingPath)) {
		const parent = pathModule.dirname(existingPath);
		if (parent === existingPath || !pathIsEqualOrInside(parent, lexicalRoot, windows)) {
			throw new Error(message);
		}
		existingPath = parent;
	}
	const stat = fs.statSync(existingPath);
	if (!stat.isDirectory()) {
		throw new Error(message);
	}
	assertPathInside(fs.realpathSync.native(existingPath), realRoot, message, windows);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseManagedEnvironmentVariableNames(raw: string | undefined, windows: boolean): string[] {
	if (!raw) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as JsonValue;
		if (!Array.isArray(parsed)) {
			return [];
		}
		const names: string[] = [];
		for (const name of parsed) {
			if (typeof name !== 'string') {
				return [];
			}
			try {
				assertEnvironmentVariableName(name);
			} catch {
				return [];
			}
			names.push(name);
		}
		return distinctEnvironmentVariableNames(names, windows);
	} catch {
		return [];
	}
}

function getEnvironmentVariable(environment: IProcessEnvironment, name: string, windows: boolean): string | undefined {
	if (!windows) {
		return environment[name];
	}
	const key = Object.keys(environment).find(key => key.toUpperCase() === name.toUpperCase());
	return key ? environment[key] : undefined;
}

function setEnvironmentVariable(environment: IProcessEnvironment, name: string, value: string, windows: boolean): void {
	deleteEnvironmentVariable(environment, name, windows);
	environment[name] = value;
}

function deleteEnvironmentVariable(environment: IProcessEnvironment, name: string, windows: boolean): void {
	if (!windows) {
		delete environment[name];
		return;
	}
	for (const key of Object.keys(environment)) {
		if (key.toUpperCase() === name.toUpperCase()) {
			delete environment[key];
		}
	}
}
