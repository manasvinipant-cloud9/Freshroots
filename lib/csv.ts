/** Small CSV reader (RFC 4180 quotes). Has a fast path for the common no-quotes case; handles ~2M rows. */
export type Table = { columns: Record<string, string[]>; length: number };

function splitQuoted(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Parse into columns keyed by trimmed header name. Values stay strings; callers convert. */
export function parseCsv(text: string): Table {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let rows: string[][];
  if (!text.includes('"')) {
    const lines = text.split(/\r?\n/);
    rows = [];
    for (const l of lines) if (l !== "") rows.push(l.split(","));
  } else rows = splitQuoted(text);
  if (!rows.length) return { columns: {}, length: 0 };
  const header = rows[0].map((h) => h.trim());
  const columns: Record<string, string[]> = {};
  header.forEach((h) => (columns[h] = new Array(rows.length - 1)));
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < header.length; c++) columns[header[c]][r - 1] = row[c] ?? "";
  }
  return { columns, length: rows.length - 1 };
}
