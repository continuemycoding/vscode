#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Bake Simplified Chinese core UI strings into a packaged Code OSS tree.
 * Downloads MS-CEINTL.vscode-language-pack-zh-hans from the Marketplace at build time,
 * maps translations onto nls.keys.json / nls.messages.json (same algorithm as
 * src/vs/base/node/nls.ts), and overwrites resources/app/nls.messages.json.
 *
 * Usage:
 *   node .github/scripts/bake-zh-hans-nls.mjs --app-root <VSCode-win32-x64>
 *   node .github/scripts/bake-zh-hans-nls.mjs --app-root <dir> --vsix <file.vsix>
 *   node .github/scripts/bake-zh-hans-nls.mjs --app-root <dir> --product-version 1.132.0
 *--------------------------------------------------------------------------------------------*/

import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLISHER = 'MS-CEINTL';
const EXTENSION_NAME = 'vscode-language-pack-zh-hans';
const EXTENSION_ID = `${PUBLISHER}.${EXTENSION_NAME}`;
const GALLERY_SERVICE = 'https://marketplace.visualstudio.com/_apis/public/gallery';
const MARKET_HEADERS = {
	'User-Agent': 'VSCode Build',
	'X-Market-Client-Id': 'VSCode Build',
	'X-Market-User-Id': '291C1CD0-051A-4123-9B4B-30D60EF52EE2',
};

function parseArgs(argv) {
	const out = { appRoot: undefined, vsix: undefined, productVersion: undefined };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = argv[i + 1];
		if (a === '--app-root' && next) {
			out.appRoot = next;
			i++;
		} else if (a === '--vsix' && next) {
			out.vsix = next;
			i++;
		} else if (a === '--product-version' && next) {
			out.productVersion = next;
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
	console.log(`Bake zh-hans into packaged nls.messages.json

Usage:
  node bake-zh-hans-nls.mjs --app-root <VSCode-win32-x64> [--vsix <file>] [--product-version <ver>]
`);
}

async function readProductVersion(repoRoot, override) {
	if (override) {
		return override;
	}
	const pkgPath = join(repoRoot, 'package.json');
	const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
	if (typeof pkg.version !== 'string' || !pkg.version) {
		throw new Error(`Unable to read version from ${pkgPath}`);
	}
	return pkg.version;
}

function parseSemverParts(version) {
	const m = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!m) {
		return undefined;
	}
	return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function versionMeetsCaretEngine(productVersion, engineRange) {
	// Language packs typically use "^1.N.0". We only need a practical check for bake.
	const range = String(engineRange || '').trim();
	const caret = range.match(/^\^\s*(\d+)\.(\d+)\.(\d+)/);
	const product = parseSemverParts(productVersion);
	if (!caret || !product) {
		return true; // unknown shape → do not block bake
	}
	const engMajor = Number(caret[1]);
	const engMinor = Number(caret[2]);
	if (product.major !== engMajor) {
		return false;
	}
	// Allow product minor >= engine minor within the same major (newer Code OSS, slightly older pack).
	return product.minor >= engMinor;
}

async function queryLanguagePackVersions() {
	const res = await fetch(`${GALLERY_SERVICE}/extensionquery`, {
		method: 'POST',
		headers: {
			...MARKET_HEADERS,
			'Content-Type': 'application/json',
			Accept: 'application/json;api-version=7.1-preview.1',
		},
		body: JSON.stringify({
			filters: [{
				criteria: [{ filterType: 7, value: EXTENSION_ID }],
				pageNumber: 1,
				pageSize: 50,
				sortBy: 0,
				sortOrder: 0,
			}],
			flags: 1, // IncludeVersions
		}),
	});
	if (!res.ok) {
		throw new Error(`Marketplace extensionquery failed: HTTP ${res.status}`);
	}
	const data = await res.json();
	const versions = data?.results?.[0]?.extensions?.[0]?.versions;
	if (!Array.isArray(versions) || versions.length === 0) {
		throw new Error(`No versions returned for ${EXTENSION_ID}`);
	}
	return versions.map(v => v.version).filter(Boolean);
}

function pickLanguagePackVersion(versions, productVersion) {
	const product = parseSemverParts(productVersion);
	if (product) {
		const prefix = `${product.major}.${product.minor}.`;
		const sameMinor = versions.filter(v => v.startsWith(prefix));
		if (sameMinor.length) {
			return sameMinor[0];
		}
	}
	return versions[0];
}

async function downloadVsix(version, destPath) {
	const url = `${GALLERY_SERVICE}/publishers/${PUBLISHER}/vsextensions/${EXTENSION_NAME}/${version}/vspackage`;
	console.log(`Downloading ${EXTENSION_ID}@${version}`);
	console.log(`  ${url}`);

	const res = await fetch(url, { headers: MARKET_HEADERS, redirect: 'follow' });
	if (!res.ok) {
		throw new Error(`Failed to download language pack: HTTP ${res.status}`);
	}

	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length < 100) {
		throw new Error(`Downloaded language pack is empty (${buf.length} bytes)`);
	}

	// Marketplace sometimes returns gzip-wrapped VSIX (1f 8b), otherwise raw ZIP (PK).
	const vsixBuf = (buf[0] === 0x1f && buf[1] === 0x8b) ? gunzipSync(buf) : buf;
	await fs.writeFile(destPath, vsixBuf);

	const st = await fs.stat(destPath);
	console.log(`Downloaded VSIX (${st.size} bytes)`);
}

