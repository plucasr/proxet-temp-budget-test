import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "#/db";
import { isEmailVerified, requireUserId } from "#/server/session";
import { categorizeDescription, isAIVisible } from "#/server/ai";
import { checkSpendCap } from "#/server/ai-usage.server";
import { safeEvaluateBudgetAlerts } from "#/server/budgets.server";
import { formatMinor, parseAmountToMinor } from "#/lib/money";
import {
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_ROWS,
  base64LengthLimit,
} from "#/lib/upload";


// --- File decoding ---

export type ImportFormat = "generic" | "pko_bp";

export interface RowInfo {
  rowIndex: number;
  date: string;
  /** Integer minor units (grosze/cents). */
  amountMinor: number;
  description: string;
  category?: string | null;
  errors?: string[];
}

export interface RuleSummary {
  pattern: string;
  match_type: "substring" | "exact";
  category_name: string;
}

export interface ImportSummary {
  imported: number;
  autoCategorized: number;
  aiCategorized: number;
  uncategorized: number;
  duplicates: number;
  errors: number;
  duplicateRows: Array<{
    date: string;
    amountMinor: number;
    description: string;
  }>;
  errorRows: Array<{
    rowIndex: number;
    errors: string[];
    rawDate: string;
    rawAmount: string;
    description: string;
  }>;
  batchId: string | null;
  newRules: RuleSummary[];
  mismatchedPatterns: Array<{ pattern: string; description: string }>;
}

export type StreamChunk =
  | { type: "ruleMatch"; current: number; total: number; row: RowInfo }
  | { type: "aiMatched"; current: number; total: number; row: RowInfo }
  | {
      type: "newRule";
      current: number;
      total: number;
      row: RowInfo;
      rule: RuleSummary;
    }
  | {
      type: "aiMismatch";
      current: number;
      total: number;
      row: RowInfo;
      pattern: string;
    }
  | { type: "error"; current: number; total: number; row: RowInfo }
  | { type: "uncategorized"; current: number; total: number; row: RowInfo }
  | { type: "duplicate"; current: number; total: number; row: RowInfo }
  | { type: "complete"; summary: ImportSummary };

function decodeBase64(b64: string): Uint8Array {
  const bin = Buffer.from(b64, "base64");
  return new Uint8Array(bin);
}

// PKO iPKO exports always start with the Polish header row. The header is pure
// ASCII, so we can sniff it by decoding the first slice as latin1 regardless of
// the file's actual encoding.
const PKO_HEADER_MARKERS = ["Data operacji", "Typ transakcji", "Kwota"];

function looksLikePko(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 600));
  return PKO_HEADER_MARKERS.every((m) => head.includes(m));
}

