export function parseCsv(text) {
  if (typeof text !== 'string') throw new TypeError('CSV input must be text.');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let physicalLine = 1;
  let rowStartLine = 1;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else {
        field += char;
        if (char === '\r' || char === '\n') {
          if (char === '\r' && text[i + 1] === '\n') { field += '\n'; i += 1; }
          physicalLine += 1;
        }
      }
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some(value => value !== '')) rows.push({ values: row, rowNumber: rowStartLine });
      row = [];
      physicalLine += 1;
      rowStartLine = physicalLine;
    } else field += char;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted value.');
  if (field.length || row.length) { row.push(field); if (row.some(value => value !== '')) rows.push({ values: row, rowNumber: rowStartLine }); }
  if (!rows.length) return { headers: [], records: [] };
  const [{ values: rawHeaders }, ...data] = rows;
  const normalizedHeaders = rawHeaders.map(value => value.replace(/^\uFEFF/, '').trim());
  const headerKeys = normalizedHeaders.map(value => value.toLowerCase());
  if (new Set(headerKeys).size !== normalizedHeaders.length) throw new Error('CSV headers must be unique.');
  return {
    headers: normalizedHeaders,
    records: data.map(({ values, rowNumber }) => ({
      rowNumber,
      values: Object.fromEntries(normalizedHeaders.map((header, column) => [header, values[column] ?? '']))
    }))
  };
}

export function csvRowsToArrays(parsed) {
  return parsed.records.map(record => parsed.headers.map(header => record.values[header]));
}

function safeCsvText(value) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /^[\s\uFEFF]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  const text = safeCsvText(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeCsv(headers, rows) {
  return `\uFEFF${[headers.map(csvCell).join(','), ...rows.map(row => row.map(csvCell).join(','))].join('\r\n')}\r\n`;
}

