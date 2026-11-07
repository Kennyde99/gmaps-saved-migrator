import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchDedicatedBrowser } from '../src/browser.mjs';
import { rewriteForMock, startMockServer } from '../src/mock-server.mjs';

const urlFor = (id) => `https://www.google.com/maps/search/?api=1&query=X&query_place_id=${id}`;

test('local mock: preserves existing save, verifies after click, and is crash-safe on retry', { timeout: 60000 }, async () => {
  const server = await startMockServer({ preseed: ['PRE_SAVED'], preseedByPlace: { NEW_PLACE: ['お気に入り'] } });
  const profile = await mkdtemp(path.join(os.tmpdir(), 'gmaps-browser-profile-'));
  // prepareProfile requires a truly empty directory; use a child that does not exist yet.
  const browser = await launchDedicatedBrowser({ profilePath: path.join(profile, 'dedicated'), headless: true });
  try {
    await browser.navigate(rewriteForMock(urlFor('PRE_SAVED'), server.baseUrl));
    await browser.verifyAccount('pilot@example.test');
    assert.equal((await browser.saveToList('移行先')).status, 'already_saved_verified');

    await browser.navigate(rewriteForMock(urlFor('NEW_PLACE'), server.baseUrl));
    const added = await browser.saveToList('移行先');
    assert.equal(added.status, 'saved_verified');
    assert.deepEqual(added.baselineCheckedLists, ['お気に入り']);
    // journal 書込み前クラッシュ相当: 同じ場所を再実行しても解除せず、already saved と判定する。
    await browser.navigate(rewriteForMock(urlFor('NEW_PLACE'), server.baseUrl));
    assert.equal((await browser.saveToList('移行先')).status, 'already_saved_verified');
    const verified = await browser.verifySaved('移行先', ['お気に入り']);
    assert.equal(verified.verified, true);
    assert.equal(verified.coverage, 'complete');
    assert.deepEqual(new Set(verified.checkedLists), new Set(['移行先', 'お気に入り']));

    await browser.navigate(rewriteForMock(urlFor('COVERAGE_UNKNOWN'), server.baseUrl));
    await browser.evaluate("document.body.dataset.listCoverage='unknown'");
    assert.deepEqual(
      await browser.saveToList('移行先', { requireCompleteCoverage: true }),
      { status: 'stop', reason: 'ui_coverage_unverified' }
    );
    await browser.navigate(rewriteForMock(urlFor('COVERAGE_NO_EVIDENCE'), server.baseUrl));
    await browser.evaluate("document.body.dataset.listCoverage=''");
    assert.deepEqual(
      await browser.saveToList('移行先', { requireCompleteCoverage: true }),
      { status: 'stop', reason: 'ui_coverage_unverified' }
    );
    assert.deepEqual(browser.networkAudit(), { mode: 'localhost_only', externalAttempts: [], blockedExternalRequests: [] });
  } finally {
    await browser.close();
    await server.close();
  }
});

test('local virtualized list: scans start to end, preserves checked rows, and restores the exact target before click', { timeout: 60000 }, async () => {
  const listNames = Array.from({ length: 40 }, (_, index) => `LIST-${String(index + 1).padStart(2, '0')}`);
  const targetList = 'LIST-34';
  const existing = ['LIST-03', 'LIST-19'];
  const server = await startMockServer({
    listNames,
    virtualized: true,
    preseedByPlace: { VIRTUAL_PLACE: existing }
  });
  const profile = await mkdtemp(path.join(os.tmpdir(), 'gmaps-browser-virtual-'));
  const browser = await launchDedicatedBrowser({ profilePath: path.join(profile, 'dedicated'), headless: true });
  try {
    await browser.navigate(rewriteForMock(urlFor('VIRTUAL_PLACE'), server.baseUrl));
    const added = await browser.saveToList(targetList, { requireCompleteCoverage: true });
    assert.equal(added.status, 'saved_verified');
    assert.equal(added.baselineCoverage, 'complete');
    assert.deepEqual(new Set(added.baselineCheckedLists), new Set(existing));

    await browser.navigate(rewriteForMock(urlFor('VIRTUAL_PLACE'), server.baseUrl));
    const verified = await browser.verifySaved(targetList, existing, { requireCompleteCoverage: true });
    assert.equal(verified.verified, true);
    assert.equal(verified.coverage, 'complete');
    assert.deepEqual(new Set(verified.checkedLists), new Set([...existing, targetList]));
  } finally {
    await browser.close();
    await server.close();
  }
});