// PKO files are Windows-1250; generic uploads are UTF-8 (with optional BOM).
function decodeBytes(bytes: Uint8Array, format: ImportFormat): string {
  if (format === "pko_bp") {
    return new TextDecoder("windows-1250").decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
}

// --- CSV parsing ---

export type ParsedRow = Record<string, string>;

export interface ParsedCsv {
  headers: string[];
  rows: ParsedRow[];
}

// Returns the raw 2D array of records (no header-keying). PKO uses this so
// duplicate empty header columns don't collide.
export function parseCsvRecords(text: string): string[][] {
  const stripped = text.replace(/^﻿/, "");
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  while (i < stripped.length) {
    const ch = stripped[i];

    if (inQuotes) {
      if (ch === '"') {
        if (stripped[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      records.push(row);
      row = [];
      if (ch === "\r" && stripped[i + 1] === "\n") {
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    field += ch;
    i++;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  while (
    records.length > 0 &&
    records[records.length - 1].every((c) => c.trim() === "")
  ) {
    records.pop();
  }

  return records;
}

// Minimal RFC 4180-ish CSV parser. Handles quoted fields with embedded commas,
// double-quote escapes, and CRLF line endings. Keys each row by header name.
export function parseCsv(text: string): ParsedCsv {
  const records = parseCsvRecords(text);
  if (records.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = records[0].map((h) => h.trim());
  const rows: ParsedRow[] = [];
  for (let r = 1; r < records.length; r++) {
    const obj: ParsedRow = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = (records[r][c] ?? "").trim();
    }
    rows.push(obj);
  }

  return { headers, rows };
}

// --- Mapping & resolution ---

const mappingSchema = z.object({
  date: z.string().min(1),
  amount: z.string().min(1),
  description: z.string().min(1),
  category: z.string().optional(),
});

export type ColumnMapping = z.infer<typeof mappingSchema>;

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

// Tries to coerce a CSV cell into YYYY-MM-DDTHH:mm:ss. Accepts date-only
// values (appends T00:00:00), ISO datetimes, "DD/MM/YYYY" / "DD.MM.YYYY",
// and any format parseable by the Date constructor. Returns null on failure.
export function normalizeDateTime(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Already full ISO datetime (with time component)
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return trimmed;
  // Date-only → append midnight
  if (dateRegex.test(trimmed)) return `${trimmed}T00:00:00`;
  const dmy = trimmed.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}T00:00:00`;
  const parsed = new Date(trimmed);
  if (!isNaN(parsed.getTime())) {
    const yyyy = parsed.getFullYear();
    const mm = String(parsed.getMonth() + 1).padStart(2, "0");
    const dd = String(parsed.getDate()).padStart(2, "0");
    const hh = String(parsed.getHours()).padStart(2, "0");
    const mi = String(parsed.getMinutes()).padStart(2, "0");
    const ss = String(parsed.getSeconds()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
  }
  return null;
}

// Parses an amount cell straight to integer minor units — never through a
// float. Delegates to the shared Money utility, which strips spaces and
// currency symbols and treats "," as decimal separator when no "." is present.
export function normalizeAmountMinor(raw: string): number | null {
  return parseAmountToMinor(raw);
}

export interface ResolvedRow {
  date: string | null;
  /** Integer minor units (grosze/cents). */
  amountMinor: number | null;
  description: string;
  categoryName: string | null;
  rawDate: string;
  rawAmount: string;
  errors: string[];
}

export function resolveRow(
  row: ParsedRow,
  mapping: ColumnMapping,
): ResolvedRow {
  const rawDate = row[mapping.date] ?? "";
  const rawAmount = row[mapping.amount] ?? "";
  const description = row[mapping.description] ?? "";
  const categoryName = mapping.category
    ? (row[mapping.category] ?? "").trim() || null
    : null;

  const errors: string[] = [];
  const date = normalizeDateTime(rawDate);
  if (!date) errors.push("invalid date");
  const amountMinor = normalizeAmountMinor(rawAmount);
  if (amountMinor === null) errors.push("invalid amount");
  if (amountMinor === 0) errors.push("amount cannot be zero");

  return {
    date,
    amountMinor,
    description,
    categoryName,
    rawDate,
    rawAmount,
    errors,
  };
}

// --- PKO BP parser ---

// Strips the "Lokalizacja:" / "Tytuł:" prefixed sub-fields into a clean
// merchant-and-city description. The bank packs Adres / Miasto / Kraj into a
// single column; we keep the address (merchant identifier) and city.
export function cleanPkoDescription(cells: string[]): string {
  let lokalizacja = "";
  let tytul = "";
  let opis = "";
  for (const c of cells) {
    const t = c.trim();
    if (!t) continue;
    if (t.startsWith("Lokalizacja:")) lokalizacja = t;
    else if (t.startsWith("Tytuł:") || t.startsWith("Tytul:")) tytul = t;
    else if (t.startsWith("Opis:") || t.startsWith("Opis transakcji:"))
      opis = t;
  }

  if (lokalizacja) {
    const body = lokalizacja.replace(/^Lokalizacja:\s*/, "");
    const m = body.match(/Adres:\s*(.+?)\s*Miasto:\s*(.+?)(?:\s*Kraj:|$)/);
    if (m) {
      return `${m[1].trim()} ${m[2].trim()}`.replace(/\s+/g, " ").trim();
    }
    return body.replace(/\s+/g, " ").trim();
  }
  if (tytul) {
    return tytul
      .replace(/^Tytu[łl]:\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (opis) {
    return opis
      .replace(/^Opis(?:\s+transakcji)?:\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

interface PkoParse {
  resolved: ResolvedRow[];
  totalRows: number;
}

function parsePkoCsv(text: string): PkoParse {
  const records = parseCsvRecords(text);
  if (records.length === 0) return { resolved: [], totalRows: 0 };
  const headers = records[0].map((h) => h.trim());
  const idxDate = headers.indexOf("Data operacji");
  const idxAmount = headers.indexOf("Kwota");
  const dataRecords = records.slice(1);

  const resolved = dataRecords.map<ResolvedRow>((cells) => {
    const rawDate = (cells[idxDate] ?? "").trim();
    const rawAmount = (cells[idxAmount] ?? "").trim();
    const description = cleanPkoDescription(cells);

    const errors: string[] = [];
    const date = normalizeDateTime(rawDate);
    if (!date) errors.push("invalid date");
    const amountMinor = normalizeAmountMinor(rawAmount);
    if (amountMinor === null) errors.push("invalid amount");
    if (amountMinor === 0) errors.push("amount cannot be zero");

    return {
      date,
      amountMinor,
      description,
      categoryName: null,
      rawDate,
      rawAmount,
      errors,
    };
  });
  return { resolved, totalRows: dataRecords.length };
}

// Stable hash of (datetime, amount, raw description) — used as `source_ref` for
// dedup in Phase 2 and onwards. FNV-1a 64-bit; fast, deterministic, no Node-only
// imports so this file stays bundleable for the client side of the route.
// The amount is passed in integer minor units but hashed as the same "12.34"
// decimal string the float-era `toFixed(2)` produced, so `source_ref` values of
// previously imported rows keep matching after the minor-units migration.
export function rowHash(
  dateTime: string,
  amountMinor: number,
  rawDescription: string,
): string {
  const input = `${dateTime}|${formatMinor(amountMinor)}|${rawDescription}`;
  // FNV-1a 64-bit
  let hi = 0xcbf2_9ce4;
  let lo = 0x8422_2325;
  const prime_hi = 0x0000_0100;
  const prime_lo = 0x0000_01b3;
  for (let i = 0; i < input.length; i++) {
    lo ^= input.charCodeAt(i) & 0xff;
    // 64-bit multiply by FNV prime
    const a = lo & 0xffff;
    const b = lo >>> 16;
    const c = hi & 0xffff;
    const d = hi >>> 16;
    const r0 = a * prime_lo;
    const r1 = b * prime_lo + a * prime_hi;
    const r2 = c * prime_lo + b * prime_hi;
    const r3 = d * prime_lo + c * prime_hi;
    const newLo = (r0 + ((r1 & 0xffff) << 16)) >>> 0;
    const carry = Math.floor((r0 + ((r1 & 0xffff) << 16)) / 0x1_0000_0000);
    const newHi = (carry + (r1 >>> 16) + r2 + ((r3 & 0xffff) << 16)) >>> 0;
    lo = newLo;
    hi = newHi;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

// --- Rule matching ---

export interface RuleRow {
  id: string;
  pattern: string;
  match_type: string;
  category_id: string;
  priority: number;
}

// Walks rules in priority order (lowest first) and returns the first match.
// Substring matching is case-insensitive on both sides.
export function matchRule(
  description: string,
  rules: RuleRow[],
): RuleRow | null {
  const desc = description.trim();
  const lowerDesc = desc.toLowerCase();
  for (const r of rules) {
    if (r.match_type === "exact") {
      if (desc === r.pattern.trim()) return r;
    } else {
      const p = r.pattern.toLowerCase();
      if (p && lowerDesc.includes(p)) return r;
    }
  }
  return null;
}

// --- Server functions ---

const previewSchema = z.object({
  filename: z.string(),
  data: z.string(),
  mapping: mappingSchema.partial().optional(),
  accountId: z.string().optional(),
  formatOverride: z.enum(["generic", "pko_bp"]).optional(),
});

const confirmSchema = z.object({
  filename: z.string(),
  data: z.string(),
  format: z.enum(["generic", "pko_bp"]),
  mapping: mappingSchema.optional(),
  accountId: z.string().min(1),
});

// --- Streaming import cancellation ---

const abortControllers = new Map<string, AbortController>();

let nextRequestId = 0;

export function setImportAborted(requestId: number, value: boolean) {
  if (value) {
    const controller = abortControllers.get(String(requestId));
    controller?.abort();
  } else {
    abortControllers.delete(String(requestId));
  }
}

// Preselects the most likely mapping for a generic CSV based on header names
// in English and Polish. Returns the field that matches first.
function guessMapping(headers: string[]): Partial<ColumnMapping> {
  const lower = headers.map((h) => h.toLowerCase());
  const pick = (...needles: string[]) => {
    for (const n of needles) {
      const idx = lower.findIndex((h) => h.includes(n));
      if (idx >= 0) return headers[idx];
    }
    return undefined;
  };
  return {
    date: pick("date", "data"),
    amount: pick("amount", "kwota", "value"),
    description: pick("description", "opis", "title", "tytul", "tytuł", "memo"),
    category: pick("category", "kategoria"),
  };
}

export type ResolvedPreviewRow = ResolvedRow & { duplicate: boolean };

async function annotateDuplicates(
  resolved: ResolvedPreviewRow[],
  accountId: string,
  userId: string,
): Promise<ResolvedPreviewRow[]> {
  const account = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.id, accountId),
        eq(schema.accounts.user_id, userId),
      ),
    )
    .limit(1);
  if (account.length === 0) return resolved;

  const refs: string[] = [];
  for (const r of resolved) {
    if (r.date && r.amountMinor !== null) {
      refs.push(rowHash(r.date, r.amountMinor, r.description));
    }
  }
  if (refs.length === 0) return resolved;

  const existing = await db
    .select({ ref: schema.transactions.source_ref })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.account_id, accountId),
        inArray(schema.transactions.source_ref, refs),
      ),
    );
  const existingRefs = new Set(
    existing.map((e) => e.ref).filter((ref): ref is string => ref !== null),
  );
  return resolved.map((r) =>
    r.date && r.amountMinor !== null
      ? {
          ...r,
          duplicate: existingRefs.has(
            rowHash(r.date, r.amountMinor, r.description),
          ),
        }
      : r,
  );
}

const IMPORT_TOO_LARGE = "File exceeds 5MB limit";
const IMPORT_TOO_MANY_ROWS = `File has too many rows. Max ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows per import`;

export const previewImport = createServerFn({ method: "POST" })
  .inputValidator(previewSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    if (data.data.length > base64LengthLimit(MAX_IMPORT_FILE_BYTES)) {
      return { error: IMPORT_TOO_LARGE };
    }
    const bytes = decodeBase64(data.data);

    const detected: ImportFormat = looksLikePko(bytes) ? "pko_bp" : "generic";
    const format: ImportFormat = data.formatOverride ?? detected;
    const text = decodeBytes(bytes, format);

    if (format === "pko_bp") {
      const { resolved, totalRows } = parsePkoCsv(text);
      if (totalRows > MAX_IMPORT_ROWS) {
        return { error: IMPORT_TOO_MANY_ROWS };
      }
      const sampleResolved = resolved.slice(0, 5);
      let withDup: ResolvedPreviewRow[] = sampleResolved.map((r) => ({
        ...r,
        duplicate: false,
      }));
      if (data.accountId) {
        withDup = await annotateDuplicates(withDup, data.accountId, userId);
      }
      return {
        format: "pko_bp" as const,
        detectedFormat: detected,
        resolved: withDup,
        totalRows,
      };
    }

    const parsed = parseCsv(text);
    if (parsed.rows.length > MAX_IMPORT_ROWS) {
      return { error: IMPORT_TOO_MANY_ROWS };
    }
    const guess = guessMapping(parsed.headers);
    const mapping: Partial<ColumnMapping> = {
      ...guess,
      ...data.mapping,
    };

    const sample = parsed.rows.slice(0, 5);
    const validatedMapping: ColumnMapping | null =
      mapping.date && mapping.amount && mapping.description
        ? {
            date: mapping.date,
            amount: mapping.amount,
            description: mapping.description,
            category: mapping.category,
          }
        : null;
    const baseResolved = validatedMapping
      ? sample.map((r) => resolveRow(r, validatedMapping))
      : null;

    let resolved: ResolvedPreviewRow[] | null = baseResolved
      ? baseResolved.map((r) => ({ ...r, duplicate: false }))
      : null;

    if (resolved && data.accountId) {
      resolved = await annotateDuplicates(resolved, data.accountId, userId);
    }

    return {
      format: "generic" as const,
      detectedFormat: detected,
      headers: parsed.headers,
      mapping,
      sample,
      resolved,
      totalRows: parsed.rows.length,
    };
  });

export const confirmImport = createServerFn({ method: "POST" })
  .inputValidator(confirmSchema)
  .handler(async function* ({ data }) {
    const userId = await requireUserId();
    const requestId = nextRequestId++;
    abortControllers.set(String(requestId), new AbortController());
    try {
      yield* streamConfirmImport(data, userId, requestId);
    } finally {
      abortControllers.delete(String(requestId));
    }
  });

async function* streamConfirmImport(
  data: z.infer<typeof confirmSchema>,
  userId: string,
  requestId: number,
): AsyncGenerator<StreamChunk, void> {
  const account = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.id, data.accountId),
        eq(schema.accounts.user_id, userId),
      ),
    )
    .limit(1);
  if (account.length === 0) {
    throw new Error("Account does not exist");
  }

  if (data.data.length > base64LengthLimit(MAX_IMPORT_FILE_BYTES)) {
    throw new Error(IMPORT_TOO_LARGE);
  }
  const bytes = decodeBase64(data.data);
  const text = decodeBytes(bytes, data.format);

  let resolvedRows: ResolvedRow[];
  if (data.format === "pko_bp") {
    resolvedRows = parsePkoCsv(text).resolved;
  } else {
    if (!data.mapping) {
      throw new Error("Generic format requires a column mapping");
    }
    const parsed = parseCsv(text);
    resolvedRows = parsed.rows.map((r) => resolveRow(r, data.mapping!));
  }
  if (resolvedRows.length > MAX_IMPORT_ROWS) {
    throw new Error(IMPORT_TOO_MANY_ROWS);
  }

  const userCategories = await db
    .select({ id: schema.categories.id, name: schema.categories.name })
    .from(schema.categories)
    .where(eq(schema.categories.user_id, userId));
  const categoryByName = new Map<string, string>();
  for (const c of userCategories) {
    categoryByName.set(c.name.toLowerCase(), c.id);
  }

  const userRules = await db
    .select({
      id: schema.categorization_rules.id,
      pattern: schema.categorization_rules.pattern,
      match_type: schema.categorization_rules.match_type,
      category_id: schema.categorization_rules.category_id,
      priority: schema.categorization_rules.priority,
    })
    .from(schema.categorization_rules)
    .where(eq(schema.categorization_rules.user_id, userId))
    .orderBy(
      asc(schema.categorization_rules.priority),
      asc(schema.categorization_rules.created_at),
    );

  const batchId = crypto.randomUUID();
  let imported = 0;
  let autoCategorized = 0;
  let aiCategorized = 0;
  let uncategorized = 0;
  const duplicateRows: Array<{
    date: string;
    amountMinor: number;
    description: string;
  }> = [];
  const errorRows: Array<{
    rowIndex: number;
    errors: string[];
    rawDate: string;
    rawAmount: string;
    description: string;
  }> = [];

  type Candidate = {
    hash: string;
    categoryId: string | null;
    date: string;
    amountMinor: number;
    description: string;
    rowIndex: number;
  };
  const candidates: Candidate[] = [];
  const uncategorizedCandidates: Array<{
    hash: string;
    date: string;
    amountMinor: number;
    description: string;
    rowIndex: number;
  }> = [];

  const totalRows = resolvedRows.length;
  let currentRow = 0;

  for (const r of resolvedRows) {
    currentRow++;
    const controller = abortControllers.get(String(requestId));
    if (controller?.signal.aborted) {
      throw new Error("Import cancelled");
    }

    if (r.errors.length > 0 || r.date === null || r.amountMinor === null) {
      errorRows.push({
        rowIndex: currentRow + 1,
        errors: r.errors,
        rawDate: r.rawDate,
        rawAmount: r.rawAmount,
        description: r.description,
      });
      yield {
        type: "error",
        current: currentRow,
        total: totalRows,
        row: {
          rowIndex: currentRow + 1,
          date: r.date ?? "",
          amountMinor: r.amountMinor ?? 0,
          description: r.description,
          errors: r.errors,
        },
      };
      continue;
    }

    let categoryId = r.categoryName
      ? (categoryByName.get(r.categoryName.toLowerCase()) ?? null)
      : null;
    if (!categoryId) {
      const rule = matchRule(r.description, userRules);
      if (rule) {
        categoryId = rule.category_id;
      }
    }

    const candidate = {
      hash: rowHash(r.date, r.amountMinor, r.description),
      categoryId,
      date: r.date,
      amountMinor: r.amountMinor,
      description: r.description,
      rowIndex: currentRow + 1,
    };
    candidates.push(candidate);
    if (!categoryId) {
      uncategorizedCandidates.push({
        hash: candidate.hash,
        date: candidate.date,
        amountMinor: candidate.amountMinor,
        description: candidate.description,
        rowIndex: currentRow + 1,
      });
    }
  }

  let aiRulesToCreate: Array<{
    pattern: string;
    match_type: "substring" | "exact";
    category_id: string;
    category_name: string;
    priority: number;
  }> = [];

  const mismatchedPatterns: Array<{ pattern: string; description: string }> =
    [];

  // Track AI results to avoid redundant calls:
  // description → { categoryId, category_name, pattern, matchType }
  type AiRuleCache = {
    categoryId: string;
    category_name: string;
    pattern: string;
    matchType: "substring" | "exact";
  };
  const aiResultCache = new Map<string, AiRuleCache>();

  if (abortControllers.get(String(requestId))?.signal.aborted) {
    throw new Error("Import cancelled");
  }

  // AI spend is gated on a verified email and the global daily spend cap
  // (unverified or capped accounts still get rule-based categorization —
  // the import itself is never blocked).
  if (
    uncategorizedCandidates.length > 0 &&
    isAIVisible() &&
    (await isEmailVerified(userId)) &&
    (await checkSpendCap()).allowed
  ) {
    const aiCategoryList = await db
      .select({ id: schema.categories.id, name: schema.categories.name })
      .from(schema.categories)
      .where(eq(schema.categories.user_id, userId));

    // Build a lookup for existing rules to avoid creating duplicates
    const existingRules = userRules.map((r) => ({
      pattern: r.pattern.toLowerCase(),
      category_id: r.category_id,
    }));

    for (const uncategorized of uncategorizedCandidates) {
      if (abortControllers.get(String(requestId))?.signal.aborted) {
        throw new Error("Import cancelled");
      }

      // Check if we already have a cached AI result for this description
      const descKey = uncategorized.description.toLowerCase().trim();
      if (aiResultCache.has(descKey)) {
        const cached = aiResultCache.get(descKey)!;
        const candidate = candidates.find((c) => c.hash === uncategorized.hash);
        if (candidate) {
          candidate.categoryId = cached.categoryId;
        }
        aiCategorized++;
        yield {
          type: "aiMatched",
          current: uncategorizedCandidates.indexOf(uncategorized) + 1,
          total: uncategorizedCandidates.length,
          row: {
            rowIndex: uncategorized.rowIndex,
            date: uncategorized.date,
            amountMinor: uncategorized.amountMinor,
            description: uncategorized.description,
            category: cached.category_name,
          },
        };
        continue;
      }

      // Small delay in test mode to allow cancellation testing
      if (process.env.TEST_MODE === "1") {
        await new Promise((r) => setTimeout(r, 100));
      }

      const result = await categorizeDescription(
        uncategorized.description,
        aiCategoryList,
        { userId, kind: "categorize" },
      );

      if (result.success) {
        const matchedCategory = aiCategoryList.find(
          (c) => c.name === result.category_name,
        );
        if (matchedCategory) {
          const candidate = candidates.find(
            (c) => c.hash === uncategorized.hash,
          );
          if (candidate) {
            candidate.categoryId = matchedCategory.id;
          }
          const pattern = result.pattern || uncategorized.description;
          const matchType = result.pattern ? "substring" : "exact";

          // Only create a rule if it doesn't already exist for this user
          const ruleAlreadyExists = existingRules.some(
            (er) =>
              er.pattern === pattern.toLowerCase() &&
              er.category_id === matchedCategory.id,
          );

          if (!ruleAlreadyExists) {
            aiRulesToCreate.push({
              pattern,
              match_type: matchType,
              category_id: matchedCategory.id,
              category_name: matchedCategory.name,
              priority: 50,
            });
            existingRules.push({
              pattern: pattern.toLowerCase(),
              category_id: matchedCategory.id,
            });
          }

          // Cache the AI result for subsequent identical descriptions
          aiResultCache.set(descKey, {
            categoryId: matchedCategory.id,
            category_name: matchedCategory.name,
            pattern,
            matchType,
          });

          aiCategorized++;
          yield {
            type: "aiMatched",
            current: uncategorizedCandidates.indexOf(uncategorized) + 1,
            total: uncategorizedCandidates.length,
            row: {
              rowIndex: uncategorized.rowIndex,
              date: uncategorized.date,
              amountMinor: uncategorized.amountMinor,
              description: uncategorized.description,
              category: matchedCategory.name,
            },
          };
        }
      } else {
        mismatchedPatterns.push({
          pattern: uncategorized.description,
          description: uncategorized.description,
        });
        yield {
          type: "aiMismatch",
          current: uncategorizedCandidates.indexOf(uncategorized) + 1,
          total: uncategorizedCandidates.length,
          row: {
            rowIndex: uncategorized.rowIndex,
            date: uncategorized.date,
            amountMinor: uncategorized.amountMinor,
            description: uncategorized.description,
          },
          pattern: uncategorized.description,
        };
      }
    }
  }

  const aiCategorizedHashes = new Set(
    uncategorizedCandidates
      .filter((u) => candidates.find((c) => c.hash === u.hash && c.categoryId))
      .map((u) => u.hash),
  );

  const dedupController = abortControllers.get(String(requestId));
  if (dedupController?.signal.aborted) {
    throw new DOMException("Import cancelled", "AbortError");
  }

  const seenRefs = new Set<string>();
  if (candidates.length > 0) {
    const existing = await db
      .select({ ref: schema.transactions.source_ref })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.account_id, data.accountId),
          inArray(
            schema.transactions.source_ref,
            candidates.map((c) => c.hash),
          ),
        ),
      );
    for (const e of existing) {
      if (e.ref !== null) seenRefs.add(e.ref);
    }
  }

  const insertRows: (typeof schema.transactions.$inferInsert)[] = [];
  for (const c of candidates) {
    const persistCheck = abortControllers.get(String(requestId));
    if (persistCheck?.signal.aborted) {
      throw new Error("Import cancelled");
    }

    if (seenRefs.has(c.hash)) {
      duplicateRows.push({
        date: c.date,
        amountMinor: c.amountMinor,
        description: c.description,
      });
      yield {
        type: "duplicate",
        current: candidates.indexOf(c) + 1,
        total: candidates.length,
        row: {
          rowIndex: c.rowIndex,
          date: c.date,
          amountMinor: c.amountMinor,
          description: c.description,
          category: c.categoryId
            ? (categoryByName.get(c.categoryId) ?? null)
            : null,
        },
      };
      continue;
    }
    seenRefs.add(c.hash);
    insertRows.push({
      id: crypto.randomUUID(),
      user_id: userId,
      account_id: data.accountId,
      date: c.date,
      amount_minor: c.amountMinor,
      description: c.description || null,
      category_id: c.categoryId,
      source: "csv_import",
      source_ref: c.hash,
      import_batch_id: batchId,
    });
    imported++;
    if (c.categoryId) {
      if (!aiCategorizedHashes.has(c.hash)) {
        autoCategorized++;
        const catName = categoryByName.get(c.categoryId);
        yield {
          type: "ruleMatch",
          current: candidates.indexOf(c) + 1,
          total: candidates.length,
          row: {
            rowIndex: c.rowIndex,
            date: c.date,
            amountMinor: c.amountMinor,
            description: c.description,
            category: catName ?? null,
          },
        };
      }
    } else {
      uncategorized++;
      yield {
        type: "uncategorized",
        current: candidates.indexOf(c) + 1,
        total: candidates.length,
        row: {
          rowIndex: c.rowIndex,
          date: c.date,
          amountMinor: c.amountMinor,
          description: c.description,
        },
      };
    }
  }

  const persistController = abortControllers.get(String(requestId));
  if (persistController?.signal.aborted) {
    throw new DOMException("Import cancelled", "AbortError");
  }

  const duplicates = duplicateRows.length;
  const errors = errorRows.length;

  if (insertRows.length > 0) {
    await db.insert(schema.import_batches).values({
      id: batchId,
      user_id: userId,
      account_id: data.accountId,
      filename: data.filename,
      row_count: insertRows.length,
    });
    await db.insert(schema.transactions).values(insertRows);

    if (aiRulesToCreate.length > 0) {
      const aiRulesInsert = aiRulesToCreate.map((rule) => ({
        id: crypto.randomUUID(),
        user_id: userId,
        pattern: rule.pattern,
        match_type: rule.match_type,
        category_id: rule.category_id,
        priority: rule.priority,
        source: "ai" as const,
      }));
      await db.insert(schema.categorization_rules).values(aiRulesInsert);

      for (const rule of aiRulesToCreate) {
        yield {
          type: "newRule",
          current: aiRulesToCreate.indexOf(rule) + 1,
          total: aiRulesToCreate.length,
          row: {
            rowIndex: 0,
            date: "",
            amountMinor: 0,
            description: rule.pattern,
          },
          rule: {
            pattern: rule.pattern,
            match_type: rule.match_type,
            category_name: rule.category_name,
          },
        };
      }
    }
  }

  if (insertRows.length > 0) {
    // Imported rows can push this month's spending over a budget.
    await safeEvaluateBudgetAlerts(userId);
  }

  yield {
    type: "complete",
    summary: {
      imported,
      autoCategorized,
      aiCategorized,
      uncategorized,
      duplicates,
      errors,
      duplicateRows,
      errorRows,
      batchId: insertRows.length > 0 ? batchId : null,
      newRules: aiRulesToCreate.map((r) => ({
        pattern: r.pattern,
        match_type: r.match_type,
        category_name: r.category_name,
      })) as RuleSummary[],
      mismatchedPatterns,
    },
  };
}

// --- Import history & undo ---

const deleteImportBatchSchema = z.object({
  batchId: z.string().min(1),
});

export const getImportHistory = createServerFn({ method: "GET" }).handler(
  async () => {
    const userId = await requireUserId();
    const rows = await db
      .select({
        id: schema.import_batches.id,
        filename: schema.import_batches.filename,
        created_at: schema.import_batches.created_at,
        account_id: schema.import_batches.account_id,
        account_name: schema.accounts.name,
        account_currency: schema.accounts.currency,
        transaction_count: sql<number>`(
          SELECT COUNT(*) FROM ${schema.transactions}
          WHERE ${schema.transactions.import_batch_id} = ${schema.import_batches.id}
        )`.mapWith(Number),
      })
      .from(schema.import_batches)
      .leftJoin(
        schema.accounts,
        eq(schema.import_batches.account_id, schema.accounts.id),
      )
      .where(eq(schema.import_batches.user_id, userId))
      .orderBy(
        desc(schema.import_batches.created_at),
        desc(schema.import_batches.id),
      );
    return rows;
  },
);

export const deleteImportBatch = createServerFn({ method: "POST" })
  .inputValidator(deleteImportBatchSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    const batch = await db
      .select({ id: schema.import_batches.id })
      .from(schema.import_batches)
      .where(
        and(
          eq(schema.import_batches.id, data.batchId),
          eq(schema.import_batches.user_id, userId),
        ),
      )
      .limit(1);
    if (batch.length === 0) {
      return { error: "Import batch not found" };
    }

    const batchTransactions = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.user_id, userId),
          eq(schema.transactions.import_batch_id, data.batchId),
        ),
      );
    const transactionIds = batchTransactions.map((t) => t.id);

    if (transactionIds.length > 0) {
      const associatedReceipts = await db
        .select({ id: schema.receipts.id })
        .from(schema.receipts)
        .where(inArray(schema.receipts.transaction_id, transactionIds));
      const receiptIds = associatedReceipts.map((r) => r.id);
      if (receiptIds.length > 0) {
        await db
          .delete(schema.receipt_items)
          .where(inArray(schema.receipt_items.receipt_id, receiptIds));
        await db
          .delete(schema.receipts)
          .where(inArray(schema.receipts.id, receiptIds));
      }
      await db
        .delete(schema.transactions)
        .where(
          and(
            eq(schema.transactions.user_id, userId),
            eq(schema.transactions.import_batch_id, data.batchId),
          ),
        );
    }

    await db
      .delete(schema.import_batches)
      .where(
        and(
          eq(schema.import_batches.id, data.batchId),
          eq(schema.import_batches.user_id, userId),
        ),
      );

    return { success: true, deletedTransactions: transactionIds.length };
  });
