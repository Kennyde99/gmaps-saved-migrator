import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { appendJournal, readJournal } from './journal.mjs';
import { sha256 } from './util.mjs';

const SCOPE_KEYS = ['journalId', 'planHash', 'verifiedAccount', 'targetList'];
const RECOVERY = '元のファイルを保持し、新しいjournal/stateで履歴を引き継がず開始してください。';

function stop(reason) {
  throw new Error(`${reason}: ${RECOVERY}`);
}

function scopeFrom(state) {
  if (state?.schemaVersion !== 2 || !/^[0-9a-f-]{36}$/.test(state.journalId ?? '') ||
      !/^[0-9a-f]{64}$/.test(state.planHash ?? '') ||
      typeof state.verifiedAccount !== 'string' || !state.verifiedAccount ||
      typeof state.targetList !== 'string' || !state.targetList) stop('STATE_SCOPE_UNBOUND');
  return Object.fromEntries([['schemaVersion', 2], ...SCOPE_KEYS.map((key) => [key, state[key]])]);
}

function assertScope(actual, expected, reason) {
  if (actual?.schemaVersion !== 2) stop(`${reason}:schemaVersion`);
  for (const key of SCOPE_KEYS) {
    if (actual[key] !== expected[key]) stop(`${reason}:${key}`);
  }
}

export function journalDigest(events) {
  return sha256(events.map((event) => JSON.stringify(event)).join('\n'));
}

// This is the only entry point used by run, verify and approve-pilot before
// reading results, baselines, pending intent or retry restrictions. A matching
// state alone is insufficient: the header AND every journal row must match it.
export async function readBoundJournal({ journalFile, stateFile, binding, allowFresh = false }) {
  if (!stateFile) stop('STATE_FILE_REQUIRED');
  let state = null;
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const events = await readJournal(journalFile);
  const scope = state === null ? null : scopeFrom(state);
  if (scope) {
    for (const key of ['planHash', 'verifiedAccount', 'targetList']) {
      if (scope[key] !== binding[key]) stop(`STATE_BINDING_MISMATCH:${key}`);
    }
  }
  if (events.length === 0) {
    if (!allowFresh) stop('JOURNAL_SCOPE_MISSING');
    // A state-only interruption contains no results to inherit. Finishing its
    // empty header is safe; state itself never establishes completion.
    return { scope, events, needsHeader: true };
  }
  if (!scope) stop('JOURNAL_STATE_MISSING');
  if (events[0]?.type !== 'scope') stop('JOURNAL_SCOPE_UNBOUND');
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.journalVersion !== 2 || event.type !== (index === 0 ? 'scope' : 'result')) {
      stop(`JOURNAL_SCOPE_UNBOUND:row${index + 1}`);
    }
    assertScope(event.scope, scope, `JOURNAL_SCOPE_MISMATCH:row${index + 1}`);
  }
  return { scope, events, needsHeader: false };
}

export async function initializeBoundJournal(options) {
  let bound = await readBoundJournal({ ...options, allowFresh: true });
  if (!bound.needsHeader) return bound;
  if (!bound.scope) {
    const state = { schemaVersion: 2, journalId: randomUUID(), ...options.binding, createdAt: new Date().toISOString() };
    await mkdir(path.dirname(path.resolve(options.stateFile)), { recursive: true });
    // Exclusive creation and fsync, before any journal row or browser launch.
    // A torn write fails closed on the next read; never replace old evidence.
    const handle = await open(options.stateFile, 'wx');
    try { await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    bound = await readBoundJournal({ ...options, allowFresh: true });
  }
  if (bound.needsHeader) {
    await appendJournal(options.journalFile, { journalVersion: 2, type: 'scope', scope: bound.scope });
  }
  return readBoundJournal(options);
}

export async function appendBoundResult(journalFile, scope, event) {
  await appendJournal(journalFile, { ...event, journalVersion: 2, scope, type: 'result' });
}
