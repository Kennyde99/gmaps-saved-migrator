import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPilotApproval, dryRunPlan, planHash, runMigration, verifyMigration } from '../src/migrator.mjs';
import { appendBoundResult, initializeBoundJournal } from '../src/resume.mjs';
import { startMockServer } from '../src/mock-server.mjs';

async function seedScope(dir, records) {
  const bound = await initializeBoundJournal({ journalFile: path.join(dir, 'journal.jsonl'), stateFile: path.join(dir, 'binding.json'), binding: { planHash: planHash(records), verifiedAccount: 'pilot@example.test', targetList: 'GMAPS-MIGRATION-TEST' } });
  return bound.scope;
}

const records = Array.from({ length: 6 }, (_, index) => {
  const id = `FLOW_${index + 1}`;
  return {
    schemaVersion: 1,
    actionable: true,
    identity: `place_id:${id}`,
    identityKind: 'place_id',
    navigationUrl: `https://www.google.com/maps/search/?api=1&query=X&query_place_id=${id}`,
    title: id
  };
});

test('pilot, post-verification, approval, bounded batch, and resume', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gmaps-flow-'));
  const profilePath = path.join(dir, 'dedicated-profile');
  const journalFile = path.join(dir, 'journal.jsonl');
  const stateFile = path.join(dir, 'binding.json');
  const reportFile = path.join(dir, 'run-report.json');
  const finalReportFile = path.join(dir, 'final-run-report.json');
  const verificationFile = path.join(dir, 'verification.json');
  const approvalFile = path.join(dir, 'approval.json');
  const server = await startMockServer({
    listNames: ['GMAPS-MIGRATION-TEST', '元から保存済み'],
    preseedByPlace: { FLOW_1: ['GMAPS-MIGRATION-TEST'], FLOW_2: ['GMAPS-MIGRATION-TEST'] }
  });
  try {
    const base = {
      records,
      journalFile,
      stateFile,
      reportFile,
      profilePath,
      expectedAccount: 'pilot@example.test',
      confirmAccount: 'pilot@example.test',
      targetList: 'GMAPS-MIGRATION-TEST',
      dedicatedListConfirm: 'GMAPS-MIGRATION-TEST',
      mockBaseUrl: server.baseUrl,
      headless: true,
      delayMs: 0,
      jitterMs: 0
    };
    const pilot = await runMigration({ ...base, pilot: 4 });
    assert.equal(pilot.phase, 'pilot');
    assert.equal(pilot.processedThisRun, 4);
    assert.equal(pilot.savedVerified, 2);
    assert.equal(pilot.alreadySavedVerified, 2);
    assert.equal(pilot.remaining, 2);
    await assert.rejects(() => runMigration({ ...base, reportFile: path.join(dir, 'unapproved-report.json'), pilot: 4 }), /approve-pilot/);

    const verification = await verifyMigration({
      records,
      journalFile,
      stateFile,
      output: verificationFile,
      profilePath,
      expectedAccount: 'pilot@example.test',
      confirmAccount: 'pilot@example.test',
      targetList: 'GMAPS-MIGRATION-TEST',
      dedicatedListConfirm: 'GMAPS-MIGRATION-TEST',
      mockBaseUrl: server.baseUrl,
      headless: true,
      delayMs: 0,
      jitterMs: 0
    });
    assert.equal(verification.checked, 4);
    assert.equal(verification.notSaved, 0);

    await createPilotApproval({
      records,
      journalFile,
      stateFile,
      verificationFile,
      output: approvalFile,
      expectedAccount: 'pilot@example.test',
      targetList: 'GMAPS-MIGRATION-TEST',
      typedConfirm: 'pilot@example.test|GMAPS-MIGRATION-TEST|4'
    });

    const final = await runMigration({ ...base, reportFile: finalReportFile, approvalFile, batchSize: 2 });
    assert.equal(final.phase, 'approved_batch');
    assert.equal(final.processedThisRun, 2);
    assert.equal(final.savedVerified, 4);
    assert.equal(final.alreadySavedVerified, 2);
    assert.equal(final.remaining, 0);
    const dry = await dryRunPlan(records, journalFile, base);
    assert.equal(dry.remaining, 0);
    assert.equal(dry.accounted, 6);
  } finally {
    await server.close();
  }
});

