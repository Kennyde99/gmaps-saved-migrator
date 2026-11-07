import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { assertSafeDedicatedProfile, sleep } from './util.mjs';

const KNOWN_BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

async function exists(filename) {
  try { await access(filename); return true; } catch { return false; }
}

async function chooseBrowser(explicit) {
  if (explicit) {
    const absolute = path.resolve(explicit);
    if (!await exists(absolute)) throw new Error(`ブラウザーが見つかりません: ${absolute}`);
    return absolute;
  }
  for (const candidate of KNOWN_BROWSERS) if (await exists(candidate)) return candidate;
  throw new Error('Chrome / Edge が見つかりません。--browser で実行ファイルを指定してください。');
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function prepareProfile(profilePath) {
  const profile = assertSafeDedicatedProfile(profilePath);
  const marker = path.join(profile, '.gmaps-migrator-profile.json');
  await mkdir(profile, { recursive: true });
  if (!await exists(marker)) {
    const entries = await import('node:fs/promises').then((fs) => fs.readdir(profile));
    if (entries.length > 0) throw new Error('専用プロファイルのマーカーがなく、ディレクトリも空ではありません。既存データは使用しません。');
    await writeFile(marker, `${JSON.stringify({ purpose: 'gmaps-saved-migrator-dedicated-profile', createdAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' });
  } else {
    const data = JSON.parse(await readFile(marker, 'utf8'));
    if (data.purpose !== 'gmaps-saved-migrator-dedicated-profile') throw new Error('専用プロファイルのマーカーが一致しません');
  }
  return profile;
}

// Dependency-free RFC 6455 client for the loopback-only DevTools endpoint.
// Some managed Windows builds close Node's built-in WebSocket without returning
// CDP responses; the small client below keeps the transport auditable and local.
class LocalWebSocket {
  constructor(rawUrl) {
    const url = new URL(rawUrl);
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      throw new Error('DevTools WebSocket は loopback ws:// のみ許可されます');
    }
    this.url = url;
    this.buffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.fragmentOpcode = null;
    this.fragments = [];
    this.socket = net.createConnection({ host: '127.0.0.1', port: Number(url.port) });
    this.socket.on('connect', () => this.#handshake());
    this.socket.on('data', (chunk) => this.#consume(chunk));
    this.socket.on('error', (error) => this.onerror?.(error));
    this.socket.on('close', () => this.onclose?.());
  }

  #handshake() {
    this.key = randomBytes(16).toString('base64');
    this.socket.write([
      `GET ${this.url.pathname}${this.url.search} HTTP/1.1`,
      `Host: 127.0.0.1:${this.url.port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${this.key}`,
      'Sec-WebSocket-Version: 13',
      'Origin: http://127.0.0.1',
      '\r\n'
    ].join('\r\n'));
  }

  #consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshakeDone) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const headers = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 4);
      if (!/^HTTP\/1\.1 101 /i.test(headers)) {
        this.onerror?.(new Error(`DevTools WebSocket handshake failed: ${headers.split('\r\n')[0]}`));
        this.socket.destroy();
        return;
      }
      const expected = createHash('sha1').update(`${this.key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      const accepted = headers.match(/^Sec-WebSocket-Accept:\s*(.+)$/im)?.[1]?.trim();
      if (accepted !== expected) {
        this.onerror?.(new Error('DevTools WebSocket accept key mismatch'));
        this.socket.destroy();
        return;
      }
      this.handshakeDone = true;
      this.onopen?.();
    }
    while (this.#readFrame()) {}
  }

  #readFrame() {
    if (this.buffer.length < 2) return false;
    const first = this.buffer[0];
    const second = this.buffer[1];
    const fin = Boolean(first & 0x80);
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return false;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return false;
      const longLength = this.buffer.readBigUInt64BE(2);
      if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame is too large');
      length = Number(longLength);
      offset = 10;
    }
    const maskLength = masked ? 4 : 0;
    if (this.buffer.length < offset + maskLength + length) return false;
    const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
    this.buffer = this.buffer.subarray(offset + length);
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    if (opcode === 0x8) { this.socket.end(); return this.buffer.length > 0; }
    if (opcode === 0x9) { this.socket.write(this.#frame(payload, 0xA)); return this.buffer.length > 0; }
    if (opcode === 0xA) return this.buffer.length > 0;
    if (opcode === 0x1 || opcode === 0x2) {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
    } else if (opcode === 0x0 && this.fragmentOpcode !== null) {
      this.fragments.push(payload);
    }
    if (fin && this.fragmentOpcode !== null) {
      const message = Buffer.concat(this.fragments);
      const type = this.fragmentOpcode;
      this.fragmentOpcode = null;
      this.fragments = [];
      this.onmessage?.({ data: type === 0x1 ? message.toString('utf8') : message });
    }
    return this.buffer.length > 0;
  }

  #frame(data, opcode = 0x1) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const mask = randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
    return Buffer.concat([header, mask, masked]);
  }

  send(data) {
    if (!this.handshakeDone) throw new Error('WebSocket is not open');
    this.socket.write(this.#frame(data));
  }

  close() {
    if (this.handshakeDone && !this.socket.destroyed) this.socket.write(this.#frame(Buffer.alloc(0), 0x8));
    this.socket.end();
  }
}

class Cdp {
  constructor(webSocketUrl) {
    const localUrl = webSocketUrl.replace('://localhost:', '://127.0.0.1:');
    this.ws = new LocalWebSocket(localUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DevTools WebSocket 接続がタイムアウトしました')), 10000);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error('DevTools WebSocket に接続できません')); };
    });
    this.ws.onmessage = (message) => {
      const data = JSON.parse(String(message.data));
      if (process.env.GMAPS_MIGRATOR_DEBUG) console.error('CDP <<', data.id ?? data.method, data.sessionId ?? 'browser');
      if (data.id) {
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id);
        if (data.error) pending.reject(new Error(data.error.message));
        else pending.resolve(data.result);
      } else if (data.method) {
        for (const listener of this.listeners.get(data.method) ?? []) listener(data.params ?? {}, data.sessionId);
      }
    };
    this.ws.onclose = () => {
      for (const pending of this.pending.values()) pending.reject(new Error('DevTools WebSocket が閉じました'));
      this.pending.clear();
    };
  }

  async send(method, params = {}, sessionId) {
    await this.ready;
    const id = this.nextId++;
    let timer;
    const result = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools command timeout: ${method}`));
      }, 15000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });
    if (process.env.GMAPS_MIGRATOR_DEBUG) console.error('CDP >>', id, method, sessionId ?? 'browser');
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return result;
  }

  on(method, callback) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(callback);
    return () => this.listeners.get(method)?.delete(callback);
  }

  async waitFor(method, timeoutMs = 30000, sessionId) {
    return new Promise((resolve, reject) => {
      const cleanup = this.on(method, (params, eventSessionId) => {
        if (sessionId && eventSessionId !== sessionId) return;
        clearTimeout(timer);
        cleanup();
        resolve(params);
      });
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${method} を ${timeoutMs}ms 待ちましたが応答がありません`));
      }, timeoutMs);
    });
  }

  close() { this.ws.close(); }
}

