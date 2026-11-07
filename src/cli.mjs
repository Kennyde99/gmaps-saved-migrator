#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import { normalizeInputs, loadNormalized } from './normalize.mjs';
import { asInt, cleanEmail, parseArgs } from './util.mjs';
import { createPilotApproval, dryRunPlan, runMigration, verifyMigration } from './migrator.mjs';
import { generateSyntheticCsv } from './synthetic.mjs';
import { launchDedicatedBrowser } from './browser.mjs';
import { startMockServer } from './mock-server.mjs';

function usage() {
  return `Google Maps 保存スポット移行補助（dry-run 既定・実Google保存は現在無効）

  normalize --input <CSV|GeoJSON|dir> --output state/normalized.jsonl --report state/normalize-report.json
  run --input state/normalized.jsonl --journal state/journal.jsonl
      [--state state/binding.json --expected-account user@example.com --target-list GMAPS-MIGRATION-EXAMPLE]
  generate-sample --out samples/synthetic-1000.csv --count 1000
  mock-server [--port 4173]
  login --execute --profile private/target-profile
      --expected-account user@example.com --confirm-account user@example.com

  開発用モックでの run/verify は --mock-base-url http://127.0.0.1:<port>
  と --dedicated-list-confirm <target-listと完全一致> が必要です。
  verify / approve-pilot も --state と --journal の同じ組を指定します。
  state/account/listなしのdry-runは履歴成功を採用しません。
  login は本人が専用profileへ手動ログインするだけです。
  実Googleの run/verify は LIVE_DISABLED_UNVERIFIED_UI で停止します。
`;
}

function required(args, key) {
  if (!args[key]) throw new Error(`--${key} が必要です`);
  return args[key];
}

function executionOptions(args) {
  return {
    journalFile: required(args, 'journal'),
    stateFile: required(args, 'state'),
    reportFile: required(args, 'report'),
    profilePath: required(args, 'profile'),
    browserPath: args.browser,
    expectedAccount: required(args, 'expected-account'),
    confirmAccount: required(args, 'confirm-account'),
    targetList: required(args, 'target-list'),
    dedicatedListConfirm: required(args, 'dedicated-list-confirm'),
    approvalFile: args.approval,
    pilot: asInt(args.pilot, 5, { min: 1, max: 10 }),
    batchSize: asInt(args['batch-size'], 25, { min: 1, max: 50 }),
    delayMs: asInt(args['delay-ms'], 8000, { min: 0, max: 600000 }),
    jitterMs: asInt(args['jitter-ms'], 3000, { min: 0, max: 600000 }),
    mockBaseUrl: args['mock-base-url'],
    headless: Boolean(args.headless)
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!command || command === 'help' || args.help) { console.log(usage()); return; }

  if (command === 'normalize') {
    const result = await normalizeInputs({ input: required(args, 'input'), output: required(args, 'output'), report: required(args, 'report'), allowCoordinatePins: Boolean(args['allow-coordinate-pins']), geoJsonKind: args['geojson-kind'] });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'generate-sample') {
    console.log(JSON.stringify(await generateSyntheticCsv(required(args, 'out'), asInt(args.count, 1000, { min: 30, max: 100000 })), null, 2));
    return;
  }
  if (command === 'run') {
    const records = await loadNormalized(required(args, 'input'));
    if (!args.execute) {
      console.log(JSON.stringify(await dryRunPlan(records, required(args, 'journal'), { stateFile: args.state, expectedAccount: args['expected-account'], targetList: args['target-list'] }), null, 2));
      return;
    }
    console.log(JSON.stringify(await runMigration({ records, ...executionOptions(args) }), null, 2));
    return;
  }
  if (command === 'verify') {
    if (!args.execute) throw new Error('verify には明示的な --execute が必要です');
    const records = await loadNormalized(required(args, 'input'));
    console.log(JSON.stringify(await verifyMigration({
      records,
      journalFile: required(args, 'journal'),
      stateFile: required(args, 'state'),
      output: required(args, 'output'),
      profilePath: required(args, 'profile'),
      browserPath: args.browser,
      expectedAccount: required(args, 'expected-account'),
      confirmAccount: required(args, 'confirm-account'),
      targetList: required(args, 'target-list'),
      dedicatedListConfirm: required(args, 'dedicated-list-confirm'),
      mockBaseUrl: args['mock-base-url'],
      headless: Boolean(args.headless),
      delayMs: asInt(args['delay-ms'], 8000, { min: 0, max: 600000 }),
      jitterMs: asInt(args['jitter-ms'], 3000, { min: 0, max: 600000 })
    }), null, 2));
    return;
  }
  if (command === 'approve-pilot') {
    const records = await loadNormalized(required(args, 'input'));
    console.log(JSON.stringify(await createPilotApproval({ records, journalFile: required(args, 'journal'), stateFile: required(args, 'state'), verificationFile: required(args, 'verification'), output: required(args, 'output'), expectedAccount: required(args, 'expected-account'), targetList: required(args, 'target-list'), typedConfirm: required(args, 'typed-confirm') }), null, 2));
    return;
  }
  if (command === 'login') {
    if (!args.execute) throw new Error('login には明示的な --execute が必要です');
    const expectedAccount = cleanEmail(required(args, 'expected-account'));
    const confirmedAccount = cleanEmail(required(args, 'confirm-account'));
    if (expectedAccount !== confirmedAccount) throw new Error('--confirm-account は --expected-account と完全一致させてください');
    const browser = await launchDedicatedBrowser({ profilePath: required(args, 'profile'), browserPath: args.browser, headless: false });
    try {
      await browser.navigate('https://www.google.com/maps');
      console.log('専用ブラウザーで、対象者本人が新アカウントへログインしてください。完了後にここで Enter を押します。');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await rl.question('Enter で閉じる > ');
      rl.close();
      const blocker = await browser.detectBlocker();
      if (blocker.blocked) throw new Error(`LOGIN_NOT_CONFIRMED:${blocker.reason}`);
      await browser.verifyAccount(expectedAccount);
      console.log('専用profile上の対象アカウント表示を確認しました。保存操作は行っていません。');
    } finally { await browser.close(); }
    return;
  }
  if (command === 'mock-server') {
    const server = await startMockServer({ port: asInt(args.port, 4173, { min: 0, max: 65535 }), account: args.account || 'pilot@example.test', preseed: String(args.preseed || '').split(',').filter(Boolean) });
    console.log(`mock server: ${server.baseUrl} (Ctrl+C で停止)`);
    await new Promise(() => {});
  }
  throw new Error(`不明なコマンド: ${command}\n${usage()}`);
}

main().catch((error) => {
  console.error(`停止: ${error.message}`);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
});
