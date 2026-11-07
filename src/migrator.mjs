import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { baselinesByIdentity, isTerminalResult, latestByIdentity, readJournal, summarizeJournal } from './journal.mjs';
import { appendBoundResult, initializeBoundJournal, journalDigest, readBoundJournal } from './resume.mjs';
import { launchDedicatedBrowser } from './browser.mjs';
import { rewriteForMock } from './mock-server.mjs';
import { atomicWriteJson, cleanEmail, jitteredSleep, redactEmail, sha256 } from './util.mjs';

// The adapter has only been validated against the local mock. Keep live Google
// execution hard-disabled in the distributed build until a separately reviewed
// real-UI selector pack exists.
export const LIVE_GOOGLE_UI_ENABLED = false;

export function planHash(records) {
  return sha256(records.map((record) => JSON.stringify(record)).join('\n'));
}

async function assertOutputDoesNotExist(filename, label) {
  try {
    await access(filename);
    throw new Error(`${label} は既に存在します。実操作前に新しいファイル名を指定してください: ${path.resolve(filename)}`);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

function pathContains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertSeparatedPaths({ profilePath, files }) {
  const entries = Object.entries(files)
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => ({ label, resolved: path.resolve(value).toLowerCase() }));
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const a = entries[left];
      const b = entries[right];
      if (pathContains(a.resolved, b.resolved) || pathContains(b.resolved, a.resolved)) {
        throw new Error(`PATH_COLLISION:${a.label}:${b.label}: 入出力パスは相互に別の場所を指定してください`);
      }
    }
  }
  if (profilePath) {
    const profile = path.resolve(profilePath).toLowerCase();
    for (const entry of entries) {
      if (pathContains(profile, entry.resolved) || pathContains(entry.resolved, profile)) {
        throw new Error(`PATH_COLLISION:profile:${entry.label}: profileと入出力パスは分離してください`);
      }
    }
  }
}

function assertHumanConfirmation(expectedAccount, confirmAccount, targetList, dedicatedListConfirm) {
  const expected = cleanEmail(expectedAccount);
  const confirmed = cleanEmail(confirmAccount);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(expected)) throw new Error('--expected-account に対象者本人の新アカウントを指定してください');
  if (expected !== confirmed) throw new Error('--confirm-account は --expected-account と完全一致させてください');
  if (!String(targetList ?? '').trim()) throw new Error('--target-list が必要です');
  if (String(dedicatedListConfirm ?? '').trim() !== String(targetList).trim()) {
    throw new Error('--dedicated-list-confirm は、新規作成した非公開の移行専用リスト名と完全一致させてください');
  }
  // A locale-independent prefix avoids relying on an incomplete translation
  // denylist for Google's built-in list names.
  if (!String(targetList).normalize('NFKC').trim().startsWith('GMAPS-MIGRATION-')) {
    throw new Error('専用リスト名は GMAPS-MIGRATION- で始めてください');
  }
  const standardLists = new Set(['favorites', 'want to go', 'travel plans', 'starred places', 'お気に入り', '行ってみたい', '旅行プラン', 'スター付き']);
  if (standardLists.has(String(targetList).normalize('NFKC').trim().toLowerCase())) {
    throw new Error('既存の標準リストは保存先にできません。新規の非公開移行専用リストを作成してください');
  }
  return expected;
}

export async function createPilotApproval({ records, journalFile, stateFile, verificationFile, output, expectedAccount, targetList, typedConfirm }) {
  assertSeparatedPaths({ files: { journalFile, stateFile, verificationFile, output } });
  await assertOutputDoesNotExist(output, 'pilot承認出力');
  const account = cleanEmail(expectedAccount);
  const binding = { planHash: planHash(records), verifiedAccount: account, targetList };
  const { events, scope } = await readBoundJournal({ journalFile, stateFile, binding });
  const summary = summarizeJournal(records, events);
  const verifiedCount = summary.savedVerified + summary.alreadySavedVerified;
  const verification = JSON.parse(await readFile(verificationFile, 'utf8'));
  if (verifiedCount < 1) throw new Error('承認できるpilot成功件数がありません');
  if (summary.failed > 0) throw new Error('pilotに失敗または不確定結果があります。解決するまで承認できません');
  if (verification.schemaVersion !== 2 || verification.journalId !== scope.journalId || verification.journalSha256 !== journalDigest(events)) {
    throw new Error('PILOT_VERIFICATION_JOURNAL_MISMATCH: 検証結果が現在のjournalに対応しません');
  }
  if (verification.planHash !== planHash(records) || verification.account !== account || verification.targetList !== targetList) {
    throw new Error('検証結果が現在の入力・アカウント・リストと一致しません');
  }
  if (verification.notSaved !== 0 || verification.stopReason || verification.checked !== verifiedCount) {
    throw new Error('pilotの事後確認が完全には合格していません');
  }
  const required = `${account}|${targetList}|${verifiedCount}`;
  if (typedConfirm !== required) throw new Error(`--typed-confirm が一致しません。必要な形式: ${required}`);
  const approval = {
    schemaVersion: 2,
    journalId: scope.journalId,
    journalEventCount: events.length,
    journalSha256: journalDigest(events),
    approvedAt: new Date().toISOString(),
    planHash: planHash(records),
    account,
    targetList,
    pilotVerifiedCount: verifiedCount,
    verificationSha256: sha256(JSON.stringify(verification))
  };
  await atomicWriteJson(output, approval);
  return approval;
}