async function waitForEndpoint(port, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`ブラウザーが起動直後に終了しました (code=${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const version = await response.json();
        if (version.webSocketDebuggerUrl) return version;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error('専用ブラウザーの DevTools 接続待ちがタイムアウトしました');
}

export async function launchDedicatedBrowser({ profilePath, browserPath, headless = false }) {
  const profile = await prepareProfile(profilePath);
  const executable = await chooseBrowser(browserPath);
  const port = await reservePort();
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    // Port is bound to loopback only; allow only this client's fixed Origin.
    '--remote-allow-origins=http://127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--window-size=1280,900',
    'about:blank'
  ];
  // --no-sandbox is restricted to the explicit headless/mock test path. It is
  // never used for the visible real-account browser.
  if (headless) args.unshift(
    '--headless=new',
    '--disable-gpu-sandbox',
    '--use-angle=swiftshader',
    '--no-sandbox',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--no-pings',
    '--metrics-recording-only'
  );
  const child = spawn(executable, args, { stdio: process.env.GMAPS_MIGRATOR_DEBUG ? 'inherit' : 'ignore', windowsHide: headless });
  const endpoint = await waitForEndpoint(port, child);
  if (process.env.GMAPS_MIGRATOR_DEBUG) console.error('DevTools endpoint', endpoint.webSocketDebuggerUrl);
  const listResponse = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await listResponse.json();
  const target = targets.find((item) => item.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error('ブラウザーのページtargetが見つかりません');
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await Promise.all([
    cdp.send('Page.enable'),
    cdp.send('Runtime.enable'),
    cdp.send('Network.enable')
  ]);
  const session = new BrowserSession(cdp, child, undefined, target.id, headless ? 0 : 350, headless ? 0 : 1500);
  if (headless) await session.enableLocalOnlyNetwork();
  return session;
}

export class BrowserSession {
  constructor(cdp, child, sessionId, targetId, shortDelayMs = 350, persistenceDelayMs = 1500) {
    this.cdp = cdp;
    this.child = child;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.shortDelayMs = shortDelayMs;
    this.persistenceDelayMs = persistenceDelayMs;
    this.mainStatus = null;
    this.localOnlyNetwork = false;
    this.externalNetworkAttempts = [];
    this.blockedExternalRequests = [];
    this.cdp.on('Network.responseReceived', ({ type, response }, eventSessionId) => {
      if (eventSessionId !== this.sessionId) return;
      if (type === 'Document' && this.mainStatus === null) this.mainStatus = response.status;
    });
    this.cdp.on('Network.requestWillBeSent', ({ request }, eventSessionId) => {
      if (eventSessionId !== this.sessionId || !this.localOnlyNetwork) return;
      try {
        const url = new URL(request.url);
        if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname)) {
          this.externalNetworkAttempts.push(request.url);
        }
      } catch {}
    });
    this.cdp.on('Fetch.requestPaused', ({ requestId, request }, eventSessionId) => {
      if (eventSessionId !== this.sessionId || !this.localOnlyNetwork) return;
      let local = false;
      try {
        const url = new URL(request.url);
        local = !['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost'].includes(url.hostname);
      } catch {}
      if (local) {
        void this.cdp.send('Fetch.continueRequest', { requestId }, this.sessionId).catch(() => {});
      } else {
        this.blockedExternalRequests.push(request.url);
        void this.cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, this.sessionId).catch(() => {});
      }
    });
  }

  async enableLocalOnlyNetwork() {
    this.localOnlyNetwork = true;
    await this.cdp.send('Fetch.enable', {
      patterns: [
        { urlPattern: 'http://*', requestStage: 'Request' },
        { urlPattern: 'https://*', requestStage: 'Request' }
      ]
    }, this.sessionId);
  }

  networkAudit() {
    return {
      mode: this.localOnlyNetwork ? 'localhost_only' : 'normal',
      externalAttempts: [...this.externalNetworkAttempts],
      blockedExternalRequests: [...this.blockedExternalRequests]
    };
  }

  async evaluate(expression) {
    const result = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, this.sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'ページ内スクリプトで例外が発生しました');
    return result.result?.value;
  }

  async navigate(url, timeoutMs = 30000) {
    this.mainStatus = null;
    const loaded = this.cdp.waitFor('Page.domContentEventFired', Math.min(timeoutMs, 10000), this.sessionId).catch(() => null);
    const result = await this.cdp.send('Page.navigate', { url }, this.sessionId);
    if (result.errorText) throw new Error(`ページを開けません: ${result.errorText}`);
    await loaded;
    await sleep(this.shortDelayMs);
    return this.detectBlocker();
  }

  async detectBlocker() {
    if (this.mainStatus === 403 || this.mainStatus === 429) return { blocked: true, reason: `http_${this.mainStatus}` };
    return this.evaluate(`(() => {
      const url = location.href;
      const text = (document.body?.innerText || '').slice(0, 20000);
      const lower = text.toLowerCase();
      if (/accounts\\.google\\./.test(url) || /\\bsign in\\b/i.test(text) || text.includes('ログイン')) return {blocked:true, reason:'login_required', url};
      if (document.querySelector('iframe[src*="recaptcha"], [class*="captcha" i]') || lower.includes('unusual traffic') || text.includes('通常と異なるトラフィック')) return {blocked:true, reason:'captcha_or_unusual_traffic', url};
      return {blocked:false, url};
    })()`);
  }

  async verifyAccount(expectedEmail) {
    const result = await this.evaluate(`(() => {
      const found = new Set();
      for (const el of document.querySelectorAll('[aria-label], [data-email]')) {
        const text = [el.getAttribute('aria-label'), el.getAttribute('data-email')].filter(Boolean).join(' ');
        for (const match of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi)) found.add(match[0].toLowerCase());
      }
      return [...found];
    })()`);
    const expected = expectedEmail.toLowerCase();
    if (!result.includes(expected)) {
      throw new Error(`ACCOUNT_MISMATCH: 画面から対象アカウントを本人確認できません (検出=${result.length})`);
    }
    return { verified: true, email: expected };
  }

  async verifyPlaceIdentity(record, { mock = false } = {}) {
    const href = await this.evaluate('location.href');
    let url;
    try { url = new URL(href); } catch { return { verified: false, reason: 'final_url_invalid' }; }
    const separator = record.identity.indexOf(':');
    const value = record.identity.slice(separator + 1);
    if (mock) {
      const fullMockIdentity = url.searchParams.get('mock_identity');
      if (fullMockIdentity) return { verified: fullMockIdentity === record.identity, reason: fullMockIdentity === record.identity ? null : 'mock_identity_mismatch' };
      const mockValue = record.identityKind === 'coordinate_pin'
        ? url.searchParams.get('query')
        : url.searchParams.get('query_place_id') || url.searchParams.get('place_id') || url.searchParams.get('cid') || url.searchParams.get('ludocid') || url.searchParams.get('ftid');
      return { verified: mockValue === value, reason: mockValue === value ? null : 'mock_identity_mismatch' };
    }

    if (url.protocol !== 'https:' || !/^(?:www\.|maps\.)?google\.(?:com|[a-z]{2}|(?:com|co)\.[a-z]{2})$/i.test(url.hostname)) {
      return { verified: false, reason: 'final_host_not_google_maps' };
    }
    const evidenceUrl = new URL(url);
    for (const key of ['query_place_id', 'place_id', 'cid', 'ludocid', 'ftid', 'query']) evidenceUrl.searchParams.delete(key);
    let material = `${evidenceUrl.pathname}${evidenceUrl.search}${evidenceUrl.hash}`;
    try { material = decodeURIComponent(material); } catch {}
    let verified = false;
    if (record.identityKind === 'place_id' || record.identityKind === 'ftid' || record.identityKind === 'maps_data_id') {
      verified = material.includes(value);
    } else if (record.identityKind === 'cid') {
      try {
        const hex = BigInt(value).toString(16);
        verified = material.toLowerCase().includes(`:0x${hex}`) || material.includes(value);
      } catch { verified = false; }
    } else if (record.identityKind === 'coordinate_pin') {
      verified = material.includes(value);
    }
    return { verified, reason: verified ? null : 'final_page_identity_not_confirmed' };
  }

  async pressEscape() {
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, this.sessionId);
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, this.sessionId);
  }

  async openSaveMenu() {
    const opened = await this.evaluate(`(() => {
      const selectors = [
        '[data-testid="save-menu-button"]',
        'button[jsaction*="pane.placeActions.save"]',
        'button[data-value="Save"]',
        'button[aria-label^="Save"]',
        'button[aria-label^="保存"]'
      ];
      const visible = (el) => {
        if (!el || !el.isConnected) return false;
        for (let node = el; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || /hidden|collapse/.test(style.visibility) || Number(style.opacity) === 0) return false;
        }
        return Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      };
      const items = [...new Set(selectors.flatMap((s) => [...document.querySelectorAll(s)]))].filter(visible);
      if (items.length !== 1) return {ok:false, reason:'save_button_count', count:items.length};
      items[0].click();
      return {ok:true};
    })()`);
    if (!opened.ok) throw new Error(`UI_MISMATCH:${opened.reason}:${opened.count}`);
    await sleep(this.shortDelayMs);
  }

  async inspectTargetList(targetList) {
    const encoded = JSON.stringify(targetList.normalize('NFC').trim());
    return this.evaluate(`(() => {
      const wanted = ${encoded};
      const norm = (s) => String(s || '').normalize('NFC').trim();
      const visible = (el) => {
        if (!el || !el.isConnected) return false;
        for (let node = el; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || /hidden|collapse/.test(style.visibility) || Number(style.opacity) === 0) return false;
        }
        return Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      };
      const expectedRootLabel = '\u30ea\u30b9\u30c8\u306b\u4fdd\u5b58';
      const roots = [...document.querySelectorAll('[role="menu"][aria-label]')]
        .filter((el) => visible(el) && norm(el.getAttribute('aria-label')) === expectedRootLabel);
      if (roots.length !== 1) return {ok:false, reason:'save_menu_root_count', count:roots.length};
      const candidates = [...roots[0].querySelectorAll('[role="menuitemradio"], [role="menuitemcheckbox"], [data-testid="save-list-row"], [role="option"]')].filter(visible);
      const matches = candidates.filter((el) => {
        const labels = [el.getAttribute('data-list-name'), el.getAttribute('aria-label'), ...(el.innerText || '').split(/\\r?\\n/)].map(norm);
        return labels.includes(wanted);
      });
      if (matches.length !== 1) return {ok:false, reason:'target_list_exact_match_count', count:matches.length, visibleCount:candidates.length};
      const row = matches[0];
      const control = row.matches('input') ? row : row.querySelector('input[type="checkbox"], [role="checkbox"]');
      const aria = row.getAttribute('aria-checked') ?? control?.getAttribute('aria-checked');
      const checked = aria === 'true' || control?.checked === true;
      const known = aria === 'true' || aria === 'false' || typeof control?.checked === 'boolean';
      return {ok:true, checked, checkedStateKnown:known};
    })()`);
  }

  async inspectListViewport(targetList) {
    const encoded = JSON.stringify(targetList.normalize('NFC').trim());
    return this.evaluate(`(() => {
      const wanted = ${encoded};
      const norm = (s) => String(s || '').normalize('NFC').trim();
      const visible = (el) => {
        if (!el || !el.isConnected) return false;
        for (let node = el; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || /hidden|collapse/.test(style.visibility) || Number(style.opacity) === 0) return false;
        }
        return Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      };
      const expectedRootLabel = '\u30ea\u30b9\u30c8\u306b\u4fdd\u5b58';
      const roots = [...document.querySelectorAll('[role="menu"][aria-label]')]
        .filter((el) => visible(el) && norm(el.getAttribute('aria-label')) === expectedRootLabel);
      if (roots.length !== 1) return {ok:false, reason:'save_menu_root_count', count:roots.length};
      const root = roots[0];
      const candidates = [...root.querySelectorAll('[role="menuitemradio"], [role="menuitemcheckbox"], [data-testid="save-list-row"], [role="option"]')].filter(visible);
      const scrollableAncestor = (el) => {
        for (let node = el?.parentElement; node && root.contains(node); node = node.parentElement) {
          const style = getComputedStyle(node);
          if (node.scrollHeight > node.clientHeight + 1 && /auto|scroll|overlay/.test(style.overflowY)) return node;
        }
        return null;
      };
      const scroller = candidates.map(scrollableAncestor).find(Boolean) || null;
      const scrollerRect = scroller?.getBoundingClientRect();
      const rows = candidates.map((row) => {
        const textLines = (row.innerText || '').split(/\\r?\\n/).map(norm).filter(Boolean);
        const dataName = norm(row.getAttribute('data-list-name'));
        const ariaLabel = norm(row.getAttribute('aria-label'));
        const childLabel = [...row.children]
          .map((child) => (child.innerText || '').split(/\\r?\\n/).map(norm).filter(Boolean))
          .filter((lines) => lines.length > 0)
          .at(-1)?.[0] || '';
        const labels = [...new Set([dataName, ...textLines, ariaLabel, childLabel].filter(Boolean))];
        // Current Maps rows begin with icon glyphs and put the list name in a
        // later child. Prefer semantic child text over the row's first line.
        const label = dataName || ariaLabel || childLabel || textLines.find((line) => /[\\p{L}\\p{N}]/u.test(line)) || textLines[0];
        const control = row.matches('input') ? row : row.querySelector('input[type="checkbox"], [role="checkbox"]');
        const aria = row.getAttribute('aria-checked') ?? control?.getAttribute('aria-checked');
        const checked = aria === 'true' || control?.checked === true;
        const known = aria === 'true' || aria === 'false' || typeof control?.checked === 'boolean';
        const rect = row.getBoundingClientRect();
        const globalTop = scroller ? rect.top - scrollerRect.top + scroller.scrollTop : rect.top;
        const globalLeft = scroller ? rect.left - scrollerRect.left + scroller.scrollLeft : rect.left;
        const stableId = norm(row.getAttribute('data-list-id'));
        const key = stableId ? 'id:' + stableId : 'position:' + Math.round(globalTop) + ':' + Math.round(globalLeft);
        return {key, label, labels, checked, known, globalTop, globalLeft};
      });
      const maxScrollTop = scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0;
      return {
        ok: true,
        wanted,
        rows,
        coverageHint: document.body?.dataset?.listCoverage || null,
        scroll: {
          found: Boolean(scroller),
          top: scroller?.scrollTop || 0,
          max: maxScrollTop,
          clientHeight: scroller?.clientHeight || 0,
          atStart: Boolean(scroller) && scroller.scrollTop <= 1,
          atEnd: Boolean(scroller) && scroller.scrollTop >= maxScrollTop - 1
        }
      };
    })()`);
  }

  async setListScrollTop(scrollTop) {
    return this.evaluate(`(() => {
      const norm = (s) => String(s || '').normalize('NFC').trim();
      const visible = (el) => {
        if (!el || !el.isConnected) return false;
        for (let node = el; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || /hidden|collapse/.test(style.visibility) || Number(style.opacity) === 0) return false;
        }
        return Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      };
      const expectedRootLabel = '\u30ea\u30b9\u30c8\u306b\u4fdd\u5b58';
      const roots = [...document.querySelectorAll('[role="menu"][aria-label]')]
        .filter((el) => visible(el) && norm(el.getAttribute('aria-label')) === expectedRootLabel);
      if (roots.length !== 1) return {ok:false, reason:'save_menu_root_count', count:roots.length};
      const root = roots[0];
      const candidates = [...root.querySelectorAll('[role="menuitemradio"], [role="menuitemcheckbox"], [data-testid="save-list-row"], [role="option"]')].filter(visible);
      const scrollableAncestor = (el) => {
        for (let node = el?.parentElement; node && root.contains(node); node = node.parentElement) {
          const style = getComputedStyle(node);
          if (node.scrollHeight > node.clientHeight + 1 && /auto|scroll|overlay/.test(style.overflowY)) return node;
        }
        return null;
      };
      const scroller = candidates.map(scrollableAncestor).find(Boolean) || null;
      if (!scroller) return {ok:true, found:false, moved:false, top:0, max:0};
      const before = scroller.scrollTop;
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = Math.max(0, Math.min(max, ${Number(scrollTop)}));
      scroller.dispatchEvent(new Event('scroll', {bubbles:true}));
      return {ok:true, found:true, moved:Math.abs(scroller.scrollTop - before) > 0.5, top:scroller.scrollTop, max};
    })()`);
  }

  async inspectCompleteListStates(targetList, { maxScrollSteps = 250 } = {}) {
    const observed = new Map();
    let sawStart = false;
    let sawEnd = false;
    let coverageReason = null;
    let lastTop = null;
    let stagnantSteps = 0;

    for (let step = 0; step < maxScrollSteps; step += 1) {
      const snapshot = await this.inspectListViewport(targetList);
      if (!snapshot.ok) return snapshot;
      if (snapshot.coverageHint === 'unknown') {
        coverageReason = 'page_declared_coverage_unknown';
        break;
      }
      if (snapshot.scroll.found && !snapshot.scroll.atStart && !sawStart) {
        const reset = await this.setListScrollTop(0);
        if (!reset.ok) return reset;
        await sleep(this.shortDelayMs);
        continue;
      }
      for (const row of snapshot.rows) {
        if (!row.known || !row.label) return { ok: false, reason: 'list_checked_state_unknown' };
        const prior = observed.get(row.key);
        if (prior && (prior.label !== row.label || prior.checked !== row.checked)) {
          return { ok: false, reason: 'list_scan_inconsistent_row', key: row.key };
        }
        observed.set(row.key, row);
      }

      // A non-scrollable viewport is not, by itself, proof that the complete
      // list is present. The mock may provide an explicit positive hint; the
      // live adapter has no such hint and must therefore fail closed.
      if (!snapshot.scroll.found) {
        if (snapshot.coverageHint === 'complete') {
          sawStart = true;
          sawEnd = true;
        } else {
          coverageReason = 'no_scroll_completion_evidence';
        }
        break;
      }

      sawStart ||= snapshot.scroll.atStart;
      if (snapshot.scroll.atEnd) {
        sawEnd = true;
        break;
      }

      const nextTop = Math.min(
        snapshot.scroll.max,
        snapshot.scroll.top + Math.max(80, Math.floor(snapshot.scroll.clientHeight * 0.8))
      );
      const movement = await this.setListScrollTop(nextTop);
      if (!movement.ok) {
        coverageReason = movement.reason;
        break;
      }
      if (!movement.found) {
        coverageReason = 'scroll_container_disappeared';
        break;
      }
      if (!movement.moved || movement.top === lastTop) stagnantSteps += 1;
      else stagnantSteps = 0;
      lastTop = movement.top;
      if (stagnantSteps >= 2) {
        coverageReason = 'scroll_scan_stalled';
        break;
      }
      await sleep(this.shortDelayMs);
    }

    if (!sawEnd && !coverageReason) coverageReason = 'scroll_scan_step_limit';
    const rows = [...observed.values()].sort((a, b) => a.globalTop - b.globalTop || a.key.localeCompare(b.key));
    const wanted = targetList.normalize('NFC').trim();
    const matches = rows.filter((row) => row.labels.includes(wanted));
    const coverage = sawStart && sawEnd ? 'complete' : 'unverified';
    if (coverage === 'complete' && matches.length !== 1) {
      return { ok: false, reason: 'target_list_exact_match_count', count: matches.length, observedCount: rows.length, coverage };
    }
    if (matches.length > 1) {
      return { ok: false, reason: 'target_list_exact_match_count', count: matches.length, observedCount: rows.length, coverage };
    }
    if (matches.length === 1) {
      const repositioned = await this.setListScrollTop(matches[0].globalTop);
      if (!repositioned.ok) return repositioned;
      await sleep(this.shortDelayMs);
    }
    return {
      ok: true,
      targetChecked: matches[0]?.checked ?? false,
      targetMatchCount: matches.length,
      checkedLists: rows.filter((row) => row.checked).map((row) => row.label),
      checkedRows: rows.filter((row) => row.checked).map((row) => ({ key: row.key, label: row.label })),
      coverage,
      coverageReason,
      observedCount: rows.length
    };
  }

  async inspectListStates(targetList) {
    const encoded = JSON.stringify(targetList.normalize('NFC').trim());
    return this.evaluate(`(() => {
      const wanted = ${encoded};
      const norm = (s) => String(s || '').normalize('NFC').trim();
      const visible = (el) => {
        if (!el || !el.isConnected) return false;
        for (let node = el; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || /hidden|collapse/.test(style.visibility) || Number(style.opacity) === 0) return false;
        }
        return Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      };
      const expectedRootLabel = '\u30ea\u30b9\u30c8\u306b\u4fdd\u5b58';
      const roots = [...document.querySelectorAll('[role="menu"][aria-label]')]
        .filter((el) => visible(el) && norm(el.getAttribute('aria-label')) === expectedRootLabel);
      if (roots.length !== 1) return {ok:false, reason:'save_menu_root_count', count:roots.length};
      const candidates = [...roots[0].querySelectorAll('[role="menuitemradio"], [role="menuitemcheckbox"], [data-testid="save-list-row"], [role="option"]')].filter(visible);
      const rows = candidates.map((row) => {
        const labels = [row.getAttribute('data-list-name'), row.getAttribute('aria-label'), ...(row.innerText || '').split(/\\r?\\n/)].map(norm).filter(Boolean);
        const control = row.matches('input') ? row : row.querySelector('input[type="checkbox"], [role="checkbox"]');
        const aria = row.getAttribute('aria-checked') ?? control?.getAttribute('aria-checked');
        const checked = aria === 'true' || control?.checked === true;
        const known = aria === 'true' || aria === 'false' || typeof control?.checked === 'boolean';
        return {label: labels[0] || '', labels, checked, known};
      });
      const matches = rows.filter((row) => row.labels.includes(wanted));
      if (matches.length !== 1) return {ok:false, reason:'target_list_exact_match_count', count:matches.length, visibleCount:rows.length};
      if (rows.some((row) => !row.known || !row.label)) return {ok:false, reason:'list_checked_state_unknown'};
      const coverage = document.body?.dataset?.listCoverage === 'complete' ? 'complete' : 'visible_rows_only';
      return {ok:true, targetChecked:matches[0].checked, checkedLists:rows.filter((row) => row.checked).map((row) => row.label), coverage};
    })()`);
  }

  async clickTargetList(targetList) {
    const encoded = JSON.stringify(targetList.normalize('NFC').trim());
    return this.evaluate(`(() => {
      const wanted = ${encoded};
      const norm = (s) => String(s || '').normalize('NFC').trim();
      const visible = (el) => {
        if (!el || !el.isConnected) return false;
        for (let node = el; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || /hidden|collapse/.test(style.visibility) || Number(style.opacity) === 0) return false;
        }
        return Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      };
      const expectedRootLabel = '\u30ea\u30b9\u30c8\u306b\u4fdd\u5b58';
      const roots = [...document.querySelectorAll('[role="menu"][aria-label]')]
        .filter((el) => visible(el) && norm(el.getAttribute('aria-label')) === expectedRootLabel);
      if (roots.length !== 1) return {ok:false, reason:'save_menu_root_count', count:roots.length};
      const candidates = [...roots[0].querySelectorAll('[role="menuitemradio"], [role="menuitemcheckbox"], [data-testid="save-list-row"], [role="option"]')].filter(visible);
      const matches = candidates.filter((el) => [el.getAttribute('data-list-name'), el.getAttribute('aria-label'), ...(el.innerText || '').split(/\\r?\\n/)].map(norm).includes(wanted));
      if (matches.length !== 1) return {ok:false, reason:'target_list_exact_match_count', count:matches.length};
      const row = matches[0];
      const control = row.matches('input') ? row : row.querySelector('input[type="checkbox"], [role="checkbox"]');
      const aria = row.getAttribute('aria-checked') ?? control?.getAttribute('aria-checked');
      const checked = aria === 'true' || control?.checked === true;
      const known = aria === 'true' || aria === 'false' || typeof control?.checked === 'boolean';
      if (!known) return {ok:false, reason:'checked_state_unknown_before_click'};
      // Atomic re-check: if a delayed render has made the target checked since
      // the earlier snapshot, do not click (a click would uncheck it).
      if (checked) return {ok:true, clicked:false, alreadyChecked:true};
      row.click();
      return {ok:true, clicked:true, alreadyChecked:false};
    })()`);
  }

  async ensureMenuAndInspect(targetList) {
    let state = await this.inspectTargetList(targetList);
    if (!state.ok) {
      await this.openSaveMenu();
      state = await this.inspectTargetList(targetList);
    }
    return state;
  }

  async saveToList(targetList, { requireCompleteCoverage = false, expectedCheckedRows = [] } = {}) {
    const blocker = await this.detectBlocker();
    if (blocker.blocked) return { status: 'stop', reason: blocker.reason };
    await this.openSaveMenu();
    const before = await this.inspectCompleteListStates(targetList);
    if (!before.ok) {
      await this.pressEscape();
      return { status: 'stop', reason: `ui_mismatch:${before.reason}` };
    }
    if (requireCompleteCoverage && before.coverage !== 'complete') {
      await this.pressEscape();
      return { status: 'stop', reason: 'ui_coverage_unverified' };
    }
    const rowPresent = (rows, expected) => typeof expected === 'string'
      ? rows.some((row) => row.label === expected)
      : rows.some((row) => row.key === expected.key && row.label === expected.label);
    const baselineCheckedRows = expectedCheckedRows.length > 0 ? expectedCheckedRows : before.checkedRows;
    const missingBefore = baselineCheckedRows.filter((expected) => !rowPresent(before.checkedRows, expected));
    if (missingBefore.length > 0) {
      await this.pressEscape();
      return { status: 'stop', reason: 'existing_list_membership_lost_before_resume' };
    }
    if (before.targetChecked) {
      await this.pressEscape();
      return { status: 'already_saved_verified', verified: true, baselineCheckedLists: baselineCheckedRows.map((row) => typeof row === 'string' ? row : row.label), baselineCheckedRows, baselineCoverage: before.coverage };
    }
    const clicked = await this.clickTargetList(targetList);
    if (!clicked.ok) {
      await this.pressEscape();
      return { status: 'stop', reason: `ui_mismatch:${clicked.reason}` };
    }
    if (!clicked.clicked && clicked.alreadyChecked) {
      await this.pressEscape();
      return { status: 'already_saved_verified', verified: true, baselineCheckedLists: baselineCheckedRows.map((row) => typeof row === 'string' ? row : row.label), baselineCheckedRows, baselineCoverage: before.coverage };
    }
    await sleep(this.persistenceDelayMs);
    let after = await this.inspectCompleteListStates(targetList);
    if (!after.ok) {
      await this.openSaveMenu();
      after = await this.inspectCompleteListStates(targetList);
    }
    const lostExisting = baselineCheckedRows.filter((expected) => !rowPresent(after.checkedRows ?? [], expected));
    if (!after.ok || (requireCompleteCoverage && after.coverage !== 'complete') || !after.targetChecked || lostExisting.length > 0) {
      await this.pressEscape();
      const reason = after.reason ||
        (requireCompleteCoverage && after.coverage !== 'complete' ? 'ui_coverage_unverified' : null) ||
        (lostExisting.length ? 'existing_list_membership_lost' : 'target_not_checked');
      return {
        status: 'indeterminate_after_click',
        reason: `post_click_verification_failed:${reason}`,
        verified: false,
        baselineCheckedLists: baselineCheckedRows.map((row) => typeof row === 'string' ? row : row.label),
        baselineCheckedRows,
        baselineCoverage: before.coverage
      };
    }
    await this.pressEscape();
    return { status: 'saved_verified', verified: true, baselineCheckedLists: baselineCheckedRows.map((row) => typeof row === 'string' ? row : row.label), baselineCheckedRows, baselineCoverage: before.coverage };
  }

  async verifySaved(targetList, baselineCheckedRows = [], { requireCompleteCoverage = false } = {}) {
    const blocker = await this.detectBlocker();
    if (blocker.blocked) return { status: 'stop', reason: blocker.reason };
    await this.openSaveMenu();
    const state = await this.inspectCompleteListStates(targetList);
    await this.pressEscape();
    if (!state.ok) return { status: 'stop', reason: `ui_mismatch:${state.reason}` };
    if (requireCompleteCoverage && state.coverage !== 'complete') return { status: 'stop', reason: 'ui_coverage_unverified' };
    const rowPresent = (rows, expected) => typeof expected === 'string'
      ? rows.some((row) => row.label === expected)
      : rows.some((row) => row.key === expected.key && row.label === expected.label);
    const lostExisting = baselineCheckedRows.filter((expected) => !rowPresent(state.checkedRows, expected));
    if (lostExisting.length > 0) return { status: 'stop', reason: 'existing_list_membership_lost' };
    return { status: state.targetChecked ? 'saved_verified' : 'not_saved', verified: state.targetChecked, checkedLists: state.checkedLists, checkedRows: state.checkedRows, coverage: state.coverage };
  }

  async close() {
    if (this.child.exitCode === null) {
      const exited = new Promise((resolve) => this.child.once('exit', resolve));
      // Give Chromium a chance to flush the dedicated profile (notably the
      // user's own login completed in the visible setup step).
      try { await Promise.race([this.cdp.send('Browser.close'), sleep(1000)]); } catch {}
      await Promise.race([exited, sleep(3000)]);
      if (this.child.exitCode === null) this.child.kill();
    }
    try { this.cdp.close(); } catch {}
  }
}
