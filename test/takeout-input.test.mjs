import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeInputs } from '../src/normalize.mjs';
for (const [name,error] of [['archive_browser.html',/TAKEOUT_INDEX_NOT_DATA/],['archive_browser.HTML',/TAKEOUT_INDEX_NOT_DATA/],['takeout.zip',/TAKEOUT_EXTRACT_REQUIRED/],['readme.txt',/UNSUPPORTED_INPUT_FILE/]]) {
 test(`actionable diagnostic for ${name}, no output created`, async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'maps-takeout-'));const input=path.join(dir,name),output=path.join(dir,'out.jsonl'),report=path.join(dir,'report.json');
  await writeFile(input,'synthetic only');
  await assert.rejects(()=>normalizeInputs({input,output,report}),error);
  for(const f of [output,report]) await assert.rejects(()=>access(f),{code:'ENOENT'});
 });
}
test('HTML-only folder reports absent data, never zero successful migration',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'maps-takeout-'));
 await writeFile(path.join(dir,'archive_browser.html'),'<html>synthetic</html>');
 await assert.rejects(()=>normalizeInputs({input:dir,output:path.join(dir,'out.jsonl'),report:path.join(dir,'report.json')}),/TAKEOUT_DATA_NOT_FOUND/);
});
