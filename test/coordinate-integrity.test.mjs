import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import {normalizeInputs,loadNormalized} from '../src/normalize.mjs';
async function run(coordinates,{allowCoordinatePins=true,url}={}) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'maps-coordinate-'));
 const input=path.join(dir,'Saved Places.json'),output=path.join(dir,'out.jsonl');
 await writeFile(input,JSON.stringify({type:'FeatureCollection',features:[{geometry:{type:'Point',coordinates},properties:{name:'Synthetic',url}}]}));
 const result=await normalizeInputs({input,output,report:path.join(dir,'report.json'),allowCoordinatePins});
 return {result,records:await loadNormalized(output)};
}
for (const bad of ['', ' ',null,false,true,[],[35],{},'0x23','Infinity','NaN','1_0']) {
 for(const axis of [0,1]) test(`reject invalid coordinate ${JSON.stringify(bad)} at axis ${axis}`,async()=>{
  const c=[139,35]; c[axis]=bad;
  const {result,records}=await run(c); assert.equal(result.manualReview,1); assert.equal(records.length,0);
 });
}
test('missing one coordinate remains manual review',async()=>{
 const {result}=await run([139]); assert.equal(result.manualReview,1); assert.equal(result.actionableUnique,0);
});
for(const c of [[139,0],[0,35],['139.0','0'],['0','3.5e1'],[-180,-90],[180,90]]) test(`preserve explicit valid zero/boundary ${JSON.stringify(c)}`,async()=>{
 const {records}=await run(c); assert.equal(records.length,1); assert.equal(records[0].coordinateOptIn,true);
});
test('coordinate pins still require opt-in',async()=>{assert.equal((await run([139,35],{allowCoordinatePins:false})).result.manualReview,1);});
for(const c of [[0,0],[1e-9,1e-9],[-1e-9,1e-9],[181,35],[139,91]]) test(`reject unknown origin or range ${JSON.stringify(c)}`,async()=>{assert.equal((await run(c)).result.manualReview,1);});
test('exact place ID is still usable with invalid coordinate metadata',async()=>{
 const {records}=await run([139,false],{url:'https://www.google.com/maps/search/?api=1&query=X&query_place_id=SYNTHETIC'});
 assert.equal(records.length,1); assert.equal(records[0].latitude,null); assert.equal(records[0].identity,'place_id:SYNTHETIC');
});
test('CSV blank latitude never generates equator pin',async()=>{
 const d=await mkdtemp(path.join(os.tmpdir(),'maps-csv-coordinate-'));const input=path.join(d,'input.csv'),output=path.join(d,'out.jsonl');
 await writeFile(input,'title,url,latitude,longitude\nSynthetic,,,139\n');
 const r=await normalizeInputs({input,output,report:path.join(d,'report.json'),allowCoordinatePins:true});assert.equal(r.manualReview,1);assert.equal((await loadNormalized(output)).length,0);
});
