import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { csvEscape } from './csv.mjs';

export async function generateSyntheticCsv(output, count = 1000) {
  if (!Number.isSafeInteger(count) || count < 30) throw new Error('合成件数は30以上にしてください');
  const duplicateCount = Math.max(1, Math.floor(count * 0.01));
  const reviewCount = Math.max(2, Math.floor(count * 0.02));
  const uniqueCount = count - duplicateCount - reviewCount;
  const rows = [['title', 'item_content_url', 'note', 'tags', 'comment']];
  for (let i = 1; i <= uniqueCount; i += 1) {
    const id = `SYNTHETIC_PLACE_${String(i).padStart(4, '0')}`;
    rows.push([
      `合成スポット ${i}`,
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`合成スポット ${i}`)}&query_place_id=${id}`,
      i % 17 === 0 ? '改行を含む\n合成メモ（実在情報ではありません）' : '合成データ',
      i % 2 ? 'odd' : 'even',
      '検証専用'
    ]);
  }
  for (let i = 1; i <= duplicateCount; i += 1) {
    const id = `SYNTHETIC_PLACE_${String(i).padStart(4, '0')}`;
    rows.push([`重複 ${i}`, `https://www.google.com/maps/search/?api=1&query=duplicate&query_place_id=${id}`, '', '', '重複検証']);
  }
  for (let i = 0; i < reviewCount; i += 1) {
    rows.push([`要確認 ${i + 1}`, i % 2 ? `https://maps.app.goo.gl/SYNTHETIC${i}` : `https://example.invalid/place/${i}`, '', '', '自動操作禁止']);
  }
  const descriptor = ['collection_description', '合成1000件検証用。実在の場所・アカウント情報を含みません。'];
  const text = `${descriptor.map(csvEscape).join(',')}\n\n${rows.map((row) => row.map(csvEscape).join(',')).join('\n')}\n`;
  const absolute = path.resolve(output);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, text, { encoding: 'utf8', flag: 'wx' });
  return { output: absolute, count, uniqueCount, duplicateCount, reviewCount };
}
