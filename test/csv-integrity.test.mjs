import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCsv, csvEscape } from '../src/csv.mjs';
import { normalizeInputs } from '../src/normalize.mjs';
const url = 'https://www.google.com/maps/?query_place_id=PID';
async function normalize(csv) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'csv-integrity-'));
  const input = path.join(dir, 'saved.csv');
  const output = path.join(dir, 'out.jsonl');
  const report = path.join(dir, 'report.json');
  await writeFile(input, csv);
  return {output, report, run: () => normalizeInputs({input, output, report})};
}
for (const malformed of ['ab"cd"', '"a"b', ' "a"', '"a" ', '"unclosed']) {
  test(`reject malformed field ${JSON.stringify(malformed)}`, () => assert.throws(() => parseCsv(malformed), /引用符/));
}
for (const ending of ['\n', '\r\n', '\r']) {
  test(`record terminator ${JSON.stringify(ending)} and embedded CR preserved`, () => {
    assert.deepEqual(parseCsv(`\uFEFFtitle,url${ending}"A\r\nB",${url}${ending}`), [['title','url'],['A\r\nB',url]]);
  });
}
test('CSV escape roundtrip preserves exact cell content including empty quoted EOF', () => {
  const values = ['', '日本語', 'a,b', 'a"b', 'a\rb', 'a\nb', 'a\r\nb', ' a ', '\uFEFFx'];
  for (const value of values) assert.deepEqual(parseCsv(`prefix,${csvEscape(value)},""`), [['prefix', value, '']]);
  assert.deepEqual(parseCsv('""'), [['']]);
});
for (const [name, csv] of [
  ['URL embedded quote', `title,url\nA,${url.replace('PID','PI"D"')}\n`],
  ['duplicate URL', `title,url, URL \nA,${url},${url}2\n`],
  ['duplicate title', `title,TITLE,url\nA,B,${url}\n`],
  ['nonempty overflow', `title,url\nA,${url},lost\n`],
  ['unnamed nonempty column', `title,url,\nA,${url},lost\n`],
]) {
  test(`normalization rejects ${name} before creating outputs`, async () => {
    const job = await normalize(csv);
    await assert.rejects(job.run, /安全に判定/);
    await assert.rejects(readFile(job.output), {code:'ENOENT'});
    await assert.rejects(readFile(job.report), {code:'ENOENT'});
  });
}
test('existing trailing missing/empty columns compatibility and blank-row provenance', async () => {
  const job = await normalize(`title,url,note\n\nA,${url}\n\nB,${url}2,,,\nC\n`);
  const result = await job.run();
  assert.equal(result.inputRecords,3);
  assert.equal(result.actionableUnique,2);
  assert.equal(result.manualReview,1);
  const records=(await readFile(job.output,'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(x=>x.sourceIndex),[3,5]);
  assert.equal(result.review[0].sourceIndex,6);
});
test('1000 synthetic records preserve exact identities with quoted notes and CRLF', async () => {
  const rows=Array.from({length:1000},(_,i)=>[`P${i}`,`${url}${i}`,`note "${i}",\r\nnext`]);
  const job=await normalize('title,url,note\r\n'+rows.map(row=>row.map(csvEscape).join(',')).join('\r\n'));
  const result=await job.run();
  assert.equal(result.actionableUnique,1000);
  const output=(await readFile(job.output,'utf8')).trim().split('\n').map(JSON.parse);
  for(let i=0;i<1000;i++) { assert.equal(output[i].identity,`place_id:PID${i}`); assert.equal(output[i].note,rows[i][2]); }
});
