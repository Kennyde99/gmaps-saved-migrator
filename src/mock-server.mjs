import http from 'node:http';

const SAVE_MENU_LABEL = '\u30ea\u30b9\u30c8\u306b\u4fdd\u5b58';

function escapeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function page({ placeId, account, listNames, preseed, preseedByPlace, virtualized, coverageMode, decoyMenu, hiddenDuplicateRow, duplicateSaveMenuRoot, menuRootLabel }) {
  const encoded = JSON.stringify({ placeId, account, listNames, preseed, preseedByPlace, virtualized, decoyMenu, hiddenDuplicateRow, duplicateSaveMenuRoot }).replaceAll('<', '\\u003c');
  const title = String(placeId).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const rootLabel = escapeAttribute(menuRootLabel);
  return `<!doctype html>
<html lang="ja"><meta charset="utf-8"><title>模擬 Maps - ${title}</title>
<style>body{font-family:sans-serif;margin:2rem}button,[role=menuitemradio]{padding:.7rem;margin:.3rem;border:1px solid #888;background:white}[hidden]{display:none!important}#menu.virtual{position:relative;height:180px;overflow-y:auto;padding:0;width:28rem}[aria-checked=true]{background:#d7f5dc}</style>
<body data-list-coverage="${coverageMode}"><button aria-label="Google Account: Synthetic User (${account})">Synthetic account</button>
<h1>${title}</h1><button data-testid="save-menu-button" aria-label="保存">保存</button><div id="menu" role="menu" aria-label="${rootLabel}" hidden></div>
<div id="decoy-menu" role="menu" aria-label="Other menu" ${decoyMenu ? '' : 'hidden'}></div>
<div id="duplicate-save-menu" role="menu" aria-label="${SAVE_MENU_LABEL}" ${duplicateSaveMenuRoot ? '' : 'hidden'}></div>
<script>
const config=${encoded};
const key='mock-saved-v1';
let saved=JSON.parse(localStorage.getItem(key)||'{}');
if(!localStorage.getItem('mock-preseeded')){for(const id of config.preseed){saved[id]=['移行先'];}for(const [id,lists] of Object.entries(config.preseedByPlace)){saved[id]=[...lists];}localStorage.setItem(key,JSON.stringify(saved));localStorage.setItem('mock-preseeded','1');}
const menu=document.querySelector('#menu');
function populateRow(row,name,checked){row.setAttribute('role','menuitemradio');row.setAttribute('aria-checked',String(checked));const icon=document.createElement('div');icon.innerText=checked?'◆\\n✓':'◆';const details=document.createElement('div');details.innerText=name+'\\n非公開';row.append(icon,details);return row;}
function render(){const rows=config.listNames.map(name=>{const checked=(saved[config.placeId]||[]).includes(name);const row=populateRow(document.createElement('button'),name,checked);row.onclick=()=>{const lists=new Set(saved[config.placeId]||[]);checked?lists.delete(name):lists.add(name);saved[config.placeId]=[...lists];localStorage.setItem(key,JSON.stringify(saved));render();};return row;});if(config.hiddenDuplicateRow&&config.listNames.length){const hidden=populateRow(document.createElement('button'),config.listNames[0],false);hidden.hidden=true;const ariaHidden=populateRow(document.createElement('button'),config.listNames[0],false);ariaHidden.setAttribute('aria-hidden','true');const transparent=populateRow(document.createElement('button'),config.listNames[0],false);transparent.style.opacity='0';rows.push(hidden,ariaHidden,transparent);}menu.replaceChildren(...rows);}
function renderNoise(){if(config.decoyMenu&&config.listNames.length){const row=populateRow(document.createElement('button'),config.listNames[0],false);row.onclick=()=>{document.body.dataset.decoyClicked='true';};document.querySelector('#decoy-menu').replaceChildren(row);}if(config.duplicateSaveMenuRoot&&config.listNames.length){document.querySelector('#duplicate-save-menu').replaceChildren(populateRow(document.createElement('button'),config.listNames[0],false));}}
const ITEM_HEIGHT=48;
function makeVirtualRow(name,index){const checked=(saved[config.placeId]||[]).includes(name);const row=populateRow(document.createElement('button'),name,checked);row.onclick=()=>{const lists=new Set(saved[config.placeId]||[]);checked?lists.delete(name):lists.add(name);saved[config.placeId]=[...lists];localStorage.setItem(key,JSON.stringify(saved));renderCurrent();};return row;}
function renderVirtual(){menu.classList.add('virtual');const start=Math.max(0,Math.floor(menu.scrollTop/ITEM_HEIGHT)-1);const end=Math.min(config.listNames.length,start+7);const spacer=document.createElement('div');spacer.style.height=(config.listNames.length*ITEM_HEIGHT)+'px';spacer.style.pointerEvents='none';const rows=config.listNames.slice(start,end).map((name,offset)=>{const index=start+offset;const row=makeVirtualRow(name,index);row.style.position='absolute';row.style.left='0';row.style.top=(index*ITEM_HEIGHT)+'px';row.style.height=(ITEM_HEIGHT-4)+'px';row.style.width='26rem';return row;});menu.replaceChildren(spacer,...rows);}
function renderCurrent(){if(config.virtualized)renderVirtual();else{menu.classList.remove('virtual');render();}}
menu.addEventListener('scroll',()=>{if(config.virtualized)renderVirtual();});
document.querySelector('[data-testid=save-menu-button]').onclick=()=>{menu.hidden=!menu.hidden;if(!menu.hidden)renderCurrent();};
document.addEventListener('keydown',event=>{if(event.key==='Escape')menu.hidden=true;});
renderNoise();
</script></body></html>`;
}

export async function startMockServer({ port = 0, account = 'pilot@example.test', listNames = ['移行先', 'お気に入り'], preseed = [], preseedByPlace = {}, virtualized = false, coverageMode = 'complete', decoyMenu = false, hiddenDuplicateRow = false, duplicateSaveMenuRoot = false, menuRootLabel = SAVE_MENU_LABEL } = {}) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    if (url.pathname === '/fault/403') { response.writeHead(403); response.end('Forbidden'); return; }
    if (url.pathname === '/fault/429') { response.writeHead(429); response.end('Too Many Requests'); return; }
    if (url.pathname === '/fault/captcha') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<p>Our systems have detected unusual traffic</p><iframe class="captcha" srcdoc="local synthetic captcha"></iframe>');
      return;
    }
    if (url.pathname === '/fault/login') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<p>Sign in to continue to Google Maps</p>');
      return;
    }
    if (url.pathname === '/fault/ui') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<button aria-label="Google Account: Synthetic User (${account})">Account</button><p>UI changed</p>`);
      return;
    }
    const placeId = url.searchParams.get('query_place_id') || url.pathname.split('/').filter(Boolean).at(-1) || 'unknown';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(page({ placeId, account, listNames, preseed, preseedByPlace, virtualized, coverageMode, decoyMenu, hiddenDuplicateRow, duplicateSaveMenuRoot, menuRootLabel }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export function rewriteForMock(navigationUrl, baseUrl, identity) {
  const source = new URL(navigationUrl);
  const target = new URL('/maps/search/', baseUrl);
  for (const [key, value] of source.searchParams) target.searchParams.set(key, value);
  if (identity) target.searchParams.set('mock_identity', identity);
  return target.toString();
}
