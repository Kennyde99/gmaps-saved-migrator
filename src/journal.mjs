import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

const VERIFIED_TERMINAL_STATUSES = new Set(['saved_verified', 'already_saved_verified']);

function baselinePreservedInPostState(event) {
  const baselineRows = Array.isArray(event?.baselineCheckedRows) ? event.baselineCheckedRows : null;
  const baselineLists = Array.isArray(event?.baselineCheckedLists) ? event.baselineCheckedLists : [];
  if (baselineRows?.length) {
    const checkedRows = Array.isArray(event?.postState?.checkedRows) ? event.postState.checkedRows : [];
    return baselineRows.every((expected) => checkedRows.some((actual) =>
      actual?.key === expected?.key && actual?.label === expected?.label
    ));
  }
  const checkedLists = Array.isArray(event?.postState?.checkedLists) ? event.postState.checkedLists : [];
  return baselineLists.every((expected) => checkedLists.includes(expected));
}

function hasVerifiedPostState(event) {
  return event?.verified === true &&
    event?.verification === 'separate_navigation' &&
    event?.postState?.targetChecked === true &&
    event?.postState?.coverage === 'complete' &&
    baselinePreservedInPostState(event);
}

export async function appendJournal(filename, event) {
  if (VERIFIED_TERMINAL_STATUSES.has(event?.status) && !hasVerifiedPostState(event)) {
    throw new Error('JOURNAL_COMMIT_REJECTED: verified post-state from a separate navigation is required');
  }
  const absolute = path.resolve(filename);
  await mkdir(path.dirname(absolute), { recursive: true });
  const handle = await open(absolute, 'a');
  try {
    await handle.write(`${JSON.stringify({ journalVersion: 1, at: new Date().toISOString(), ...event })}\n`, null, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJournal(filename) {
  let text = '';
  try {
    text = await readFile(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${filename}:${index + 1}: journal が壊れています。自動修復せず停止します。`);
    }
  });
}

export function latestByIdentity(events) {
  const latest = new Map();
  for (const event of events) {
    if (event.type === 'result' && event.identity) latest.set(event.identity, event);
  }
  return latest;
}

export function baselinesByIdentity(events) {
  const baselines = new Map();
  for (const event of events) {
    if (event.type !== 'result' || !event.identity) continue;
    if (Array.isArray(event.baselineCheckedRows)) baselines.set(event.identity, event.baselineCheckedRows);
    else if (Array.isArray(event.baselineCheckedLists)) baselines.set(event.identity, event.baselineCheckedLists);
  }
  return baselines;
}

export function isTerminalResult(event) {
  return VERIFIED_TERMINAL_STATUSES.has(event?.status) && hasVerifiedPostState(event);
}

export function summarizeJournal(records, events) {
  const latest = latestByIdentity(events);
  let savedVerified = 0;
  let alreadySavedVerified = 0;
  let failed = 0;
  let unprocessed = 0;
  for (const record of records) {
    const event = latest.get(record.identity);
    if (isTerminalResult(event) && event.status === 'saved_verified') savedVerified += 1;
    else if (isTerminalResult(event) && event.status === 'already_saved_verified') alreadySavedVerified += 1;
    else if (event?.status === 'failed' || event?.status === 'indeterminate_after_click') failed += 1;
    else unprocessed += 1;
  }
  return {
    totalActionable: records.length,
    savedVerified,
    alreadySavedVerified,
    failed,
    unprocessed,
    accounted: savedVerified + alreadySavedVerified + failed + unprocessed
  };
}