test('a partial pilot retries only failed or pending-revisit identities and never advances to a fresh spot', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gmaps-pilot-retry-'));
  const scope = await seedScope(dir, records.slice(0, 4));
  const journalFile = path.join(dir, 'journal.jsonl');
  await appendBoundResult(journalFile, scope, {
    type: 'result',
    identity: records[0].identity,
    status: 'saved_verified',
    verified: true,
    verification: 'separate_navigation',
    postState: { targetChecked: true, coverage: 'complete' }
  });
  await appendBoundResult(journalFile, scope, { type: 'result', identity: records[1].identity, status: 'saved_pending_revisit', verified: false });
  await appendBoundResult(journalFile, scope, { type: 'result', identity: records[2].identity, status: 'failed', reason: 'synthetic_stop' });
  const server = await startMockServer({
    listNames: ['GMAPS-MIGRATION-TEST', '元から保存済み'],
    preseedByPlace: { FLOW_2: ['GMAPS-MIGRATION-TEST'] }
  });
  try {
    const report = await runMigration({
      records: records.slice(0, 4),
      journalFile,
      stateFile: path.join(dir, 'binding.json'),
      reportFile: path.join(dir, 'retry-report.json'),
      profilePath: path.join(dir, 'dedicated-profile'),
      expectedAccount: 'pilot@example.test',
      confirmAccount: 'pilot@example.test',
      targetList: 'GMAPS-MIGRATION-TEST',
      dedicatedListConfirm: 'GMAPS-MIGRATION-TEST',
      mockBaseUrl: server.baseUrl,
      headless: true,
      pilot: 4,
      delayMs: 0,
      jitterMs: 0
    });
    assert.equal(report.phase, 'pilot_retry');
    assert.equal(report.processedThisRun, 2);
    assert.equal(report.savedVerified, 3);
    assert.equal(report.alreadySavedVerified, 0);
    assert.equal(report.unprocessed, 1);
  } finally {
    await server.close();
  }
});

test('resume stops before any click when a persisted baseline membership is missing', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gmaps-resume-baseline-'));
  const scope = await seedScope(dir, records.slice(0, 1));
  const journalFile = path.join(dir, 'journal.jsonl');
  await appendBoundResult(journalFile, scope, {
    type: 'result',
    identity: records[0].identity,
    status: 'saved_pending_revisit',
    verified: false,
    baselineCheckedLists: ['EXISTING-LIST']
  });
  // A later failure must not erase the baseline captured by the earlier
  // pending event. This reproduces pending -> revisit failure -> retry.
  await appendBoundResult(journalFile, scope, {
    type: 'result',
    identity: records[0].identity,
    status: 'failed',
    reason: 'synthetic_revisit_failure'
  });
  const server = await startMockServer({
    listNames: ['GMAPS-MIGRATION-TEST', 'EXISTING-LIST'],
    preseedByPlace: { FLOW_1: ['GMAPS-MIGRATION-TEST'] }
  });
  try {
    const report = await runMigration({
      records: records.slice(0, 1),
      journalFile,
      stateFile: path.join(dir, 'binding.json'),
      reportFile: path.join(dir, 'report.json'),
      profilePath: path.join(dir, 'dedicated-profile'),
      expectedAccount: 'pilot@example.test',
      confirmAccount: 'pilot@example.test',
      targetList: 'GMAPS-MIGRATION-TEST',
      dedicatedListConfirm: 'GMAPS-MIGRATION-TEST',
      mockBaseUrl: server.baseUrl,
      headless: true,
      pilot: 1,
      delayMs: 0,
      jitterMs: 0
    });
    assert.match(report.stopReason, /existing_list_membership_lost_before_resume/);
    assert.equal(report.savedVerified, 0);
    assert.equal(report.alreadySavedVerified, 0);
    assert.equal(report.failed, 1);
  } finally {
    await server.close();
  }
});