async function validateApproval(filename, records, account, targetList, bound) {
  const approval = JSON.parse(await readFile(filename, 'utf8'));
  if (approval.planHash !== planHash(records) || approval.account !== account || approval.targetList !== targetList || approval.pilotVerifiedCount < 1) {
    throw new Error('pilot承認ファイルが現在の入力・アカウント・リストと一致しません');
  }
  const { scope, events } = bound;
  if (approval.schemaVersion !== 2 || approval.journalId !== scope?.journalId ||
      !Number.isSafeInteger(approval.journalEventCount) || approval.journalEventCount < 2 ||
      approval.journalEventCount > events.length ||
      approval.journalSha256 !== journalDigest(events.slice(0, approval.journalEventCount))) {
    throw new Error('PILOT_APPROVAL_JOURNAL_MISMATCH: 承認ファイルが現在のjournalに対応しません');
  }
  const summary = summarizeJournal(records, events);
  if (summary.savedVerified + summary.alreadySavedVerified < approval.pilotVerifiedCount) {
    throw new Error('pilot承認に対応する検証済みjournalがありません');
  }
  return approval;
}

function assertMockBaseUrl(value) {
  if (!value) return;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('--mock-base-url はローカルHTTPの模擬画面だけを指定できます');
  }
}

function assertRateLimit(mockBaseUrl, delayMs, jitterMs) {
  if (mockBaseUrl) {
    if (delayMs < 0 || jitterMs < 0) throw new Error('mock delay/jitter は 0 以上にしてください');
  } else if (delayMs - jitterMs < 3000) {
    throw new Error('実画面の最短待機（delay-ms - jitter-ms）は 3000ms 以上が必要です');
  }
}

function withRemaining(summary) {
  return { ...summary, remaining: summary.failed + summary.unprocessed };
}

function journalBaselineFields(baseline = []) {
  const values = Array.isArray(baseline) ? baseline : [];
  const baselineCheckedLists = values
    .map((row) => typeof row === 'string' ? row : row?.label)
    .filter(Boolean);
  const fields = { baselineCheckedLists };
  if (values.every((row) => row && typeof row === 'object')) fields.baselineCheckedRows = values;
  return fields;
}

export async function dryRunPlan(records, journalFile, { stateFile, expectedAccount, targetList } = {}) {
  const hasScopeOptions = Boolean(stateFile || expectedAccount || targetList);
  let events = [];
  let historyScopeVerified = false;
  let historyIgnored = false;
  if (hasScopeOptions) {
    if (!stateFile || !expectedAccount || !targetList) throw new Error('DRY_RUN_SCOPE_REQUIRED: state/account/listをすべて指定してください');
    const binding = { planHash: planHash(records), verifiedAccount: cleanEmail(expectedAccount), targetList };
    const bound = await readBoundJournal({ journalFile, stateFile, binding, allowFresh: true });
    events = bound.events;
    historyScopeVerified = !bound.needsHeader;
  } else {
    // Without a requested destination, no history may imply its completion.
    historyIgnored = (await readJournal(journalFile)).length > 0;
  }
  return {
    mode: 'dry-run',
    noBrowserStarted: true,
    noGoogleRequestSent: true,
    planHash: planHash(records),
    historyScopeVerified,
    historyIgnored,
    ...withRemaining(summarizeJournal(records, events))
  };
}

