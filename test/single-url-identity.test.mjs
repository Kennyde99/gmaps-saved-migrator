import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {inspectMapsUrl,normalizeInputs} from '../src/normalize.mjs';
const base='https://www.google.com/maps/';
const conflicts=[
 '?query_place_id=A&place_id=B', '?query_place_id=A&query_place_id=B',
 '?place_id=A&place_id=B', '?cid=123&cid=456', '?cid=123&ludocid=456',
 '?ludocid=123&ludocid=456', '?ftid=A&ftid=B',
 '?query_place_id=A&cid=123','?place_id=A&ftid=A','?cid=123&ftid=123',
 'data=!1sA!1sB', 'data=!1sA?data=!1sB','?data=!1sA!1sB',
 'data=!1sA?query_place_id=A', '?query_place_id=A&data=!1sB'
];
for(const suffix of conflicts) test(`conflicting supported identities: ${suffix}`,()=>{
 const r=inspectMapsUrl(base+suffix);assert.equal(r.actionable,false);assert.equal(r.reason,'url_identity_conflict');assert.equal(r.navigationUrl,undefined);
});
for(const suffix of ['?query_place_id=A&cid=invalid','?cid=-1','data=!1s%ZZ','?query_place_id=A&data=!1s%ZZ']) test(`invalid evidence: ${suffix}`,()=>{
 assert.deepEqual(inspectMapsUrl(base+suffix),{actionable:false,reason:'url_identity_invalid'});
});
for(const [suffix,identity] of [
 ['?query_place_id=A&place_id=A&query_place_id=A','place_id:A'],
 ['?cid=123&ludocid=123&cid=123','cid:123'], ['?ftid=A&ftid=A','ftid:A'],
 ['data=!1sA!1sA?data=!1sA','maps_data_id:A'],
 ['?query_place_id=&place_id=A','place_id:A'],['?query_place_id=%41&place_id=A','place_id:A']
]) test(`equivalent evidence remains usable: ${suffix}`,()=>{
 const r=inspectMapsUrl(base+suffix);assert.equal(r.actionable,true);assert.equal(r.identity,identity);
});
test('normalization routes conflict to manual review without coordinate fallback',async()=>{
 const dir=await mkdtemp('/tmp/maps-single-url-');
 const input=dir+'/in.csv', output=dir+'/out.jsonl',report=dir+'/report.json';
 await writeFile(input,'title,url,latitude,longitude\nSynthetic,'+base+'?query_place_id=A&place_id=B,35,139\n');
 const result=await normalizeInputs({input,output,report,allowCoordinatePins:true});
 assert.equal(result.actionableUnique,0);assert.equal(result.manualReview,1);
 assert.equal(await readFile(output,'utf8'),'');assert.equal(result.review[0].reviewReason,'url_identity_conflict');
});
test('legacy normalized conflict is rejected on load',async()=>{
 const {loadNormalized}=await import('../src/normalize.mjs');
 const dir=await mkdtemp('/tmp/maps-single-url-load-');
 const input=dir+'/in.jsonl';
 await writeFile(input,JSON.stringify({schemaVersion:1,actionable:true,identity:'place_id:A',identityKind:'place_id',navigationUrl:base+'?query_place_id=A&place_id=B'}));
 await assert.rejects(()=>loadNormalized(input),/identity/);
});

for(const suffix of ['?query_place_id=A&data=%211sB','?data=!1sA&data=%211sB','data=%211sB?place_id=A','?data=%211sA']) test(`encoded delimiter requires review: ${suffix}`,()=>{
 assert.deepEqual(inspectMapsUrl(base+suffix),{actionable:false,reason:'url_identity_encoding_requires_review'});
});

for(const suffix of ['?query_place_id=A&data=!%31sB','?query_place_id=A&data=!1%73B','data=!%31sB?query_place_id=A','data=!1%73B?query_place_id=A']) test(`encoded marker requires review: ${suffix}`,()=>{
 assert.deepEqual(inspectMapsUrl(base+suffix),{actionable:false,reason:'url_identity_encoding_requires_review'});
});
test('tracking removal preserves literal data token roundtrip',()=>{
 const first=inspectMapsUrl(base+'?data=!1sA&utm_source=x');
 assert.equal(first.actionable,true);assert.equal(first.navigationUrl,base+'?data=!1sA');
 assert.deepEqual(inspectMapsUrl(first.navigationUrl),first);
});
