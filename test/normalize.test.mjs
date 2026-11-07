import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectMapsUrl, loadNormalized, normalizeInputs } from '../src/normalize.mjs';

test('exact Google Maps identities only', () => {
  assert.equal(inspectMapsUrl('javascript:alert(1)').actionable, false);
  assert.equal(inspectMapsUrl('file:///etc/passwd').actionable, false);
  assert.equal(inspectMapsUrl('https://example.com/maps/place/x').actionable, false);
  assert.equal(inspectMapsUrl('https://google.evil.com/maps/place/x/data=!1sBAD').actionable, false);
  assert.equal(inspectMapsUrl('https://maps.app.goo.gl/abc').reason, 'short_url_requires_manual_resolution');
  assert.equal(inspectMapsUrl('https://www.google.com/maps/search/?api=1&query=X').actionable, false);
  const exact = inspectMapsUrl('https://www.google.com/maps/search/?api=1&query=X&query_place_id=ChIJ_TEST');
  assert.equal(exact.actionable, true);
  assert.equal(exact.identity, 'place_id:ChIJ_TEST');
  assert.equal(new URL(exact.navigationUrl).hostname, 'www.google.com');
});

test('new Saved CSV prelude, BOM, quoted newline, duplicates, and review items', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gmaps-normalize-'));
  const input = path.join(dir, 'saved.csv');
  const output = path.join(dir, 'normalized.jsonl');
  const report = path.join(dir, 'report.json');
  const csv = '\uFEFFcollection_description,"テスト用リスト"\n\n' +
    'title,item_content_url,note,tags,comment\n' +
    'A,https://www.google.com/maps/search/?api=1&query=A&query_place_id=PID_A,"line1\nline2",tag,c\n' +
    'A duplicate,https://www.google.com/maps/search/?api=1&query=A2&query_place_id=PID_A,,,,\n' +
    'Bad,https://example.invalid/place/a,,,,\n';
  await writeFile(input, csv, 'utf8');
  const result = await normalizeInputs({ input, output, report });
  assert.deepEqual({ input: result.inputRecords, actionable: result.actionableUnique, duplicates: result.duplicatesSkipped, review: result.manualReview }, { input: 3, actionable: 1, duplicates: 1, review: 1 });
  const records = await loadNormalized(output);
  assert.equal(records[0].note, 'line1\nline2');
  assert.match(records[0].listName, /collection_description/);
});

test('GeoJSON uses longitude,latitude; [0,0] and coordinate-only default to review', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gmaps-geojson-'));
  const input = path.join(dir, 'Saved Places.json');
  const output = path.join(dir, 'normalized.jsonl');
  const report = path.join(dir, 'report.json');
  const document = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [139.7, 35.6] }, properties: { Location: { 'Business Name': 'Exact', 'Google Maps URL': 'https://www.google.com/maps/search/?api=1&query=X&query_place_id=PID_GEO' } } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [139.8, 35.7] }, properties: { name: 'Coordinate only' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'Unknown' } }
    ]
  };
  await writeFile(input, JSON.stringify(document), 'utf8');
  const result = await normalizeInputs({ input, output, report });
  assert.equal(result.actionableUnique, 1);
  assert.equal(result.manualReview, 2);
  const records = await loadNormalized(output);
  assert.equal(records[0].longitude, 139.7);
  assert.equal(records[0].latitude, 35.6);
});

test('normalization refuses unknown JSON schema instead of guessing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gmaps-unknown-'));
  const input = path.join(dir, 'reviews.json');
  await writeFile(input, JSON.stringify([{ rating: 5 }]), 'utf8');
  await assert.rejects(() => normalizeInputs({ input, output: path.join(dir, 'out.jsonl'), report: path.join(dir, 'report.json') }), /安全に判定できない/);
  await assert.rejects(() => readFile(path.join(dir, 'out.jsonl')));
});

test('Reviews-like GeoJSON is rejected even when it has an exact Maps URL', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gmaps-reviews-'));
  const input = path.join(dir, 'reviews.geojson');
  const document = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139, 35] },
      properties: {
        five_star_rating_published: 5,
        google_maps_url: 'https://www.google.com/maps/search/?api=1&query=X&query_place_id=REVIEW_PLACE',
        location: { name: 'Not a saved-list item' }
      }
    }]
  };
  await writeFile(input, JSON.stringify(document), 'utf8');
  await assert.rejects(
    () => normalizeInputs({ input, output: path.join(dir, 'out.jsonl'), report: path.join(dir, 'report.json'), geoJsonKind: 'starred' }),
    (error) => error.details?.some((detail) => /Reviews GeoJSON/.test(detail.error))
  );
});

test('normalized JSONL is revalidated and duplicate identities are rejected', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gmaps-jsonl-boundary-'));
  const filename = path.join(dir, 'normalized.jsonl');
  const base = {
    schemaVersion: 1,
    actionable: true,
    identity: 'place_id:SAFE',
    identityKind: 'place_id',
    navigationUrl: 'https://www.google.com/maps/search/?api=1&query=X&query_place_id=SAFE'
  };
  await writeFile(filename, `${JSON.stringify({ ...base, navigationUrl: 'https://example.invalid/not-maps' })}\n`, 'utf8');
  await assert.rejects(() => loadNormalized(filename), /navigationUrl/);
  const duplicateFile = path.join(dir, 'duplicates.jsonl');
  await writeFile(duplicateFile, `${JSON.stringify(base)}\n${JSON.stringify(base)}\n`, 'utf8');
  await assert.rejects(() => loadNormalized(duplicateFile), /重複/);

  const coordinateFile = path.join(dir, 'coordinate.jsonl');
  const coordinateBase = {
    schemaVersion: 1,
    actionable: true,
    identity: 'coordinate:35.0000000,139.0000000',
    identityKind: 'coordinate_pin',
    coordinateOptIn: true,
    navigationUrl: 'https://www.google.com/maps/search/?api=1&query=35.0000000%2C139.0000000'
  };
  await writeFile(coordinateFile, `${JSON.stringify({ ...coordinateBase, identity: 'coordinate:999,999', navigationUrl: 'https://www.google.com/maps/search/?api=1&query=999%2C999' })}\n`, 'utf8');
  await assert.rejects(() => loadNormalized(coordinateFile), /座標identity/);
  const noOptInFile = path.join(dir, 'coordinate-no-opt-in.jsonl');
  await writeFile(noOptInFile, `${JSON.stringify({ ...coordinateBase, coordinateOptIn: false })}\n`, 'utf8');
  await assert.rejects(() => loadNormalized(noOptInFile), /座標identity/);
});
