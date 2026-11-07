import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {normalizeInputs} from '../src/normalize.mjs';
import {csvEscape} from '../src/csv.mjs';
const place=id=>`https://www.google.com/maps/?query_place_id=${id}`;
async function job(headers, values) {
 const dir=await mkdtemp('/tmp/maps-url-alias-');
 const input=dir+'/input.csv',output=dir+'/out.jsonl',report=dir+'/report.json';
 await writeFile(input,[headers,values].map(r=>r.map(csvEscape).join(',')).join('\n'));
 return {output,report,run:()=>normalizeInputs({input,output,report})};
}
for (const alias of ['item_content_url','google maps url','google_maps_url']) {
 test(`conflicting ${alias} rejected before output`, async()=> {
  const j=await job(['title','url',alias],['Synthetic',place('A'),place('B')]);
  await assert.rejects(j.run,e=>e.details[0].error.includes('URL 別名列'));
  await assert.rejects(readFile(j.output),{code:'ENOENT'});
  await assert.rejects(readFile(j.report),{code:'ENOENT'});
 });
 test(`equivalent ${alias} accepted and priority retained`,async()=>{
  const j=await job(['title',alias,'url'],['Synthetic',place('A')+'&utm_source=synthetic',place('A')]);
  assert.equal((await j.run()).actionableUnique,1);
  const r=JSON.parse(await readFile(j.output,'utf8'));assert.equal(r.originalUrl,place('A'));
 });
}
for(const alternate of ['https://maps.app.goo.gl/synthetic','https://example.invalid/?query_place_id=A','not a URL','https://www.google.com/maps/?cid=123']) {
 test(`unresolved or different identity kind rejected: ${alternate}`,async()=>{
  const j=await job(['title','url','item_content_url'],['Synthetic',place('A'),alternate]);
  await assert.rejects(j.run,/安全に判定/);
 });
}
test('blank URL falls back to populated alias',async()=>{
 const j=await job(['title','url','item_content_url'],['Synthetic',' ',place('A')]);
 assert.equal((await j.run()).actionableUnique,1);
});
test('identical short aliases remain manual review',async()=>{
 const j=await job(['title','url','item_content_url'],['Synthetic','https://maps.app.goo.gl/synthetic','https://maps.app.goo.gl/synthetic']);
 assert.equal((await j.run()).manualReview,1);
});
test('title aliases preserve existing priority; unsupported link is not a location alias',async()=>{
 const j=await job(['title','name','url','link'],['Synthetic A','Other title',place('A'),place('B')]);
 assert.equal((await j.run()).actionableUnique,1);
 const r=JSON.parse(await readFile(j.output,'utf8'));assert.equal(r.title,'Synthetic A');assert.equal(r.identity,'place_id:A');
});