async function extractVsix(vsixPath, extractDir) {
	await fs.rm(extractDir, { recursive: true, force: true });
	await fs.mkdir(extractDir, { recursive: true });
	// Windows 10+ / GHA images ship bsdtar which extracts zip/vsix.
	execFileSync('tar', ['-xf', vsixPath, '-C', extractDir], { stdio: 'inherit' });
}

async function resolveAppNlsPaths(appRoot) {
	const candidates = [
		join(appRoot, 'resources', 'app'),
		join(appRoot, 'resources', 'app', 'out'),
		appRoot,
	];
	for (const dir of candidates) {
		const keys = join(dir, 'nls.keys.json');
		const messages = join(dir, 'nls.messages.json');
		try {
			await fs.access(keys);
			await fs.access(messages);
			return { nlsDir: dir, keysPath: keys, messagesPath: messages };
		} catch {
			// try next
		}
	}
	throw new Error(`Could not find nls.keys.json / nls.messages.json under ${appRoot}`);
}

/**
 * Same mapping as src/vs/base/node/nls.ts resolveNLSConfiguration.
 * @param {Array<[string, string[]]>} nlsDefaultKeys
 * @param {string[]} nlsDefaultMessages
 * @param {{ contents: Record<string, Record<string, string>> }} nlsPackdata
 */
function bakeMessages(nlsDefaultKeys, nlsDefaultMessages, nlsPackdata) {
	const nlsResult = [];
	let nlsIndex = 0;
	let translated = 0;
	let fallback = 0;

	for (const [moduleId, nlsKeys] of nlsDefaultKeys) {
		const moduleTranslations = nlsPackdata.contents?.[moduleId];
		for (const nlsKey of nlsKeys) {
			const value = moduleTranslations?.[nlsKey];
			if (typeof value === 'string' && value.length) {
				nlsResult.push(value);
				translated++;
			} else {
				nlsResult.push(nlsDefaultMessages[nlsIndex]);
				fallback++;
			}
			nlsIndex++;
		}
	}

	if (nlsResult.length !== nlsDefaultMessages.length) {
		throw new Error(`NLS length mismatch: baked ${nlsResult.length}, expected ${nlsDefaultMessages.length}`);
	}

	return { messages: nlsResult, translated, fallback };
}

function looksChinese(sample) {
	return /[\u4e00-\u9fff]/.test(sample);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printHelp();
		return;
	}
	if (!args.appRoot) {
		printHelp();
		throw new Error('--app-root is required');
	}

	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const repoRoot = join(scriptDir, '..', '..');
	const productVersion = await readProductVersion(repoRoot, args.productVersion);
	const appRoot = await fs.realpath(args.appRoot);
	const { keysPath, messagesPath } = await resolveAppNlsPaths(appRoot);

	console.log(`Product version: ${productVersion}`);
	console.log(`App root: ${appRoot}`);
	console.log(`NLS keys: ${keysPath}`);
	console.log(`NLS messages: ${messagesPath}`);

	const workDir = join(tmpdir(), `bake-zh-hans-nls-${process.pid}`);
	await fs.mkdir(workDir, { recursive: true });
	const vsixPath = args.vsix ? await fs.realpath(args.vsix) : join(workDir, `${EXTENSION_ID}.vsix`);
	const extractDir = join(workDir, 'extract');

	try {
		let packVersion = 'local';
		if (!args.vsix) {
			const versions = await queryLanguagePackVersions();
			packVersion = pickLanguagePackVersion(versions, productVersion);
			await downloadVsix(packVersion, vsixPath);
		} else {
			console.log(`Using local VSIX: ${vsixPath}`);
		}

		await extractVsix(vsixPath, extractDir);

		const packJsonPath = join(extractDir, 'extension', 'package.json');
		const mainI18nPath = join(extractDir, 'extension', 'translations', 'main.i18n.json');
		const packJson = JSON.parse(await fs.readFile(packJsonPath, 'utf8'));
		const engine = packJson?.engines?.vscode;
		console.log(`Language pack ${packJson.name}@${packJson.version} engines.vscode=${engine ?? '(none)'}`);

		if (engine && !versionMeetsCaretEngine(productVersion, engine)) {
			console.warn(`Warning: product ${productVersion} does not satisfy engines.vscode ${engine}; baking anyway (missing keys fall back to English).`);
		}

		await fs.access(mainI18nPath);

		const [nlsDefaultKeys, nlsDefaultMessages, nlsPackdata] = await Promise.all([
			fs.readFile(keysPath, 'utf8').then(JSON.parse),
			fs.readFile(messagesPath, 'utf8').then(JSON.parse),
			fs.readFile(mainI18nPath, 'utf8').then(JSON.parse),
		]);

		if (!Array.isArray(nlsDefaultKeys) || !Array.isArray(nlsDefaultMessages)) {
			throw new Error('Invalid nls.keys.json / nls.messages.json shape');
		}
		if (!nlsPackdata?.contents || typeof nlsPackdata.contents !== 'object') {
			throw new Error('Invalid main.i18n.json: missing contents');
		}

		const { messages, translated, fallback } = bakeMessages(nlsDefaultKeys, nlsDefaultMessages, nlsPackdata);
		const sample = messages.find(m => looksChinese(m)) ?? '';
		if (!sample) {
			throw new Error('Bake produced no Chinese strings; refusing to overwrite nls.messages.json');
		}

		await fs.writeFile(messagesPath, JSON.stringify(messages), 'utf8');
		console.log(`Wrote Chinese nls.messages.json (${messages.length} strings; translated=${translated}, fallback=${fallback})`);
		console.log(`Sample: ${sample.slice(0, 80)}`);
		console.log(`Language pack version used: ${packJson.version || packVersion}`);
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
