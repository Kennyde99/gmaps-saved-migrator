#!/usr/bin/env node
import { readFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEmail } from './util.mjs';

const phase = process.argv[2] || 'help';
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const source = cleanEmail(process.env.GMAPS_SOURCE_ACCOUNT || '');
const target = cleanEmail(process.env.GMAPS_TARGET_ACCOUNT || '');
const list = process.env.GMAPS_TARGET_LIST || '';
const state = path.resolve(process.env.GMAPS_STATE || 'state/transfer');
const profile = path.resolve(process.env.GMAPS_PROFILE || 'private/target-profile');
const p = name => path.join(state, name);
function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('停止しました。直前の理由を確認し、不確かな保存を成功扱いしないでください。');
}
async function confirm(text, expected) {
  if (!process.stdin.isTTY) throw new Error('対話端末が必要です。確認を省略して実行できません。');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { if ((await rl.question(`${text}\n${expected} と入力 > `)).trim() !== expected) throw new Error('確認が一致しないため停止'); }
  finally { rl.close(); }
}
async function main() {
  if (phase === 'help') {
    console.log('npm run transfer -- prepare|login|pilot|verify|approve|batch|status\n設定は README.md の環境変数を参照。元データは本人が Google Takeout から取得します。'); return;
  }
  if (!source || !target || source === target || !list.startsWith('GMAPS-MIGRATION-')) throw new Error('GMAPS_SOURCE_ACCOUNT / GMAPS_TARGET_ACCOUNT（異なるメール）/ GMAPS_TARGET_LIST（GMAPS-MIGRATION-始まり）を設定してください');
  const common = ['--input', p('normalized.jsonl'), '--journal', p('journal.jsonl'), '--state', p('binding.json'), '--expected-account', target, '--target-list', list];
  const live = ['--execute', '--live', '--profile', profile, '--confirm-account', target, '--dedicated-list-confirm', list];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (phase === 'prepare') {
    const input = process.env.GMAPS_INPUT;
    if (!input) throw new Error('GMAPS_INPUT に展開済みTakeoutの対象リストCSVまたはフォルダーを指定してください');
    await confirm('このエクスポートが移行元のアカウントのものと確認してください。自動的には照合できません。', source);
    await mkdir(state, { recursive: true });
    run(['normalize', '--input', input, '--output', p('normalized.jsonl'), '--report', p('normalize-report.json'), ...(process.env.GMAPS_GEOJSON_KIND ? ['--geojson-kind', process.env.GMAPS_GEOJSON_KIND] : [])]);
    console.log('normalize-report.json の除外・要確認を照合してください。元のメモ/リスト分類は自動転記しません。'); return;
  }
  if (phase === 'login') {
    await confirm('専用ブラウザーで移行先だけに本人がログインしてください。非公開の移行専用リストを作成します。パスワードは端末や.envへ入れません。', target);
    run(['login', '--execute', '--profile', profile, '--expected-account', target, '--confirm-account', target]); return;
  }
  if (phase === 'status') { run(['run', ...common]); return; }
  if (phase === 'approve') {
    const evidence = JSON.parse(await readFile(p('verification.json'), 'utf8'));
    await confirm('新アカウントのリストで試験1〜2件の実保存と既存保存が消えていないことを目視確認してください。まだ確認できなければ中止。', `${target}|${list}|${evidence.checked}`);
    run(['approve-pilot', ...common, '--verification', p('verification.json'), '--output', p('approval.json'), '--typed-confirm', `${target}|${list}|${evidence.checked}`]); return;
  }
  if (!['pilot', 'verify', 'batch'].includes(phase)) throw new Error('不明なphaseです');
  await confirm('Google Maps実画面の保存を使います。UI未対応や認証拒否時は停止します。対象アカウントと非公開リストを確認してください。', `${target}|${list}`);
  if (phase === 'verify') {
    run(['verify', ...common, ...live, '--output', p('verification.json')]);
    const result = JSON.parse(await readFile(p('verification.json'), 'utf8'));
    if (result.stopReason || result.notSaved !== 0 || result.checked !== result.expectedToCheck) throw new Error('再確認は不合格です。verification.jsonを保持し、保存成功と扱わないでください。');
  }
  else {
    const reportFile = p(`run-${stamp}.json`);
    run(['run', ...common, ...live, '--report', reportFile, ...(phase === 'pilot' ? ['--pilot', '2'] : ['--approval', p('approval.json'), '--batch-size', '25'])]);
    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    if (report.stopReason) throw new Error(`保存未完了: ${report.stopReason}。ログを維持し、ガードを無効化しないでください。`);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