export async function runMigration({
  records,
  journalFile,
  stateFile,
  reportFile,
  profilePath,
  browserPath,
  expectedAccount,
  confirmAccount,
  targetList,
  dedicatedListConfirm,
  approvalFile,
  pilot = 5,
  batchSize = 25,
  delayMs = 8000,
  jitterMs = 3000,
  mockBaseUrl,
  headless = false
}) {
  const account = assertHumanConfirmation(expectedAccount, confirmAccount, targetList, dedicatedListConfirm);
  assertMockBaseUrl(mockBaseUrl);
  assertRateLimit(mockBaseUrl, delayMs, jitterMs);
  assertSeparatedPaths({ profilePath, files: { journalFile, stateFile, reportFile, approvalFile } });
  if (!mockBaseUrl && !LIVE_GOOGLE_UI_ENABLED) throw new Error('LIVE_DISABLED_UNVERIFIED_UI: 配布版はGoogle実画面操作を無効化しています');
  if (headless && !mockBaseUrl) throw new Error('実アカウント操作は可視ブラウザーでのみ実行できます');
  await assertOutputDoesNotExist(reportFile, '実行レポート');
  const binding = { planHash: planHash(records), verifiedAccount: account, targetList };
  const boundOptions = { journalFile, stateFile, binding };
  const before = await readBoundJournal({ ...boundOptions, allowFresh: true });

  let limit;
  let phase;
  if (approvalFile) {
    await validateApproval(approvalFile, records, account, targetList, before);
    if (batchSize < 1 || batchSize > 50) throw new Error('承認後も1回の --batch-size は 1..50 です');
    limit = batchSize;
    phase = 'approved_batch';
  } else {
    if (pilot < 1 || pilot > 10) throw new Error('初回 --pilot は 1..10 です');
    limit = pilot;
    phase = 'pilot';
  }

  const beforeEvents = before.events;
  const latest = latestByIdentity(beforeEvents);
  const baselines = baselinesByIdentity(beforeEvents);
  const pendingIntentByIdentity = new Map();
  for (const event of beforeEvents) {
    if (event.type !== 'result' || !event.identity) continue;
    if (event.status === 'saved_pending_revisit' || event.status === 'already_saved_pending_revisit') {
      pendingIntentByIdentity.set(event.identity, event.status);
    } else if (isTerminalResult(event)) {
      pendingIntentByIdentity.delete(event.identity);
    }
  }
  const completedBefore = records.filter((record) => isTerminalResult(latest.get(record.identity)));
  const retryableBefore = records.filter((record) => [
    'failed',
    'indeterminate_after_click',
    'saved_pending_revisit',
    'already_saved_pending_revisit'
  ].includes(latest.get(record.identity)?.status));
  let pending;
  if (!approvalFile && completedBefore.length > 0) {
    if (retryableBefore.length === 0) {
      throw new Error('pilotの検証済み結果が既にあります。verify と approve-pilot を完了するまで次の対象へ進みません');
    }
    // A partially successful pilot may retry only the identities that already
    // failed. It must not advance into fresh records before approval.
    phase = 'pilot_retry';
    const remainingPilotCapacity = 10 - completedBefore.length;
    if (remainingPilotCapacity < 1) {
      throw new Error('pilotの検証済み件数が上限に達しているため、失敗分を自動再試行できません');
    }
    pending = retryableBefore.slice(0, Math.min(limit, remainingPilotCapacity));
  } else {
    pending = records.filter((record) => !isTerminalResult(latest.get(record.identity))).slice(0, limit);
  }
  if (pending.length === 0) {
    const summary = withRemaining(summarizeJournal(records, beforeEvents));
    const report = { createdAt: new Date().toISOString(), phase, processedThisRun: 0, stopReason: null, account: redactEmail(account), targetList, planHash: planHash(records), postVerification: { inFlowVerified: 0 }, ...summary };
    await atomicWriteJson(reportFile, report);
    return report;
  }

  const initialized = await initializeBoundJournal(boundOptions);
  if (beforeEvents.length > 0 && journalDigest(initialized.events) !== journalDigest(beforeEvents)) {
    throw new Error('JOURNAL_CHANGED_DURING_PREFLIGHT');
  }
  const { scope } = initialized;
  const browser = await launchDedicatedBrowser({ profilePath, browserPath, headless });
  let stopReason = null;
  let processedThisRun = 0;
  let postRevisited = 0;
  let postVerified = 0;
  const awaitingRevisit = [];
  try {
    for (const record of pending) {
      const priorResult = latest.get(record.identity);
      const historicalBaseline = baselines.get(record.identity) ?? [];
      const baselineFields = journalBaselineFields(historicalBaseline);
      const navigationUrl = mockBaseUrl ? rewriteForMock(record.navigationUrl, mockBaseUrl, record.identity) : record.navigationUrl;
      const blocker = await browser.navigate(navigationUrl);
      if (blocker.blocked) {
        stopReason = blocker.reason;
        await appendBoundResult(journalFile, scope, { type: 'result', identity: record.identity, status: 'failed', reason: blocker.reason, ...baselineFields, phase });
        break;
      }
      try {
        await browser.verifyAccount(account);
      } catch (error) {
        stopReason = error.message;
        await appendBoundResult(journalFile, scope, { type: 'result', identity: record.identity, status: 'failed', reason: error.message, ...baselineFields, phase });
        break;
      }
      const identityCheck = await browser.verifyPlaceIdentity(record, { mock: Boolean(mockBaseUrl) });
      if (!identityCheck.verified) {
        stopReason = `PLACE_IDENTITY_MISMATCH:${identityCheck.reason}`;
        await appendBoundResult(journalFile, scope, { type: 'result', identity: record.identity, status: 'failed', reason: stopReason, ...baselineFields, phase });
        break;
      }
      let result;
      try {
        result = await browser.saveToList(targetList, { requireCompleteCoverage: !mockBaseUrl, expectedCheckedRows: historicalBaseline });
      } catch (error) {
        result = { status: 'stop', reason: error.message };
      }
      processedThisRun += 1;
      if (result.status === 'saved_verified' || result.status === 'already_saved_verified') {
        const pendingIntent = pendingIntentByIdentity.get(record.identity) ?? priorResult?.status;
        const finalStatus = pendingIntent === 'saved_pending_revisit'
          ? 'saved_verified'
          : pendingIntent === 'already_saved_pending_revisit'
            ? 'already_saved_verified'
            : result.status;
        const pendingStatus = finalStatus === 'saved_verified' ? 'saved_pending_revisit' : 'already_saved_pending_revisit';
        const resultBaseline = result.baselineCheckedRows ?? result.baselineCheckedLists ?? historicalBaseline;
        await appendBoundResult(journalFile, scope, {
          type: 'result',
          identity: record.identity,
          status: pendingStatus,
          verified: false,
          ...journalBaselineFields(resultBaseline),
          baselineCoverage: result.baselineCoverage,
          phase
        });
        awaitingRevisit.push({ record, finalStatus, baselineCheckedRows: resultBaseline });
      } else if (result.status === 'indeterminate_after_click') {
        const resultBaseline = result.baselineCheckedRows ?? result.baselineCheckedLists ?? historicalBaseline;
        await appendBoundResult(journalFile, scope, { type: 'result', identity: record.identity, status: result.status, reason: result.reason, verified: false, ...journalBaselineFields(resultBaseline), phase });
        stopReason = result.reason;
        break;
      } else {
        await appendBoundResult(journalFile, scope, { type: 'result', identity: record.identity, status: 'failed', reason: result.reason, ...baselineFields, phase });
        stopReason = result.reason;
        break;
      }
      if (processedThisRun < pending.length) await jitteredSleep(delayMs, jitterMs);
    }

    // A separate navigation prevents an optimistic checkbox update on the same
    // page from being counted as durable success.
    if (!stopReason && awaitingRevisit.length > 0) {
      await jitteredSleep(delayMs, jitterMs);
      for (let index = 0; index < awaitingRevisit.length; index += 1) {
        const { record, finalStatus, baselineCheckedRows } = awaitingRevisit[index];
        const navigationUrl = mockBaseUrl ? rewriteForMock(record.navigationUrl, mockBaseUrl, record.identity) : record.navigationUrl;
        const blocker = await browser.navigate(navigationUrl);
        if (blocker.blocked) {
          stopReason = blocker.reason;
          await appendBoundResult(journalFile, scope, { type: 'result', identity: record.identity, status: 'indeterminate_after_click', reason: stopReason, ...journalBaselineFields(baselineCheckedRows), phase });
          break;
        }
        try { await browser.verifyAccount(account); }
        catch (error) {
          stopReason = error.message;
          await appendBoundResult(journalFile, scope, { type: 'result', identity: record.identity, status: 'indeterminate_after_click', reason: stopReason, ...journalBaselineFields(baselineCheckedRows), phase });
          break;
        }
        const identityCheck = await browser.verifyPlaceIdentity(record, { mock: Boolean(mockBaseUrl) });
        if (!identityCheck.verified) {
          stopReason = `PLACE_IDENTITY_MISMATCH:${identityCheck.reason}`;
          await appendBoundResult(journalFile, scope, { type: 'result', identity: record.identity, status: 'indeterminate_after_click', reason: stopReason, ...journalBaselineFields(baselineCheckedRows), phase });
          break;
        }
        const result = await browser.verifySaved(targetList, baselineCheckedRows, { requireCompleteCoverage: !mockBaseUrl });
        postRevisited += 1;
        if (result.status === 'stop' || !result.verified) {
          stopReason = result.reason || 'post_revisit_not_saved';
          await appendBoundResult(journalFile, scope, { type: 'result', identity: record.identity, status: 'failed', reason: stopReason, ...journalBaselineFields(baselineCheckedRows), phase });
          break;
        }
        postVerified += 1;
        await appendBoundResult(journalFile, scope, {
          type: 'result',
          identity: record.identity,
          status: finalStatus,
          verified: true,
          verification: 'separate_navigation',
          ...journalBaselineFields(baselineCheckedRows),
          postState: {
            targetChecked: true,
            coverage: result.coverage,
            checkedLists: result.checkedLists,
            checkedRows: result.checkedRows
          },
          phase
        });
        if (index + 1 < awaitingRevisit.length) await jitteredSleep(delayMs, jitterMs);
      }
    }
  } finally {
    await browser.close();
  }

  const { events: afterEvents } = await readBoundJournal(boundOptions);
  const summary = withRemaining(summarizeJournal(records, afterEvents));
  const report = {
    createdAt: new Date().toISOString(),
    phase,
    processedThisRun,
    stopReason,
    account: redactEmail(account),
    targetList,
    planHash: planHash(records),
    postVerification: { revisited: postRevisited, verified: postVerified, method: '別ナビゲーションで保存先の厳密名とchecked状態を再確認' },
    ...summary
  };
  await atomicWriteJson(reportFile, report);
  return report;
}

