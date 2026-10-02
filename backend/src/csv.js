export function parseCsv(text) {
  if (typeof text !== 'string') throw new TypeError('CSV input must be text.');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted value.');
  if (field.length || row.length) { row.push(field); if (row.some(value => value !== '')) rows.push(row); }
  if (!rows.length) return { headers: [], records: [] };
  const [headers, ...data] = rows;
  const normalizedHeaders = headers.map(value => value.replace(/^\uFEFF/, '').trim());
  if (new Set(normalizedHeaders).size !== normalizedHeaders.length) throw new Error('CSV headers must be unique.');
  return {
    headers: normalizedHeaders,
    records: data.map((values, index) => ({
      rowNumber: index + 2,
      values: Object.fromEntries(normalizedHeaders.map((header, column) => [header, values[column] ?? '']))
    }))
  };
}

export function csvRowsToArrays(parsed) {
  return parsed.records.map(record => parsed.headers.map(header => record.values[header]));
}