test('post-run verification reuses the journal baseline and stops if another list membership disappeared', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gmaps-verify-baseline-'));
  const scope = await seedScope(dir, records.slice(0, 1));
  const journalFile = path.join(dir, 'journal.jsonl');
  await appendBoundResult(journalFile, scope, {
    type: 'result',
    identity: records[0].identity,
    status: 'saved_verified',
    verified: true,
    verification: 'separate_navigation',
    baselineCheckedLists: ['EXISTING-LIST'],
    postState: {
      targetChecked: true,
      coverage: 'complete',
      checkedLists: ['GMAPS-MIGRATION-TEST', 'EXISTING-LIST']
    }
  });
  const server = await startMockServer({
    listNames: ['GMAPS-MIGRATION-TEST', 'EXISTING-LIST'],
    preseedByPlace: { FLOW_1: ['GMAPS-MIGRATION-TEST'] }
  });
  try {
    const report = await verifyMigration({
      records: records.slice(0, 1),
      journalFile,
      stateFile: path.join(dir, 'binding.json'),
      output: path.join(dir, 'verification.json'),
      profilePath: path.join(dir, 'dedicated-profile'),
      expectedAccount: 'pilot@example.test',
      confirmAccount: 'pilot@example.test',
      targetList: 'GMAPS-MIGRATION-TEST',
      dedicatedListConfirm: 'GMAPS-MIGRATION-TEST',
      mockBaseUrl: server.baseUrl,
      headless: true,
      delayMs: 0,
      jitterMs: 0
    });
    assert.equal(report.checked, 0);
    assert.equal(report.notSaved, 0);
    assert.equal(report.stopReason, 'existing_list_membership_lost');
  } finally {
    await server.close();
  }
});

test('preflight rejects standard lists, existing reports, and live Google before opening a browser', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gmaps-preflight-'));
  const server = await startMockServer();
  const base = {
    records: records.slice(0, 1),
    journalFile: path.join(dir, 'journal.jsonl'),
    stateFile: path.join(dir, 'binding.json'),
    reportFile: path.join(dir, 'report.json'),
    profilePath: path.join(dir, 'dedicated-profile'),
    expectedAccount: 'pilot@example.test',
    confirmAccount: 'pilot@example.test',
    targetList: 'GMAPS-MIGRATION-TEST',
    dedicatedListConfirm: 'GMAPS-MIGRATION-TEST',
    headless: true,
    delayMs: 0,
    jitterMs: 0
  };
  try {
    await assert.rejects(() => runMigration({ ...base, mockBaseUrl: server.baseUrl, targetList: 'Favorites', dedicatedListConfirm: 'Favorites' }));
    await assert.rejects(() => runMigration({ ...base, mockBaseUrl: server.baseUrl, targetList: 'Favoritos', dedicatedListConfirm: 'Favoritos' }));
    await assert.rejects(() => runMigration({ ...base, headless: false, delayMs: 8000, jitterMs: 3000 }), /LIVE_DISABLED_UNVERIFIED_UI/);
    const collision = path.join(dir, 'state-and-report.json');
    await assert.rejects(
      () => runMigration({ ...base, mockBaseUrl: server.baseUrl, stateFile: collision, reportFile: collision }),
      /PATH_COLLISION/
    );
    await writeFile(base.reportFile, '{}\n', 'utf8');
    await assert.rejects(() => runMigration({ ...base, mockBaseUrl: server.baseUrl }));
    await assert.rejects(() => access(base.profilePath));
  } finally {
    await server.close();
  }
});