export async function verifyMigration({ records, journalFile, stateFile, output, profilePath, browserPath, expectedAccount, confirmAccount, targetList, dedicatedListConfirm, mockBaseUrl, headless = false, delayMs = 8000, jitterMs = 3000 }) {
  assertSeparatedPaths({ profilePath, files: { journalFile, stateFile, output } });
  const account = assertHumanConfirmation(expectedAccount, confirmAccount, targetList, dedicatedListConfirm);
  assertMockBaseUrl(mockBaseUrl);
  assertRateLimit(mockBaseUrl, delayMs, jitterMs);
  if (!mockBaseUrl && !LIVE_GOOGLE_UI_ENABLED) throw new Error('LIVE_DISABLED_UNVERIFIED_UI: 配布版はGoogle実画面操作を無効化しています');
  if (headless && !mockBaseUrl) throw new Error('実アカウント操作は可視ブラウザーでのみ実行できます');
  await assertOutputDoesNotExist(output, '検証レポート');
  const boundOptions = { journalFile, stateFile, binding: { planHash: planHash(records), verifiedAccount: account, targetList } };
  const { events, scope } = await readBoundJournal(boundOptions);
  const latest = latestByIdentity(events);
  const baselines = baselinesByIdentity(events);
  const completed = records.filter((record) => isTerminalResult(latest.get(record.identity)));
  if (completed.length === 0) throw new Error('事後確認する完了レコードがありません');
  const browser = await launchDedicatedBrowser({ profilePath, browserPath, headless });
  let checked = 0;
  let notSaved = 0;
  let stopReason = null;
  try {
    for (let index = 0; index < completed.length; index += 1) {
      const record = completed[index];
      const navigationUrl = mockBaseUrl ? rewriteForMock(record.navigationUrl, mockBaseUrl, record.identity) : record.navigationUrl;
      const blocker = await browser.navigate(navigationUrl);
      if (blocker.blocked) { stopReason = blocker.reason; break; }
      try { await browser.verifyAccount(account); }
      catch (error) { stopReason = error.message; break; }
      const identityCheck = await browser.verifyPlaceIdentity(record, { mock: Boolean(mockBaseUrl) });
      if (!identityCheck.verified) { stopReason = `PLACE_IDENTITY_MISMATCH:${identityCheck.reason}`; break; }
      const result = await browser.verifySaved(targetList, baselines.get(record.identity) ?? [], { requireCompleteCoverage: !mockBaseUrl });
      if (result.status === 'stop') { stopReason = result.reason; break; }
      checked += 1;
      if (!result.verified) notSaved += 1;
      if (index + 1 < completed.length) await jitteredSleep(delayMs, jitterMs);
    }
  } finally {
    await browser.close();
  }
  const after = await readBoundJournal(boundOptions);
  if (journalDigest(after.events) !== journalDigest(events)) throw new Error('JOURNAL_CHANGED_DURING_VERIFY');
  const report = { schemaVersion: 2, journalId: scope.journalId, journalSha256: journalDigest(events), createdAt: new Date().toISOString(), planHash: planHash(records), account, targetList, expectedToCheck: completed.length, checked, notSaved, stopReason };
  await atomicWriteJson(output, report);
  return report;
}
