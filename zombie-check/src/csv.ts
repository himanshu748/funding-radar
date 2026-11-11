import { publicUrl } from "./urls.js";
import {
  ZombieError,
  type EntityKind,
  type InputIssue,
  type InputSheet,
} from "./types.js";

/** Quoted fields, escaped quotes and embedded newlines; malformed quoting fails loudly. */
export function parseCsv(input: string): string[][] {
  if (Buffer.byteLength(input, "utf8") > 2_000_000 || input.includes("\0"))
    throw new ZombieError(
      "INPUT_TOO_LARGE",
      "CSV exceeds the bounded text contract.",
    );
  const text = input.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false,
    started = false;
  const field = () => {
    row.push(cell);
    cell = "";
    started = false;
    closed = false;
  };
  const record = () => {
    field();
    records.push(row);
    row = [];
    if (records.length > 10_001)
      throw new ZombieError("TOO_MANY_ROWS", "CSV exceeds 10,000 data rows.");
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += char;
    } else if (char === '"') {
      if (started || closed || cell)
        throw new ZombieError(
          "MALFORMED_CSV",
          "Unexpected quote inside a field.",
        );
      quoted = true;
      started = true;
    } else if (char === ",") field();
    else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      record();
    } else {
      if (closed)
        throw new ZombieError(
          "MALFORMED_CSV",
          "Unexpected content after a closing quote.",
        );
      cell += char;
      started = true;
    }
    if (cell.length > 4096)
      throw new ZombieError(
        "CELL_TOO_LARGE",
        "A CSV cell exceeds 4096 characters.",
      );
  }
  if (quoted) throw new ZombieError("MALFORMED_CSV", "Unclosed quoted field.");
  if (row.length || started || cell || closed) record();
  return records;
}

export function ingestCsv(
  text: string,
  options: { minimumRows?: number; mode?: InputSheet["mode"] } = {},
): InputSheet {
  const minimumRows = options.minimumRows ?? 500;
  if (!Number.isInteger(minimumRows) || minimumRows < 1 || minimumRows > 10_000)
    throw new ZombieError(
      "INVALID_MINIMUM",
      "Minimum rows must be between 1 and 10,000.",
    );
  const records = parseCsv(text),
    headers = records.shift()?.map((h) => h.trim().toLowerCase());
  if (
    !headers ||
    headers.length !== 4 ||
    new Set(headers).size !== 4 ||
    ["id", "name", "url", "kind"].some((h) => !headers.includes(h))
  )
    throw new ZombieError(
      "INVALID_HEADERS",
      "CSV needs exactly id, name, url and kind columns.",
    );
  const ids = new Set<string>(),
    urls = new Set<string>(),
    issues: InputIssue[] = [];
  const rows = records.map((values, index) => {
    const sourceRow = index + 2;
    if (values.length !== headers.length)
      throw new ZombieError(
        "MALFORMED_CSV",
        "Row " + sourceRow + " has the wrong number of fields.",
      );
    const value = (name: string) => values[headers.indexOf(name)]!.trim();
    const id = value("id"),
      name = value("name"),
      rawUrl = value("url"),
      rawKind = value("kind");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(id) || ids.has(id))
      throw new ZombieError(
        "AMBIGUOUS_ID",
        "Row " + sourceRow + " needs a unique plain id.",
      );
    ids.add(id);
    const rowIssues: InputIssue[] = [];
    const issue = (code: InputIssue["code"], message: string) =>
      rowIssues.push({ row: sourceRow, code, message });
    if (!name || name.length > 200)
      issue("INVALID_NAME", "Name must contain 1–200 characters.");
    const kind = ["company", "tool", "job"].includes(rawKind)
      ? (rawKind as EntityKind)
      : null;
    if (!kind) issue("INVALID_KIND", "Kind must be company, tool or job.");
    let canonicalUrl: string | null = null;
    try {
      canonicalUrl = publicUrl(rawUrl);
    } catch {
      issue(
        "INVALID_URL",
        "URL is outside the supported public HTTPS contract; the unsupported literal is omitted from reports.",
      );
    }
    const originalUrl = canonicalUrl ? rawUrl : "[unsupported URL omitted]";
    if (canonicalUrl && urls.has(canonicalUrl))
      issue(
        "DUPLICATE_URL",
        "Repeated URL retained under its own id; source rows must not merge.",
      );
    if (canonicalUrl) urls.add(canonicalUrl);
    issues.push(...rowIssues);
    return {
      id,
      name,
      originalUrl,
      canonicalUrl,
      kind,
      sourceRow,
      issues: rowIssues,
    };
  });
  const validRows = rows.filter(
    (row) =>
      row.kind &&
      row.canonicalUrl &&
      row.name &&
      !row.issues.some((i) => i.code !== "DUPLICATE_URL"),
  ).length;
  return {
    mode: options.mode ?? "user_supplied",
    rows,
    validRows,
    minimumRows,
    meetsMinimum: validRows >= minimumRows,
    issues,
  };
}

/** Neutralize spreadsheet formulas; original literals remain intact in the JSON report. */
export function csvCell(value: string): string {
  if (/^\s*[=+@-]/.test(value)) value = "'" + value;
  return '"' + value.replaceAll('"', '""') + '"';
}
