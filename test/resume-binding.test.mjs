import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, readFile, writeFile, appendFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { appendJournal, readJournal } from '../src/journal.mjs';
import { appendBoundResult, initializeBoundJournal, journalDigest, readBoundJournal } from '../src/resume.mjs';

// Only the browser dependency is substituted. No real browser, server, socket,
// network, Google account or real place data is used by this suite.
const browserUrl = new URL('../src/browser.mjs', import.meta.url).href;
const hook = registerHooks({ load(url, context, nextLoad) {
  if (url === browserUrl) return { format: 'module', shortCircuit: true,
    source: 'export async function launchDedicatedBrowser() { return globalThis.__resumeBrowserFactory(); }' };
  return nextLoad(url, context);
} });
const { runMigration, verifyMigration, createPilotApproval, dryRunPlan, planHash, LIVE_GOOGLE_UI_ENABLED } = await import('../src/migrator.mjs');
hook.deregister();
let launches = 0;
let fakeBrowser = null;
globalThis.__resumeBrowserFactory = () => { launches += 1; if (fakeBrowser) return fakeBrowser; throw new Error('OFFLINE_BROWSER_SENTINEL'); };
const records = ['SYNTHETIC_A', 'SYNTHETIC_B', 'SYNTHETIC_C'].map((id) => ({ schemaVersion: 1, actionable: true, identity: `place_id:${id}`, identityKind: 'place_id', navigationUrl: `https://www.google.com/maps/search/?api=1&query=X&query_place_id=${id}`, title: id }));
const evidence = { verified: true, verification: 'separate_navigation', baselineCheckedLists: ['KEEP'], postState: { targetChecked: true, coverage: 'complete', checkedLists: ['GMAPS-MIGRATION-TEST', 'KEEP'] } };
const bindingFor = (o) => ({ planHash: planHash(o.records), verifiedAccount: o.expectedAccount, targetList: o.targetList });
const boundOptions = (o) => ({ journalFile: o.journalFile, stateFile: o.stateFile, binding: bindingFor(o) });
async function options() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gmaps-scope-offline-'));
  return { records, journalFile: path.join(dir, 'journal.jsonl'), stateFile: path.join(dir, 'state.json'), reportFile: path.join(dir, 'run.json'), output: path.join(dir, 'verify.json'), verificationFile: path.join(dir, 'verification.json'), profilePath: path.join(dir, 'never-created-profile'), expectedAccount: 'pilot@example.test', confirmAccount: 'pilot@example.test', targetList: 'GMAPS-MIGRATION-TEST', dedicatedListConfirm: 'GMAPS-MIGRATION-TEST', typedConfirm: 'pilot@example.test|GMAPS-MIGRATION-TEST|1', mockBaseUrl: 'http://127.0.0.1:1', headless: true, delayMs: 0, jitterMs: 0, pilot: 2 };
}
async function seed(o, events = [{ identity: records[0].identity, status: 'saved_verified', ...evidence }, { identity: records[1].identity, status: 'failed', reason: 'synthetic_stop' }]) {
  const { scope } = await initializeBoundJournal(boundOptions(o));
  for (const event of events) await appendBoundResult(o.journalFile, scope, event);
  return scope;
}
async function textOrMissing(file) { if (!file) return null; try { return await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function assertRejectedEverywhere(o, pattern = /SCOPE|BINDING|STATE_MISSING|壊れています|JSON/) {
  const before = await Promise.all([o.journalFile, o.stateFile].map(textOrMissing));
  const count = launches;
  await assert.rejects(() => runMigration(o), pattern);
  await assert.rejects(() => verifyMigration(o), pattern);
  await assert.rejects(() => createPilotApproval({ ...o, output: path.join(path.dirname(o.journalFile), 'approval.json') }), pattern);
  await assert.rejects(() => dryRunPlan(o.records, o.journalFile, o), pattern);
  assert.equal(launches, count, 'all entry points reject before browser launch');
  assert.deepEqual(await Promise.all([o.journalFile, o.stateFile].map(textOrMissing)), before, 'rejection preserves original evidence');
  assert.equal(await textOrMissing(o.reportFile), null);
  assert.equal(await textOrMissing(o.output), null);
}
function memoryBrowser({ saved = new Set(), failIdentity = null, navigateBlock = null, wrongAccount = false } = {}) {
  let current;
  let navigations = 0;
  const calls = { save: [], verify: [], baselines: [], closed: 0 };
  return { saved, calls,
    async navigate() { navigations += 1; return navigateBlock?.(navigations) ?? { blocked: false }; },
    async verifyAccount(account) { assert.equal(account, 'pilot@example.test'); if (wrongAccount) throw new Error('ACCOUNT_MISMATCH'); },
    async verifyPlaceIdentity(record) { current = record.identity; return { verified: true }; },
    async saveToList(list, opts) {
      calls.save.push(current); calls.baselines.push(opts.expectedCheckedRows);
      if (current === failIdentity) return { status: 'stop', reason: 'synthetic_interruption' };
      const existed = saved.has(current); saved.add(current);
      return { status: existed ? 'already_saved_verified' : 'saved_verified', baselineCheckedLists: ['KEEP'], baselineCoverage: 'complete' };
    },
    async verifySaved(list, baseline) { calls.verify.push(current); calls.baselines.push(baseline); return { verified: saved.has(current), coverage: 'complete', checkedLists: [list, 'KEEP'] }; },
    async close() { calls.closed += 1; }
  };
}

test('fresh missing and empty journals initialize scoped pairs before launch; same-scope restart is valid', async () => {
  for (const emptyFile of [false, true]) {
    const o = await options();
    if (emptyFile) await writeFile(o.journalFile, '');
    await assert.rejects(() => runMigration(o), /OFFLINE_BROWSER_SENTINEL/);
    const bound = await readBoundJournal(boundOptions(o));
    assert.equal(bound.events.length, 1);
    assert.equal(bound.events[0].type, 'scope');
    assert.equal(bound.scope.planHash, planHash(records));
    await assert.rejects(() => runMigration(o), /OFFLINE_BROWSER_SENTINEL/);
    assert.deepEqual((await readBoundJournal(boundOptions(o))).events, bound.events);
  }
});

test('state-only interruption resumes with no inherited results; header-only interruption also resumes', async () => {
  const o = await options();
  const state = { schemaVersion: 2, journalId: randomUUID(), ...bindingFor(o) };
  await writeFile(o.stateFile, JSON.stringify(state));
  await assert.rejects(() => runMigration(o), /OFFLINE_BROWSER_SENTINEL/);
  assert.equal((await readBoundJournal(boundOptions(o))).scope.journalId, state.journalId);
  assert.equal((await dryRunPlan(records, o.journalFile, o)).unprocessed, 3);
});

const mutations = {
  'account-only change': async (o) => { o.expectedAccount = o.confirmAccount = 'other@example.test'; },
  'list-only change': async (o) => { o.targetList = o.dedicatedListConfirm = 'GMAPS-MIGRATION-OTHER'; },
  'full-plan content change with same identities': async (o) => { o.records = records.map((r) => ({ ...r, title: `${r.title}-changed` })); },
  'full-plan order change': async (o) => { o.records = [...records].reverse(); },
  'missing state': async (o) => { await unlink(o.stateFile); },
  'swapped same-scope state from a different run': async (o) => { const other = await options(); await seed(other); await writeFile(o.stateFile, await readFile(other.stateFile)); },
  'matching new-account state with old-account journal': async (o) => { const state = JSON.parse(await readFile(o.stateFile)); state.verifiedAccount = o.expectedAccount = o.confirmAccount = 'other@example.test'; await writeFile(o.stateFile, JSON.stringify(state)); },
  'matching new-list state with old-list journal': async (o) => { const state = JSON.parse(await readFile(o.stateFile)); state.targetList = o.targetList = o.dedicatedListConfirm = 'GMAPS-MIGRATION-OTHER'; await writeFile(o.stateFile, JSON.stringify(state)); },
  'matching changed-plan state with old-plan journal': async (o) => { o.records = records.map((r) => ({ ...r, title: `${r.title}-changed` })); const state = JSON.parse(await readFile(o.stateFile)); state.planHash = planHash(o.records); await writeFile(o.stateFile, JSON.stringify(state)); },
  'legacy state even when plan account and list match': async (o) => { await writeFile(o.stateFile, JSON.stringify({ schemaVersion: 1, ...bindingFor(o) })); },
  'missing journal header': async (o) => { const rows = await readJournal(o.journalFile); await writeFile(o.journalFile, rows.slice(1).map(JSON.stringify).join('\n') + '\n'); },
  'mixed legacy success': async (o) => { await appendJournal(o.journalFile, { type: 'result', identity: records[0].identity, status: 'saved_verified', ...evidence }); },
  'mixed legacy failure with baseline': async (o) => { await appendJournal(o.journalFile, { type: 'result', identity: records[1].identity, status: 'failed', baselineCheckedLists: ['OTHER-ACCOUNT'] }); },
  'mixed legacy pending intent': async (o) => { await appendJournal(o.journalFile, { type: 'result', identity: records[1].identity, status: 'saved_pending_revisit' }); },
  'mixed scope in non-latest row cannot be hidden by valid later row': async (o) => { const { scope } = await readBoundJournal(boundOptions(o)); await appendBoundResult(o.journalFile, { ...scope, targetList: 'GMAPS-MIGRATION-OTHER' }, { identity: records[1].identity, status: 'failed' }); await appendBoundResult(o.journalFile, scope, { identity: records[1].identity, status: 'failed' }); },
  'duplicate scope header': async (o) => { const { scope } = await readBoundJournal(boundOptions(o)); await appendJournal(o.journalFile, { journalVersion: 2, type: 'scope', scope }); },
  'truncated final journal line': async (o) => { await appendFile(o.journalFile, '{"journalVersion":2,'); },
  'null journal row': async (o) => { await appendFile(o.journalFile, 'null\n'); },
  'truncated state': async (o) => { await writeFile(o.stateFile, '{"schemaVersion":2,'); }
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`${name}: run, verify, approve and scoped dry-run reject without mutation or browser`, async () => {
    const o = await options(); await seed(o); await mutate(o); await assertRejectedEverywhere(o);
  });
}

test('legacy orphan evidence is never adopted, including old failures before state creation', async () => {
  for (const status of ['failed', 'saved_pending_revisit', 'indeterminate_after_click', 'saved_verified']) {
    const o = await options();
    await appendJournal(o.journalFile, { type: 'result', identity: records[0].identity, status, ...(status === 'saved_verified' ? evidence : {}) });
    await assertRejectedEverywhere(o);
  }
});

test('state path is mandatory for run, verify and approve with resumable evidence', async () => {
  const o = await options(); await seed(o);
  await assertRejectedEverywhere({ ...o, stateFile: undefined }, /STATE_FILE_REQUIRED|DRY_RUN_SCOPE_REQUIRED/);
});

test('dry-run without destination ignores all historical completion; fully bound dry-run may count it', async () => {
  const o = await options(); await seed(o);
  const unscoped = await dryRunPlan(records, o.journalFile);
  assert.equal(unscoped.historyIgnored, true); assert.equal(unscoped.historyScopeVerified, false);
  assert.equal(unscoped.savedVerified, 0); assert.equal(unscoped.remaining, 3);
  const scoped = await dryRunPlan(records, o.journalFile, o);
  assert.equal(scoped.historyScopeVerified, true); assert.equal(scoped.savedVerified, 1); assert.equal(scoped.remaining, 2);
  await unlink(o.stateFile);
  assert.equal((await dryRunPlan(records, o.journalFile)).savedVerified, 0);
});

test('verified same-scope retry preserves baseline and pending intent without advancing into a fresh record', async () => {
  const o = await options();
  await seed(o, [
    { identity: records[0].identity, status: 'saved_verified', ...evidence },
    { identity: records[1].identity, status: 'saved_pending_revisit', baselineCheckedLists: ['KEEP'] },
    { identity: records[1].identity, status: 'failed', reason: 'interrupted_revisit' }
  ]);
  fakeBrowser = memoryBrowser({ saved: new Set([records[0].identity, records[1].identity]) });
  try {
    const report = await runMigration(o);
    assert.equal(report.phase, 'pilot_retry'); assert.equal(report.processedThisRun, 1);
    assert.equal(report.savedVerified, 2); assert.equal(report.alreadySavedVerified, 0); assert.equal(report.remaining, 1);
    assert.deepEqual(fakeBrowser.calls.save, [records[1].identity]);
    assert.deepEqual(fakeBrowser.calls.baselines[0], ['KEEP']);
    assert.equal(fakeBrowser.saved.has(records[2].identity), false);
    const { events, scope } = await readBoundJournal(boundOptions(o));
    assert.ok(events.every((event) => event.scope.journalId === scope.journalId));
  } finally { fakeBrowser = null; }
});

test('fresh end-to-end pilot, verified approval, bounded batch and no-op resume use one bound journal', async () => {
  const o = await options();
  fakeBrowser = memoryBrowser();
  try {
    const pilot = await runMigration({ ...o, pilot: 1 });
    assert.equal(pilot.savedVerified, 1); assert.equal(pilot.remaining, 2);
    await assert.rejects(() => runMigration({ ...o, reportFile: `${o.reportFile}.unapproved` }), /approve-pilot/);
    const verification = await verifyMigration({ ...o, output: o.verificationFile });
    assert.equal(verification.checked, 1);
    const approvalFile = path.join(path.dirname(o.journalFile), 'approval.json');
    const approval = await createPilotApproval({ ...o, output: approvalFile });
    assert.equal(approval.journalId, verification.journalId);
    for (let index = 0; index < 2; index += 1) {
      const batch = await runMigration({ ...o, reportFile: `${o.reportFile}.batch${index}`, approvalFile, batchSize: 1 });
      assert.equal(batch.processedThisRun, 1);
    }
    const before = launches;
    const done = await runMigration({ ...o, reportFile: `${o.reportFile}.done`, approvalFile });
    assert.equal(done.savedVerified, 3); assert.equal(done.remaining, 0); assert.equal(done.processedThisRun, 0);
    assert.equal(launches, before); assert.equal(fakeBrowser.saved.size, 3);
  } finally { fakeBrowser = null; }
});

test('pre-account failure is scoped before any save and can safely retry the same scope', async () => {
  for (const reason of ['navigation', 'account']) {
    const o = await options();
    fakeBrowser = memoryBrowser(reason === 'navigation' ? { navigateBlock: () => ({ blocked: true, reason: 'synthetic_block' }) } : { wrongAccount: true });
    try {
      const report = await runMigration(o);
      assert.equal(report.savedVerified, 0); assert.equal(fakeBrowser.calls.save.length, 0);
      const bound = await readBoundJournal(boundOptions(o)); assert.equal(bound.events[1].status, 'failed');
      fakeBrowser = memoryBrowser();
      const retry = await runMigration({ ...o, reportFile: `${o.reportFile}.retry`, pilot: 1 });
      assert.equal(retry.savedVerified, 1);
    } finally { fakeBrowser = null; }
  }
});

test('interruption after click and before durable revisit is resumable with the original saved intent', async () => {
  const o = await options();
  const saved = new Set();
  fakeBrowser = memoryBrowser({ saved, navigateBlock: (n) => n === 2 ? { blocked: true, reason: 'synthetic_revisit_interrupt' } : { blocked: false } });
  try {
    const first = await runMigration({ ...o, pilot: 1 });
    assert.equal(first.savedVerified, 0); assert.equal(first.failed, 1);
    fakeBrowser = memoryBrowser({ saved });
    const second = await runMigration({ ...o, reportFile: `${o.reportFile}.retry`, pilot: 1 });
    assert.equal(second.savedVerified, 1); assert.equal(second.alreadySavedVerified, 0);
  } finally { fakeBrowser = null; }
});

test('verification and approval cannot be transplanted between independently initialized same-scope runs', async () => {
  const a = await options(); const b = await options(); await seed(a, [{ identity: records[0].identity, status: 'saved_verified', ...evidence }]); await seed(b, [{ identity: records[0].identity, status: 'saved_verified', ...evidence }]);
  fakeBrowser = memoryBrowser({ saved: new Set([records[0].identity]) });
  try { await verifyMigration({ ...a, output: a.verificationFile }); } finally { fakeBrowser = null; }
  await writeFile(b.verificationFile, await readFile(a.verificationFile));
  await assert.rejects(() => createPilotApproval({ ...b, output: `${b.output}.approval` }), /PILOT_VERIFICATION_JOURNAL_MISMATCH/);
  const approvalFile = `${a.output}.approval`;
  await createPilotApproval({ ...a, output: approvalFile });
  const count = launches;
  await assert.rejects(() => runMigration({ ...b, approvalFile }), /PILOT_APPROVAL_JOURNAL_MISMATCH/);
  assert.equal(launches, count);
});

test('stale verification and edited approval prefix cannot authorize changed history', async () => {
  const o = await options(); const scope = await seed(o, [{ identity: records[0].identity, status: 'saved_verified', ...evidence }]);
  fakeBrowser = memoryBrowser({ saved: new Set([records[0].identity]) });
  try { await verifyMigration({ ...o, output: o.verificationFile }); } finally { fakeBrowser = null; }
  const approvalFile = `${o.output}.approval`;
  await createPilotApproval({ ...o, output: approvalFile });
  await appendBoundResult(o.journalFile, scope, { identity: records[0].identity, status: 'saved_verified', ...evidence });
  await assert.rejects(() => createPilotApproval({ ...o, output: `${approvalFile}.stale` }), /PILOT_VERIFICATION_JOURNAL_MISMATCH/);
  const rows = await readJournal(o.journalFile); rows[1].phase = 'edited';
  await writeFile(o.journalFile, rows.map(JSON.stringify).join('\n') + '\n');
  await assert.rejects(() => runMigration({ ...o, approvalFile }), /PILOT_APPROVAL_JOURNAL_MISMATCH/);
});

test('CLI forwards optional dry-run scope and requires state for verify/approve-pilot', async () => {
  const o = await options(); await seed(o);
  const input = path.join(path.dirname(o.journalFile), 'input.jsonl'); await writeFile(input, records.map(JSON.stringify).join('\n') + '\n');
  const exec = promisify(execFile); const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const base = ['run', '--input', input, '--journal', o.journalFile];
  const plain = JSON.parse((await exec(process.execPath, [cli, ...base])).stdout);
  assert.equal(plain.savedVerified, 0); assert.equal(plain.historyIgnored, true);
  const scoped = JSON.parse((await exec(process.execPath, [cli, ...base, '--state', o.stateFile, '--expected-account', o.expectedAccount, '--target-list', o.targetList])).stdout);
  assert.equal(scoped.savedVerified, 1); assert.equal(scoped.historyScopeVerified, true);
  for (const command of ['verify', 'approve-pilot']) {
    await assert.rejects(() => exec(process.execPath, [cli, command, '--execute', '--input', input, '--journal', o.journalFile]), (e) => { assert.match(e.stderr, /--state/); return true; });
  }
});

test('live Google requires explicit opt-in, with no initialization or browser side effect', async () => {
  assert.equal(LIVE_GOOGLE_UI_ENABLED, true);
  const o = await options(); const before = launches;
  for (const action of [runMigration, verifyMigration]) {
    await assert.rejects(() => action({ ...o, mockBaseUrl: undefined, headless: false, delayMs: 8000, jitterMs: 3000 }), /LIVE_OPT_IN_REQUIRED/);
  }
  assert.equal(launches, before); assert.equal(await textOrMissing(o.stateFile), null); assert.equal(await textOrMissing(o.journalFile), null);
});


test('already-saved pending intent remains already-saved after an interrupted revisit', async () => {
  const o = await options();
  await seed(o, [{ identity: records[0].identity, status: 'already_saved_pending_revisit', baselineCheckedLists: ['KEEP'] }]);
  fakeBrowser = memoryBrowser({ saved: new Set([records[0].identity]) });
  try {
    const report = await runMigration({ ...o, pilot: 1 });
    assert.equal(report.savedVerified, 0); assert.equal(report.alreadySavedVerified, 1);
  } finally { fakeBrowser = null; }
});

test('journal changes during verification cannot produce a reusable verification report', async () => {
  const o = await options(); const scope = await seed(o, [{ identity: records[0].identity, status: 'saved_verified', ...evidence }]);
  fakeBrowser = memoryBrowser({ saved: new Set([records[0].identity]) });
  const verify = fakeBrowser.verifySaved;
  fakeBrowser.verifySaved = async (...args) => {
    await appendBoundResult(o.journalFile, scope, { identity: records[1].identity, status: 'failed' });
    return verify(...args);
  };
  try {
    await assert.rejects(() => verifyMigration(o), /JOURNAL_CHANGED_DURING_VERIFY/);
    assert.equal(await textOrMissing(o.output), null);
  } finally { fakeBrowser = null; }
});

test('live pilot explicitly opts in, writes at most 2 and still revisits before success', async () => {
 const o = await options(); fakeBrowser = memoryBrowser();
 try {
  const r = await runMigration({...o, mockBaseUrl:undefined, live:true, headless:false, delayMs:3000, jitterMs:0});
  assert.equal(r.processedThisRun,2); assert.equal(r.savedVerified,2); assert.equal(fakeBrowser.calls.save.length,2);
 } finally { fakeBrowser=null; }
});
test('live opt-in cannot bypass 2-place pilot or visible browser', async () => {
 const o=await options(); const count=launches;
 await assert.rejects(()=>runMigration({...o,mockBaseUrl:undefined,live:true,headless:false,pilot:3,delayMs:3000,jitterMs:0}),/LIVE_PILOT_LIMIT/);
 await assert.rejects(()=>runMigration({...o,mockBaseUrl:undefined,live:true,headless:true,delayMs:3000,jitterMs:0}),/可視ブラウザー/);
 assert.equal(launches,count);
});
