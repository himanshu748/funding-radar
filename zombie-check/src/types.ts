export type EntityKind = "company" | "tool" | "job";
export type Verdict = "alive" | "dead" | "unknown";
export class ZombieError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface InputIssue {
  row: number;
  code: "INVALID_NAME" | "INVALID_KIND" | "INVALID_URL" | "DUPLICATE_URL";
  message: string;
}
export interface InputRow {
  id: string;
  name: string;
  originalUrl: string;
  kind: EntityKind | null;
  canonicalUrl: string | null;
  sourceRow: number;
  issues: InputIssue[];
}
export interface InputSheet {
  mode: "user_supplied" | "synthetic_fixture";
  rows: InputRow[];
  validRows: number;
  minimumRows: number;
  meetsMinimum: boolean;
  issues: InputIssue[];
}
export interface Batch {
  id: string;
  rows: InputRow[];
  manifest: string;
}
export interface TinySetRow {
  id: string;
  data: Record<string, unknown>;
}
export interface TinySetPage {
  rows: TinySetRow[];
  truncated: boolean;
  nextCursor: string | null;
}
export type StatusSignal =
  "active" | "closed" | "job_open" | "job_closed" | "unknown";
export interface CollectedPage {
  datasetId: string;
  runId: string;
  collectedAt: string;
  mode: "saved_live" | "synthetic_fixture";
  rows: TinySetRow[];
}
export interface Evidence {
  datasetId: string;
  runId: string;
  rowId: string;
  collectedAt: string;
  mode: CollectedPage["mode"];
  sourceUrl: string;
  summary: string;
  signal: StatusSignal;
  effectiveOn: string | null;
  provenance: "provider_reported";
}
export interface RowResult {
  input: InputRow;
  verdict: Verdict;
  reason: string;
  evidence: Evidence[];
  warnings: string[];
}
export interface ZombieReport {
  generatedAt: string;
  mode: "saved_live" | "synthetic_fixture" | "mixed" | "no_observations";
  inputCount: number;
  validInputCount: number;
  meetsMinimumInput: boolean;
  results: RowResult[];
  totals: Record<Verdict, number>;
  unmatchedProviderRows: number;
  warnings: string[];
}
