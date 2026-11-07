import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendJournal, readJournal, summarizeJournal } from '../src/journal.mjs';

const records = ['a', 'b', 'c', 'd'].map((identity) => ({ identity }));

test('journal counts only verified terminal results as completed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gmaps-journal-'));
  const filename = path.join(dir, 'journal.jsonl');
  const evidence = { verified: true, verification: 'separate_navigation', postState: { targetChecked: true, coverage: 'complete' } };
  await appendJournal(filename, { type: 'result', identity: 'a', status: 'saved_verified', ...evidence });
  await appendJournal(filename, { type: 'result', identity: 'b', status: 'already_saved_verified', ...evidence });
  await appendJournal(filename, { type: 'result', identity: 'c', status: 'indeterminate_after_click' });
  const summary = summarizeJournal(records, await readJournal(filename));
  assert.deepEqual(summary, { totalActionable: 4, savedVerified: 1, alreadySavedVerified: 1, failed: 1, unprocessed: 1, accounted: 4 });
});

test('later verified result safely resumes an indeterminate prior attempt', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gmaps-resume-'));
  const filename = path.join(dir, 'journal.jsonl');
  await appendJournal(filename, { type: 'result', identity: 'a', status: 'indeterminate_after_click' });
  await appendJournal(filename, {
    type: 'result',
    identity: 'a',
    status: 'already_saved_verified',
    verified: true,
    verification: 'separate_navigation',
    postState: { targetChecked: true, coverage: 'complete' }
  });
  const summary = summarizeJournal(records, await readJournal(filename));
  assert.equal(summary.alreadySavedVerified, 1);
  assert.equal(summary.failed, 0);
});

test('terminal-looking journal entries are rejected without complete verified post-state evidence', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gmaps-journal-guard-'));
  const filename = path.join(dir, 'journal.jsonl');
  await assert.rejects(
    () => appendJournal(filename, { type: 'result', identity: 'a', status: 'saved_verified', verified: true }),
    /JOURNAL_COMMIT_REJECTED/
  );
  assert.deepEqual(await readJournal(filename), []);
});

test('terminal journal entries are rejected when a recorded baseline membership is absent from post-state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gmaps-journal-membership-guard-'));
  const filename = path.join(dir, 'journal.jsonl');
  await assert.rejects(
    () => appendJournal(filename, {
      type: 'result',
      identity: 'a',
      status: 'saved_verified',
      verified: true,
      verification: 'separate_navigation',
      baselineCheckedLists: ['EXISTING-LIST'],
      postState: {
        targetChecked: true,
        coverage: 'complete',
        checkedLists: ['GMAPS-MIGRATION-TEST']
      }
    }),
    /JOURNAL_COMMIT_REJECTED/
  );
  assert.deepEqual(await readJournal(filename), []);
});