test('local mock: scopes candidates to the unique save-menu root and ignores decoys and hidden rows', { timeout: 60000 }, async () => {
  const targetList = '移行先';
  const server = await startMockServer({
    listNames: [targetList, 'お気に入り'],
    decoyMenu: true,
    hiddenDuplicateRow: true
  });
  const profile = await mkdtemp(path.join(os.tmpdir(), 'gmaps-browser-root-scope-'));
  const browser = await launchDedicatedBrowser({ profilePath: path.join(profile, 'dedicated'), headless: true });
  try {
    await browser.navigate(rewriteForMock(urlFor('ROOT_SCOPE'), server.baseUrl));
    const result = await browser.saveToList(targetList);
    assert.equal(result.status, 'saved_verified');
    assert.equal(await browser.evaluate("document.body.dataset.decoyClicked || 'false'"), 'false');
    const saved = await browser.evaluate("JSON.parse(localStorage.getItem('mock-saved-v1') || '{}').ROOT_SCOPE || []");
    assert.deepEqual(saved, [targetList]);
  } finally {
    await browser.close();
    await server.close();
  }
});

test('local mock: refuses ambiguous or unrecognized save-menu roots without clicking', { timeout: 60000 }, async () => {
  for (const [name, options] of [
    ['multiple', { duplicateSaveMenuRoot: true }],
    ['unknown', { menuRootLabel: '別のメニュー' }]
  ]) {
    const server = await startMockServer({ listNames: ['移行先'], ...options });
    const profile = await mkdtemp(path.join(os.tmpdir(), `gmaps-browser-root-${name}-`));
    const browser = await launchDedicatedBrowser({ profilePath: path.join(profile, 'dedicated'), headless: true });
    try {
      await browser.navigate(rewriteForMock(urlFor(`ROOT_${name.toUpperCase()}`), server.baseUrl));
      assert.deepEqual(
        await browser.saveToList('移行先'),
        { status: 'stop', reason: 'ui_mismatch:save_menu_root_count' }
      );
      const saved = await browser.evaluate("JSON.parse(localStorage.getItem('mock-saved-v1') || '{}')");
      assert.deepEqual(saved, {});
    } finally {
      await browser.close();
      await server.close();
    }
  }
});

test('local mock: 429 and account mismatch stop safely', { timeout: 60000 }, async () => {
  const server = await startMockServer();
  const profile = await mkdtemp(path.join(os.tmpdir(), 'gmaps-browser-stop-'));
  const browser = await launchDedicatedBrowser({ profilePath: path.join(profile, 'dedicated'), headless: true });
  try {
    const blocker = await browser.navigate(`${server.baseUrl}/fault/429`);
    assert.deepEqual(blocker, { blocked: true, reason: 'http_429' });
    assert.deepEqual(await browser.navigate(`${server.baseUrl}/fault/403`), { blocked: true, reason: 'http_403' });
    assert.equal((await browser.navigate(`${server.baseUrl}/fault/login`)).reason, 'login_required');
    assert.equal((await browser.navigate(`${server.baseUrl}/fault/captcha`)).reason, 'captcha_or_unusual_traffic');
    await browser.navigate(`${server.baseUrl}/fault/ui`);
    await assert.rejects(() => browser.saveToList('移行先'), /UI_MISMATCH/);
    await browser.navigate(rewriteForMock(urlFor('A'), server.baseUrl));
    await assert.rejects(() => browser.verifyAccount('wrong@example.test'), /ACCOUNT_MISMATCH/);
    assert.equal((await browser.verifyPlaceIdentity({ identity: 'place_id:B', identityKind: 'place_id' }, { mock: true })).verified, false);
    assert.deepEqual(browser.networkAudit(), { mode: 'localhost_only', externalAttempts: [], blockedExternalRequests: [] });
  } finally {
    await browser.close();
    await server.close();
  }
});
