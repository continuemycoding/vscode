/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildChangesetUri, isChangesetUri, parseChangesetUri } from '../../common/changesetUri.js';

suite('changesetUri', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const sessionUri = 'copilot:/abc-123';

	test('buildChangesetUri appends the changeset segment', () => {
		assert.strictEqual(buildChangesetUri(sessionUri, 'session'), `${sessionUri}/changeset/session`);
	});

	test('buildChangesetUri rejects empty and slashed ids', () => {
		assert.throws(() => buildChangesetUri(sessionUri, ''));
		assert.throws(() => buildChangesetUri(sessionUri, 'with/slash'));
	});

	test('parseChangesetUri round-trips a built URI', () => {
		const uri = buildChangesetUri(sessionUri, 'session');
		assert.deepStrictEqual(parseChangesetUri(uri), { sessionUri, changesetId: 'session' });
	});

	test('parseChangesetUri returns undefined for non-changeset URIs', () => {
		assert.strictEqual(parseChangesetUri(sessionUri), undefined);
		assert.strictEqual(parseChangesetUri('agenthost:/root'), undefined);
		// Extra segments after the id are not v1 valid output and must be rejected.
		assert.strictEqual(parseChangesetUri(`${sessionUri}/changeset/foo/bar`), undefined);
	});

	test('isChangesetUri matches the parser semantics', () => {
		assert.strictEqual(isChangesetUri(buildChangesetUri(sessionUri, 'session')), true);
		assert.strictEqual(isChangesetUri(sessionUri), false);
	});
});
