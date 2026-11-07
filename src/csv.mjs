export function parseCsv(text) {
  const input = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let state = 'start';
  const endField = () => { row.push(field); field = ''; state = 'start'; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (state === 'quoted') {
      if (c === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') state = 'closed';
      else field += c;
    } else if (c === ',') {
      endField();
    } else if (c === '\r' || c === '\n') {
      endRow();
      if (c === '\r' && input[i + 1] === '\n') i += 1;
    } else if (c === '"' && state === 'start') {
      state = 'quoted';
    } else {
      if (c === '"' || state === 'closed') throw new Error('CSV の引用符の位置が不正です');
      field += c;
      state = 'unquoted';
    }
  }
  if (state === 'quoted') throw new Error('CSV の引用符が閉じていません');
  if (state !== 'start' || row.length > 0) endRow();
  return rows;
}

export function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
