import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { applyEnvironment } from '../src/config.mjs';
import { matchesResolvedPlace } from '../src/live-identity.mjs';
import { BrowserSession } from '../src/browser.mjs';

test('environment config never enables execution or supplies confirmation', () => {
 const o = applyEnvironment({'target-list':'explicit'}, {GMAPS_TARGET_ACCOUNT:'target@example.test',GMAPS_TARGET_LIST:'ignored',GMAPS_EXECUTE:'true',GMAPS_PASSWORD:'secret'});
 assert.deepEqual(o, {'target-list':'explicit','expected-account':'target@example.test'});
});
const record=(kind,value)=>({identityKind:kind,identity:`${kind}:${value}`});
test('resolved identity checks exact data tokens, never input echoes or substrings',()=>{
 assert.equal(matchesResolvedPlace(record('cid','123'), 'https://www.google.com/maps/place/X/data=!1s0xab:0x7b!2sY'),true);
 assert.equal(matchesResolvedPlace(record('cid','12'), 'https://www.google.com/maps/place/X/data=!1s0xab:0x7b!2sY'),false);
 assert.equal(matchesResolvedPlace(record('place_id','abc'), 'https://www.google.com/maps/place/X/data=!1sabc!2sY'),true);
 for(const url of ['https://www.google.com/maps/place/X/data=!1sabcdef!2sY','https://www.google.com/maps/?query_place_id=abc','https://example.invalid/maps/data=!1sabc']) assert.equal(matchesResolvedPlace(record('place_id','abc'),url),false);
 assert.equal(matchesResolvedPlace(record('coordinate_pin','35,139'),'https://www.google.com/maps/@35,139,15z'),false);
});
function fakeBrowser(labels) {
 const browser = new BrowserSession({on(){}}, {}, null, null, 0, 0);
 browser.evaluate = async expression => vm.runInNewContext(expression, {
  location:{protocol:'https:',hostname:'www.google.com'},
  getComputedStyle:node=>({display:node.invisible?'none':'block',visibility:'visible',opacity:'1'}),
  document:{querySelectorAll:()=>labels.map(x=>({isConnected:true, parentElement:null, invisible:x.hidden,getClientRects:()=>[{}],getAttribute:key=>key==='aria-label'?x.text:null}))}
 });return browser;
}
test('active avatar must be visible, unique and exact, inactive accounts do not authorize',async()=>{
 await fakeBrowser([{text:'Google Account: Name (target@example.test)'}]).verifyAccount('target@example.test');
 for(const labels of [
  [{text:'target@example.test'}],
  [{text:'Google Account: Name (other@example.test)'},{text:'Google Account: Name (target@example.test)',hidden:true}],
  [{text:'Google Account: Name (target@example.test)'},{text:'Google Account: Name (other@example.test)'}],
  [{text:'Google Account: Name (target@example.test)',hidden:true}]
 ]) await assert.rejects(()=>fakeBrowser(labels).verifyAccount('target@example.test'),/ACCOUNT_MISMATCH/);
});

function menuBrowser({busy=false,hidden=false,ancestorClip=false,viewportClip=false,footerMissing=false}={}) {
 const rect=(top,bottom)=>({top,bottom,left:0,right:200});
 const node=(text,r,attrs={})=>({innerText:text,isConnected:true,parentElement:null,children:[],offsetHeight:20,offsetWidth:200,clientHeight:100,scrollHeight:100,
 getBoundingClientRect:()=>r,getClientRects:()=>[r],getAttribute:k=>attrs[k]??null,
 matches:s=>s==='[aria-busy="true"]'&&attrs['aria-busy']==='true',querySelector:()=>null,querySelectorAll:()=>[]});
 const parent=node('',rect(0,ancestorClip?30:300)); parent.style={overflowY:ancestorClip?'hidden':'visible'};
 const root=node('',rect(0,viewportClip?900:100),{'aria-label':'Save to list','aria-busy':busy?'true':'false'});root.parentElement=parent;
 const row=node('GMAPS-MIGRATION-TEST',rect(10,40),{'aria-checked':'false'});row.parentElement=root;
 const extra=node('hidden',rect(40,50),{'aria-checked':'false'});extra.parentElement=root;extra.hidden=true;
 const footer=node('New list',rect(60,80));footer.parentElement=root;
 root.querySelectorAll=s=>s==='*'?[row,footer] : s.startsWith('button')?(footerMissing?[]:[footer]):hidden?[row,extra]:[row];
 root.contains=()=>true;
 const browser=new BrowserSession({on(){}},{},null,null,0,0);
 browser.evaluate=async expression=>vm.runInNewContext(expression,{
 location:{hostname:'www.google.com'},innerHeight:800,innerWidth:1200,
 document:{querySelectorAll:()=>[root],body:{dataset:{}}},
 getComputedStyle:n=>({display:'block',visibility:'visible',opacity:'1',overflowY:'visible',overflowX:'visible',...n.style})
 });return browser;
}
test('finite-menu evidence rejects busy, hidden rows, clipping and absent footer', async()=>{
 assert.equal((await menuBrowser().inspectListViewport('GMAPS-MIGRATION-TEST')).finiteMenu,true);
 for(const opts of [{busy:true},{hidden:true},{ancestorClip:true},{viewportClip:true},{footerMissing:true}]) assert.equal((await menuBrowser(opts).inspectListViewport('GMAPS-MIGRATION-TEST')).finiteMenu,false,JSON.stringify(opts));
});
test('mock account still ignores unrelated aria labels', async()=>{
 const b=fakeBrowser([{text:'Google Account: Name (target@example.test)'},{text:'Save'}]);
 const evaluate=b.evaluate;
 b.evaluate=expr=>evaluate(expr.replace("['127.0.0.1', 'localhost'].includes(location.hostname)", "true"));
 await b.verifyAccount('target@example.test',{mock:true});
});
