import { createHash, randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq !== -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    if (key.startsWith('no-')) {
      out[key.slice(3)] = false;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      out[key] = argv[++i];
    } else {
      out[key] = true;
    }
  }
  return out;
}

export function asInt(value, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`整数オプションが範囲外です: ${value} (${min}..${max})`);
  }
  return n;
}

export async function atomicWriteJson(filename, value) {
  const absolute = path.resolve(filename);
  await mkdir(path.dirname(absolute), { recursive: true });
  // Exclusive creation is deliberate: user files and prior reports are never
  // replaced. Callers must select a new output name for each run.
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function jitteredSleep(baseMs, jitterMs) {
  const delta = jitterMs > 0 ? randomInt(-jitterMs, jitterMs + 1) : 0;
  await sleep(Math.max(0, baseMs + delta));
}

export function cleanEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function assertSafeDedicatedProfile(profilePath) {
  const absolute = path.resolve(profilePath);
  const lowered = absolute.toLowerCase().replaceAll('/', '\\');
  const forbidden = [
    '\\google\\chrome\\user data',
    '\\microsoft\\edge\\user data',
    '\\mozilla\\firefox\\profiles'
  ];
  if (forbidden.some((part) => lowered.includes(part))) {
    throw new Error('既存ブラウザープロファイルに見えるパスは使用できません。専用の空ディレクトリを指定してください。');
  }
  const root = path.parse(absolute).root;
  if (absolute === root || absolute.length < root.length + 8) {
    throw new Error('プロファイルのパスが広すぎます。専用サブディレクトリを指定してください。');
  }
  return absolute;
}

export function redactEmail(email) {
  const [local, domain] = cleanEmail(email).split('@');
  if (!domain) return '(不明)';
  return `${local.slice(0, 2)}***@${domain}`;
}
