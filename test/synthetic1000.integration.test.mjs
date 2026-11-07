import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchDedicatedBrowser } from '../src/browser.mjs';
import { appendJournal, isTerminalResult, latestByIdentity, readJournal, summarizeJournal } from '../src/journal.mjs';
import { rewriteForMock, startMockServer } from '../src/mock-server.mjs';
import { loadNormalized, normalizeInputs } from '../src/normalize.mjs';

const TARGET_LIST = 'GMAPS-MIGRATION-SYNTHETIC';
const EXISTING_LIST = '元から保存済み';

async function processPending({ records, journalFile, profilePath, server, stopAfter }) {
  const latest = latestByIdentity(await readJournal(journalFile));
  const pending = records.filter((record) => !isTerminalResult(latest.get(record.identity))).slice(0, stopAfter);
  const browser = await launchDedicatedBrowser({ profilePath, headless: true });
  try {
    for (const record of pending) {
      const blocker = await browser.navigate(rewriteForMock(record.navigationUrl, server.baseUrl, record.identity));
      assert.equal(blocker.blocked, false);
      await browser.verifyAccount('synthetic@example.test');
      assert.equal((await browser.verifyPlaceIdentity(record, { mock: true })).verified, true);
      const result = await browser.saveToList(TARGET_LIST);
      assert.ok(['saved_verified', 'already_saved_verified'].includes(result.status));
      const pendingStatus = result.status === 'saved_verified' ? 'saved_pending_revisit' : 'already_saved_pending_revisit';
      await appendJournal(journalFile, {
        type: 'result',
        identity: record.identity,
        status: pendingStatus,
        verified: false,
        baselineCheckedLists: result.baselineCheckedLists ?? [],
        baselineCheckedRows: result.baselineCheckedRows ?? []
      });
      await browser.navigate(rewriteForMock(record.navigationUrl, server.baseUrl, record.identity));
      await browser.verifyAccount('synthetic@example.test');
      assert.equal((await browser.verifyPlaceIdentity(record, { mock: true })).verified, true);
      const postState = await browser.verifySaved(TARGET_LIST, result.baselineCheckedRows ?? result.baselineCheckedLists ?? [], { requireCompleteCoverage: true });
      assert.equal(postState.verified, true);
      await appendJournal(journalFile, {
        type: 'result',
        identity: record.identity,
        status: result.status,
        verified: true,
        verification: 'separate_navigation',
        baselineCheckedLists: result.baselineCheckedLists ?? [],
        baselineCheckedRows: result.baselineCheckedRows ?? [],
        postState: {
          targetChecked: true,
          coverage: postState.coverage,
          checkedLists: postState.checkedLists,
          checkedRows: postState.checkedRows
        }
      });
    }
    assert.deepEqual(browser.networkAudit(), { mode: 'localhost_only', externalAttempts: [], blockedExternalRequests: [] });
  } finally {
    await browser.close();
  }
}

test('synthetic 1000: normalize, deduplicate, interrupt/resume, preserve memberships, and revisit all actionable spots', { timeout: 300000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gmaps-synthetic-1000-'));
  const normalized = path.join(dir, 'normalized.jsonl');
  const normalizeReport = path.join(dir, 'normalize-report.json');
  const journalFile = path.join(dir, 'journal.jsonl');
  const profilePath = path.join(dir, 'dedicated-profile');
  const source = path.resolve('samples', 'synthetic-1000.csv');

  const report = await normalizeInputs({ input: source, output: normalized, report: normalizeReport });
  assert.deepEqual(
    { input: report.inputRecords, actionable: report.actionableUnique, duplicates: report.duplicatesSkipped, review: report.manualReview },
    { input: 1000, actionable: 970, duplicates: 10, review: 20 }
  );
  const records = await loadNormalized(normalized);

  const preseedByPlace = {};
  for (let index = 0; index < records.length; index += 1) {
    const placeId = records[index].identity.slice('place_id:'.length);
    const lists = [];
    if (index % 97 === 0) lists.push(TARGET_LIST);
    if (index % 10 === 0) lists.push(EXISTING_LIST);
    if (lists.length) preseedByPlace[placeId] = lists;
  }
  const server = await startMockServer({
    account: 'synthetic@example.test',
    listNames: [TARGET_LIST, EXISTING_LIST, '別のリスト'],
    preseedByPlace
  });
  try {
    // Simulate an abrupt boundary at 400 completed identities, then relaunch
    // the same dedicated profile and resume only the remainder.
    await processPending({ records, journalFile, profilePath, server, stopAfter: 400 });
    assert.equal(summarizeJournal(records, await readJournal(journalFile)).unprocessed, 570);
    await processPending({ records, journalFile, profilePath, server, stopAfter: 1000 });

    const firstPass = summarizeJournal(records, await readJournal(journalFile));
    assert.equal(firstPass.savedVerified, 960);
    assert.equal(firstPass.alreadySavedVerified, 10);
    assert.equal(firstPass.failed, 0);
    assert.equal(firstPass.unprocessed, 0);

    // A new browser process revisits every actionable identity. The target
    // must remain checked and every membership seen before the add must remain.
    const latest = latestByIdentity(await readJournal(journalFile));
    const verifier = await launchDedicatedBrowser({ profilePath, headless: true });
    try {
      for (const record of records) {
        await verifier.navigate(rewriteForMock(record.navigationUrl, server.baseUrl, record.identity));
        assert.equal((await verifier.verifyPlaceIdentity(record, { mock: true })).verified, true);
        const baseline = latest.get(record.identity)?.baselineCheckedLists ?? [];
        const verified = await verifier.verifySaved(TARGET_LIST, baseline);
        assert.equal(verified.verified, true);
        for (const list of baseline) assert.ok(verified.checkedLists.includes(list));
      }
      assert.deepEqual(verifier.networkAudit(), { mode: 'localhost_only', externalAttempts: [], blockedExternalRequests: [] });
    } finally {
      await verifier.close();
    }
  } finally {
    await server.close();
  }
});
