import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCsv } from './csv.mjs';
import { atomicWriteJson } from './util.mjs';

const URL_HEADERS = new Set(['url', 'item_content_url', 'google maps url', 'google_maps_url']);
const TITLE_HEADERS = ['title', 'name', 'business name', 'business_name'];

function headerName(value) {
  return String(value ?? '').trim().toLowerCase();
}

function findCsvHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 8); i += 1) {
    const names = rows[i].map(headerName);
    if (names.some((name) => URL_HEADERS.has(name)) && names.some((name) => TITLE_HEADERS.includes(name))) {
      return i;
    }
  }
  return -1;
}

function objectFromRow(headers, values) {
  const object = Object.create(null);
  headers.forEach((header, index) => {
    object[headerName(header)] = values[index] ?? '';
  });
  return object;
}

function first(object, names) {
  for (const name of names) {
    const value = object[headerName(name)];
    if (value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

// URL aliases describe one source location, not an ordered list of alternatives.
// Preserve the existing priority only when nonempty aliases agree. Different
// identity schemes cannot be equated offline and must be resolved by the owner.
function csvUrl(object, sourceFile, sourceIndex) {
  const values = [...new Set([...URL_HEADERS]
    .map((name) => String(object[name] ?? '').trim()).filter(Boolean))];
  if (values.length > 1) {
    const identities = values.map((value) => inspectMapsUrl(value));
    if (!identities.every((item) => item.actionable && item.identity === identities[0].identity)) {
      throw new Error(`${sourceFile}: CSV レコード ${sourceIndex} の URL 別名列が競合、または同一地点と確認できません`);
    }
  }
  return values[0] ?? '';
}

function flatten(value, prefix = '', output = {}) {
  if (value === null || value === undefined) return output;
  if (typeof value !== 'object') {
    output[prefix.toLowerCase()] = String(value);
    return output;
  }
  if (Array.isArray(value)) return output;
  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}

function flattenedFirst(object, suffixes) {
  for (const [key, value] of Object.entries(object)) {
    if (suffixes.some((suffix) => key === suffix || key.endsWith(`.${suffix}`)) && String(value).trim()) {
      return String(value).trim();
    }
  }
  return '';
}

function officialGoogleMapsHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'maps.app.goo.gl' || host === 'goo.gl') return true;
  const labels = host.split('.');
  if (labels[0] === 'www' || labels[0] === 'maps') labels.shift();
  if (labels.shift() !== 'google') return false;
  return (labels.length === 1 && (labels[0] === 'com' || /^[a-z]{2}$/.test(labels[0]))) ||
    (labels.length === 2 && ['com', 'co'].includes(labels[0]) && /^[a-z]{2}$/.test(labels[1]));
}

export function inspectMapsUrl(rawUrl) {
  const text = String(rawUrl ?? '').trim();
  if (!text) return { actionable: false, reason: 'url_missing' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { actionable: false, reason: 'url_invalid' };
  }
  if (url.protocol !== 'https:') return { actionable: false, reason: 'url_not_https' };
  if (!officialGoogleMapsHost(url.hostname)) return { actionable: false, reason: 'url_not_google_maps' };
  if (url.hostname === 'maps.app.goo.gl' || url.hostname === 'goo.gl') {
    return { actionable: false, reason: 'short_url_requires_manual_resolution' };
  }

  // Encoded ! separators can hide another data identity from the legacy
  // token scanner. Do not guess its interpretation or silently prefer an ID.
  if (/%21/i.test(url.pathname + url.search) ||
      [...(url.pathname + url.search).matchAll(/(?:!|%21)(?:1|%31)(?:s|%73)/gi)].some((match) => match[0].includes('%'))) {
    return { actionable: false, reason: 'url_identity_encoding_requires_review' };
  }

  // One URL must describe one unambiguous supported identity. Query aliases
  // and repeated keys are evidence, not a priority list. Cross-scheme equality
  // cannot be established offline, even when their strings happen to match.
  const identities = [];
  for (const [key, kind] of [
    ['query_place_id', 'place_id'], ['place_id', 'place_id'],
    ['cid', 'cid'], ['ludocid', 'cid'], ['ftid', 'ftid']
  ]) {
    for (const value of url.searchParams.getAll(key)) {
      if (!value) continue; // Preserve the existing empty-alias fallback.
      if (kind === 'cid' && !/^\d+$/.test(value)) {
        return { actionable: false, reason: 'url_identity_invalid' };
      }
      identities.push([kind, value]);
    }
  }
  // Inspect every supported !1s token, including path and query tokens.
  // A malformed percent escape is manual review, never a thrown decoder error.
  try {
    for (const [part, pattern] of [
      [url.pathname, /!1s([^!/?]+)/g], [url.search, /!1s([^!&]+)/g]
    ]) {
      for (const match of part.matchAll(pattern)) {
        identities.push(['maps_data_id', decodeURIComponent(match[1])]);
      }
    }
  } catch {
    return { actionable: false, reason: 'url_identity_invalid' };
  }
  if (!identities.length) {
    return { actionable: false, reason: 'url_has_no_exact_place_identity' };
  }
  const [identityKind, identityValue] = identities[0];
  if (identities.some(([kind, value]) => kind !== identityKind || value !== identityValue)) {
    return { actionable: false, reason: 'url_identity_conflict' };
  }

  // Delete tracking keys without URLSearchParams reserializing literal !
  // markers into encoded separators that our conservative guard must reject.
  url.search = url.search.slice(1).split('&').filter((part) => {
    const key = new URLSearchParams(part).keys().next().value ?? '';
    return !/^(utm_|g_st|entry|source)/i.test(key);
  }).join('&');
  // Input URLs are untrusted. After extracting the identity, navigate only to
  // the canonical Google-owned host rather than the input hostname.
  url.hostname = 'www.google.com';
  url.port = '';
  url.hash = '';
  const identity = `${identityKind}:${identityValue}`;
  return { actionable: true, navigationUrl: url.toString(), identity, identityKind };
}

// Reject absent and nonnumeric source values before JavaScript coercion can
// turn them into a valid zero coordinate. Decimal strings support CSV inputs.
function parseCoordinate(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return NaN;
  const number = Number(text);
  return Number.isFinite(number) ? number : NaN;
}

function coordinateCandidate(latitude, longitude, allowCoordinatePins) {
  const lat = parseCoordinate(latitude);
  const lng = parseCoordinate(longitude);
  const valid = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  if (!valid) return { actionable: false, reason: 'url_missing_and_coordinates_invalid' };
  if (!allowCoordinatePins) return { actionable: false, reason: 'coordinate_only_requires_opt_in' };
  const query = `${lat.toFixed(7)},${lng.toFixed(7)}`;
  if (query.split(',').every((part) => Number(part) === 0)) {
    return { actionable: false, reason: 'coordinates_round_to_unknown_origin' };
  }
  return {
    actionable: true,
    navigationUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`,
    identity: `coordinate:${query}`,
    identityKind: 'coordinate_pin',
    coordinateOptIn: true,
    warning: '座標ピンであり施設IDではありません'
  };
}

function baseRecord({ sourceFile, sourceIndex, listName, title, note, comment, tags, url, latitude, longitude }, options) {
  const inspected = inspectMapsUrl(url);
  const candidate = inspected.actionable ? inspected : (inspected.reason === 'url_missing'
    ? coordinateCandidate(latitude, longitude, options.allowCoordinatePins)
    : inspected);
  return {
    schemaVersion: 1,
    sourceFile,
    sourceIndex,
    listName: String(listName || '').trim(),
    title: String(title || '').trim(),
    note: String(note || '').trim(),
    comment: String(comment || '').trim(),
    tags: String(tags || '').trim(),
    originalUrl: String(url || '').trim(),
    latitude: Number.isFinite(parseCoordinate(latitude)) ? parseCoordinate(latitude) : null,
    longitude: Number.isFinite(parseCoordinate(longitude)) ? parseCoordinate(longitude) : null,
    actionable: Boolean(candidate.actionable),
    navigationUrl: candidate.navigationUrl ?? null,
    identity: candidate.identity ?? null,
    identityKind: candidate.identityKind ?? null,
    coordinateOptIn: candidate.coordinateOptIn ?? false,
    reviewReason: candidate.actionable ? null : candidate.reason,
    warning: candidate.warning ?? null
  };
}

function csvRecords(text, sourceFile, options) {
  const rows = parseCsv(text);
  const headerIndex = findCsvHeader(rows);
  if (headerIndex < 0) throw new Error(`${sourceFile}: 対応する CSV ヘッダーを検出できません`);
  const descriptor = rows.slice(0, headerIndex).flat().map((x) => x.trim()).filter(Boolean).join(' | ');
  const headers = rows[headerIndex];
  const names = headers.map(headerName);
  const nonemptyNames = names.filter(Boolean);
  if (new Set(nonemptyNames).size !== nonemptyNames.length) {
    throw new Error(`${sourceFile}: CSV ヘッダーが重複しています`);
  }
  const listName = descriptor || path.basename(sourceFile, path.extname(sourceFile));
  return rows.slice(headerIndex + 1)
    .map((row, index) => ({ row, sourceIndex: headerIndex + 2 + index }))
    .filter(({ row }) => row.some((value) => String(value).trim() !== ''))
    .map(({ row, sourceIndex }) => {
      if (row.some((value, index) => value !== '' && (index >= headers.length || !names[index]))) {
        throw new Error(`${sourceFile}: CSV レコード ${sourceIndex} にヘッダーのない非空列があります`);
      }
      const object = objectFromRow(headers, row);
      return baseRecord({
        sourceFile,
        sourceIndex,
        listName,
        title: first(object, TITLE_HEADERS),
        note: first(object, ['note']),
        comment: first(object, ['comment']),
        tags: first(object, ['tags']),
        url: csvUrl(object, sourceFile, sourceIndex),
        latitude: first(object, ['latitude', 'lat']),
        longitude: first(object, ['longitude', 'lng', 'lon'])
      }, options);
    });
}

function assertStarredPlacesGeoJson(document, sourceFile, options) {
  const reviewFields = new Set([
    'five_star_rating_draft',
    'five_star_rating_published',
    'review_text_draft',
    'review_text_published',
    'questions'
  ]);
  for (const feature of document.features ?? []) {
    const keys = Object.keys(feature.properties ?? {}).map((key) => key.toLowerCase());
    if (keys.some((key) => reviewFields.has(key))) {
      throw new Error(`${sourceFile}: Reviews GeoJSON を Starred places として処理できません`);
    }
  }
  const basename = path.basename(sourceFile, path.extname(sourceFile)).normalize('NFKC').toLowerCase();
  const knownName = /(?:saved[ _-]*places|starred[ _-]*places|お気に入り|保存済み(?:の)?場所)/i.test(basename);
  if (!knownName && options.geoJsonKind !== 'starred') {
    throw new Error(`${sourceFile}: GeoJSON の種類が不明です。Starred places と本人が確認した場合だけ --geojson-kind starred を指定してください`);
  }
}

function geoJsonRecords(document, sourceFile, options) {
  if (document?.type !== 'FeatureCollection' || !Array.isArray(document.features)) {
    throw new Error(`${sourceFile}: GeoJSON FeatureCollection ではありません`);
  }
  assertStarredPlacesGeoJson(document, sourceFile, options);
  return document.features.map((feature, index) => {
    const flat = flatten(feature.properties ?? {});
    const coordinates = feature.geometry?.type === 'Point' && Array.isArray(feature.geometry.coordinates)
      ? feature.geometry.coordinates : [];
    return baseRecord({
      sourceFile,
      sourceIndex: index + 1,
      listName: path.basename(sourceFile, path.extname(sourceFile)),
      title: flattenedFirst(flat, ['title', 'name', 'business name', 'business_name']),
      note: flattenedFirst(flat, ['note']),
      comment: flattenedFirst(flat, ['comment']),
      tags: flattenedFirst(flat, ['tags']),
      url: flattenedFirst(flat, ['item_content_url', 'google maps url', 'google_maps_url', 'url']),
      // GeoJSON は [longitude, latitude]。
      longitude: coordinates[0] ?? '',
      latitude: coordinates[1] ?? ''
    }, options);
  });
}

async function listInputFiles(input) {
  const absolute = path.resolve(input);
  const info = await stat(absolute);
  if (info.isFile()) {
    if (/\.html?$/i.test(absolute)) throw new Error('TAKEOUT_INDEX_NOT_DATA: archive_browser.htmlは案内ページです。このツールはHTML入力に未対応です。ZIPをすべて展開し、Saved / 保存済み内の対象リストCSVを指定してください。HTMLの拡張子を変更しないでください。');
    if (/\.(zip|tgz|tar|gz)$/i.test(absolute)) throw new Error('TAKEOUT_EXTRACT_REQUIRED: アーカイブをすべて展開してから、Saved / 保存済み内の対象リストCSVを指定してください。');
    if (!/\.(csv|json|geojson)$/i.test(absolute)) throw new Error('UNSUPPORTED_INPUT_FILE: 対象リストのCSV / JSON / GeoJSONを指定してください');
    return [absolute];
  }
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) return listInputFiles(child);
    return /\.(csv|json|geojson)$/i.test(entry.name) ? [child] : [];
  }));
  return nested.flat().sort();
}

export async function normalizeInputs({ input, output, report, allowCoordinatePins = false, geoJsonKind }) {
  const files = await listInputFiles(input);
  if (files.length === 0) throw new Error('TAKEOUT_DATA_NOT_FOUND: CSV / JSON / GeoJSON が見つかりません。ZIPの全展開と未取得の分割ZIPを確認してください。HTMLしかない場合は移行元アカウントのTakeoutで Saved / 保存済み が選ばれているか確認してください');
  const records = [];
  const errors = [];
  for (const filename of files) {
    try {
      const text = await readFile(filename, 'utf8');
      const relative = path.relative(process.cwd(), filename) || path.basename(filename);
      if (/\.csv$/i.test(filename)) records.push(...csvRecords(text, relative, { allowCoordinatePins }));
      else records.push(...geoJsonRecords(JSON.parse(text), relative, { allowCoordinatePins, geoJsonKind }));
    } catch (error) {
      errors.push({ file: filename, error: error.message });
    }
  }
  if (errors.length > 0) {
    const error = new Error(`入力形式を安全に判定できないファイルがあります: ${errors.map((x) => x.file).join(', ')}`);
    error.details = errors;
    throw error;
  }

  const seen = new Map();
  const actionable = [];
  const duplicates = [];
  const review = [];
  for (const record of records) {
    if (!record.actionable) {
      review.push(record);
    } else if (seen.has(record.identity)) {
      duplicates.push({ duplicate: record, first: seen.get(record.identity) });
    } else {
      seen.set(record.identity, { sourceFile: record.sourceFile, sourceIndex: record.sourceIndex });
      actionable.push(record);
    }
  }

  const outputPath = path.resolve(output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, actionable.map((record) => JSON.stringify(record)).join('\n') + (actionable.length ? '\n' : ''), { encoding: 'utf8', flag: 'wx' });
  const summary = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceFiles: files.length,
    inputRecords: records.length,
    actionableUnique: actionable.length,
    duplicatesSkipped: duplicates.length,
    manualReview: review.length,
    allowCoordinatePins,
    output: outputPath,
    review: review.map(({ sourceFile, sourceIndex, title, originalUrl, reviewReason }) => ({ sourceFile, sourceIndex, title, originalUrl, reviewReason })),
    duplicates: duplicates.map(({ duplicate, first }) => ({ sourceFile: duplicate.sourceFile, sourceIndex: duplicate.sourceIndex, title: duplicate.title, identity: duplicate.identity, first }))
  };
  await atomicWriteJson(report, summary);
  return summary;
}

export async function loadNormalized(filename) {
  const text = await readFile(filename, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const identities = new Set();
  return lines.map((line, index) => {
    const value = JSON.parse(line);
    if (value.schemaVersion !== 1 || !value.actionable || !value.identity || !value.navigationUrl) {
      throw new Error(`${filename}:${index + 1}: 正規化レコードが不正です`);
    }
    if (identities.has(value.identity)) throw new Error(`${filename}:${index + 1}: identity が重複しています`);
    identities.add(value.identity);
    if (value.identityKind === 'coordinate_pin') {
      let url;
      try { url = new URL(value.navigationUrl); } catch { throw new Error(`${filename}:${index + 1}: 座標URLが不正です`); }
      const query = url.searchParams.get('query');
      const [latitude, longitude] = String(query ?? '').split(',').map(Number);
      const inRange = Number.isFinite(latitude) && Number.isFinite(longitude) &&
        Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && !(latitude === 0 && longitude === 0);
      if (value.coordinateOptIn !== true || url.protocol !== 'https:' || url.hostname !== 'www.google.com' || url.pathname !== '/maps/search/' || url.searchParams.get('api') !== '1' || !/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(query ?? '') || !inRange || value.identity !== `coordinate:${query}`) {
        throw new Error(`${filename}:${index + 1}: 座標identityとURLが一致しません`);
      }
    } else {
      const inspected = inspectMapsUrl(value.navigationUrl);
      if (!inspected.actionable || inspected.identity !== value.identity || inspected.identityKind !== value.identityKind || inspected.navigationUrl !== new URL(value.navigationUrl).toString()) {
        throw new Error(`${filename}:${index + 1}: navigationUrl と identity が一致しません`);
      }
    }
    return value;
  });
}
