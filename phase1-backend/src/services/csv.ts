/**
 * codiq phase 20B-3 — hand-rolled CSV parser/serializer (D-25, decision §8.8).
 *
 * Deliberately a ~60-line RFC-4180 SUBSET with zero dependencies:
 * - fields separated by commas; records by LF, CR, or CRLF;
 * - a field that STARTS with `"` is quoted: it may contain commas, newlines,
 *   and escaped quotes (`""`);
 * - a UTF-8 BOM at position 0 is stripped (Excel writes one);
 * - fully-empty trailing lines are dropped.
 * A quote appearing mid-field (not at the field start) is treated literally —
 * that is the "subset" part, and exports never produce such a shape.
 * An unterminated quoted field throws CSV_UNTERMINATED_QUOTE (the service maps
 * it to a 422). The module stays free of HTTP concerns so the integration test
 * can unit-test it directly.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let fieldStarted = false;
  let inQuotes = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; // strip BOM
  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (index < text.length) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && !fieldStarted && field === "") {
      inQuotes = true;
      fieldStarted = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      endField();
      index += 1;
      continue;
    }
    if (char === "\r") {
      endRow();
      index += text[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (char === "\n") {
      endRow();
      index += 1;
      continue;
    }
    field += char;
    fieldStarted = true;
    index += 1;
  }
  if (inQuotes) throw new Error("CSV_UNTERMINATED_QUOTE");
  if (field !== "" || fieldStarted || row.length) endRow();
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

/** Quotes a field only when RFC 4180 requires it (comma, quote, or newline). */
export function csvField(value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// CSV/formula injection (CWE-1236): a cell starting with = + - @ (or a tab/CR
// smuggle) executes as a formula when the merchant opens the export in Excel.
// Customer-controlled text (names, addresses) MUST pass through the guard; the
// import side strips exactly this prefix so product round-trips stay lossless.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** Excel-safe field: prefixes formula-looking cells with a literal apostrophe. */
export function csvGuardedField(value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return csvField(FORMULA_PREFIX.test(text) ? `'${text}` : text);
}

/** Reverses csvGuardedField on import: strips the guard apostrophe only when it guards. */
export function csvUnguardField(text: string): string {
  return text.startsWith("'") && FORMULA_PREFIX.test(text.slice(1)) ? text.slice(1) : text;
}

/** One CRLF-terminated record — CRLF is the RFC 4180 line ending Excel expects. */
export function csvLine(
  fields: ReadonlyArray<string | number | boolean | null | undefined>
): string {
  return `${fields.map(csvField).join(",")}\r\n`;
}

/** csvLine with the formula-injection guard applied to every field. */
export function csvGuardedLine(
  fields: ReadonlyArray<string | number | boolean | null | undefined>
): string {
  return `${fields.map(csvGuardedField).join(",")}\r\n`;
}

/** The BOM every export writes first so Excel renders Arabic UTF-8 correctly. */
export const CSV_UTF8_BOM = "\uFEFF";
