import type { CorpusDocument } from "./types";

interface DuckDbBundle {
  mainModule: string;
  mainWorker: string;
}

interface DuckDbBundles {
  mvp: DuckDbBundle;
  eh: DuckDbBundle;
}

interface DuckDbSelectedBundle {
  mainModule: string;
  mainWorker?: string;
  pthreadWorker?: string;
}

interface DuckDbLogger {}

interface DuckDbConnection {
  query(sql: string): Promise<{ toArray(): unknown[] }>;
  close(): Promise<void>;
}

interface DuckDbInstance {
  connect(): Promise<DuckDbConnection>;
  instantiate(mainModule: string, pthreadWorker?: string): Promise<void>;
}

interface DuckDbRuntime {
  selectBundle(bundles: DuckDbBundles): Promise<DuckDbSelectedBundle>;
  VoidLogger: new () => DuckDbLogger;
  AsyncDuckDB: new (logger: DuckDbLogger, worker: Worker) => DuckDbInstance;
}

let duckDbRuntimePromise: Promise<DuckDbRuntime> | null = null;
let duckDbPromise: Promise<DuckDbInstance> | null = null;
let duckDbBundlesPromise: Promise<DuckDbBundles> | null = null;
const parquetQueryPromises = new Map<string, Promise<Record<string, unknown>[]>>();
const MAX_PARQUET_QUERY_CACHE_ENTRIES = 96;

export interface DuckDbParquetQuery {
  clusterIds?: number[];
  includeNullCluster?: boolean;
  clusterColumn?: string;
  clusterFilterDocTypes?: string[];
  docTypes?: string[];
  docIds?: string[];
  documentReferences?: string[];
  serviceDocIds?: string[];
  limit?: number;
  orderBy?: string[];
  columns?: string[];
}

export interface DuckDbDocumentQuery extends DuckDbParquetQuery {
  includeUnclusteredServices?: boolean;
}

export async function queryParquetRows(
  parquetUrl: string,
  query: DuckDbParquetQuery = {},
): Promise<Record<string, unknown>[]> {
  const cacheKey = parquetQueryCacheKey(parquetUrl, query);
  const cached = parquetQueryPromises.get(cacheKey);
  if (cached) {
    return cached;
  }
  const queryPromise = queryParquetRowsUncached(parquetUrl, query).catch((error) => {
    parquetQueryPromises.delete(cacheKey);
    throw error;
  });
  rememberParquetQuery(cacheKey, queryPromise);
  return queryPromise;
}

export function clearDuckDbParquetQueryCache(): void {
  parquetQueryPromises.clear();
}

async function queryParquetRowsUncached(
  parquetUrl: string,
  query: DuckDbParquetQuery = {},
): Promise<Record<string, unknown>[]> {
  const database = await getDuckDb();
  const connection = await database.connect();
  try {
    const table = await connection.query(buildReadParquetQuery(parquetUrl, query));
    return table
      .toArray()
      .map((row: unknown) => normalizeDuckDbValue(row))
      .map((row: unknown) => toRecord(row));
  } finally {
    await connection.close();
  }
}

function rememberParquetQuery(cacheKey: string, promise: Promise<Record<string, unknown>[]>): void {
  if (parquetQueryPromises.size >= MAX_PARQUET_QUERY_CACHE_ENTRIES) {
    const oldestKey = parquetQueryPromises.keys().next().value;
    if (oldestKey) {
      parquetQueryPromises.delete(oldestKey);
    }
  }
  parquetQueryPromises.set(cacheKey, promise);
}

function parquetQueryCacheKey(parquetUrl: string, query: DuckDbParquetQuery): string {
  return JSON.stringify({
    parquetUrl,
    clusterIds: query.clusterIds || [],
    includeNullCluster: Boolean(query.includeNullCluster),
    clusterColumn: query.clusterColumn || "",
    clusterFilterDocTypes: query.clusterFilterDocTypes || [],
    docTypes: query.docTypes || [],
    docIds: query.docIds || [],
    documentReferences: query.documentReferences || [],
    serviceDocIds: query.serviceDocIds || [],
    limit: query.limit || 0,
    orderBy: query.orderBy || [],
    columns: query.columns || [],
  });
}

export async function loadDocumentsFromParquet(
  parquetUrl: string,
  query: DuckDbDocumentQuery = {},
): Promise<CorpusDocument[]> {
  const rows = await queryParquetRows(parquetUrl, {
    ...query,
    includeNullCluster: query.includeUnclusteredServices,
    clusterColumn: "geo_cluster_id",
    clusterFilterDocTypes: query.clusterIds?.length || query.includeUnclusteredServices ? ["service"] : undefined,
    orderBy: query.clusterIds?.length
      ? [
          buildClusterOrderExpression(query.clusterIds, Boolean(query.includeUnclusteredServices), "geo_cluster_id"),
          "doc_type ASC",
          "city ASC",
          "state ASC",
          "doc_id ASC",
        ]
      : ["doc_type ASC", "city ASC", "state ASC", "doc_id ASC"],
  });
  return rows.map((row) => coerceCorpusDocumentFromRow(row));
}

async function getDuckDbRuntime(): Promise<DuckDbRuntime> {
  if (!duckDbRuntimePromise) {
    duckDbRuntimePromise = loadDuckDbRuntime();
  }
  return duckDbRuntimePromise;
}

async function getDuckDb(): Promise<DuckDbInstance> {
  if (!duckDbPromise) {
    duckDbPromise = instantiateDuckDb();
  }
  return duckDbPromise;
}

async function instantiateDuckDb(): Promise<DuckDbInstance> {
  const runtime = await getDuckDbRuntime();
  const bundle = await runtime.selectBundle(await loadDuckDbBundles());
  if (!bundle.mainWorker) {
    throw new Error("DuckDB worker URL was not resolved.");
  }
  const worker = new Worker(bundle.mainWorker!);
  const logger = new runtime.VoidLogger();
  const database = new runtime.AsyncDuckDB(logger, worker);
  await database.instantiate(bundle.mainModule, bundle.pthreadWorker);
  return database;
}

async function loadDuckDbRuntime(): Promise<DuckDbRuntime> {
  const packageName = "@duckdb/duckdb-wasm";
  try {
    return (await import(/* @vite-ignore */ packageName)) as unknown as DuckDbRuntime;
  } catch {
    throw new Error(
      "DuckDB support is unavailable because @duckdb/duckdb-wasm is not installed in this environment.",
    );
  }
}

async function loadDuckDbBundles(): Promise<DuckDbBundles> {
  if (!duckDbBundlesPromise) {
    const distBase = "@duckdb/duckdb-wasm/dist";
    duckDbBundlesPromise = Promise.all([
      import(/* @vite-ignore */ `${distBase}/duckdb-mvp.wasm?url`),
      import(/* @vite-ignore */ `${distBase}/duckdb-browser-mvp.worker.js?url`),
      import(/* @vite-ignore */ `${distBase}/duckdb-eh.wasm?url`),
      import(/* @vite-ignore */ `${distBase}/duckdb-browser-eh.worker.js?url`),
    ]).then(([duckdbWasmMvp, duckdbWorkerMvp, duckdbWasmEh, duckdbWorkerEh]) => ({
      mvp: {
        mainModule: duckdbWasmMvp.default,
        mainWorker: duckdbWorkerMvp.default,
      },
      eh: {
        mainModule: duckdbWasmEh.default,
        mainWorker: duckdbWorkerEh.default,
      },
    }));
  }
  return duckDbBundlesPromise;
}

export function coerceCorpusDocumentFromRow(value: unknown): CorpusDocument {
  const row = toRecord(value);
  return {
    doc_id: stringValue(row.doc_id),
    doc_type: stringValue(row.doc_type),
    title: stringValue(row.title),
    text: stringValue(row.text),
    text_truncated: Boolean(row.text_truncated),
    source_url: stringValue(row.source_url),
    source_content_cid: stringValue(row.source_content_cid),
    source_page_cid: stringValue(row.source_page_cid),
    provider_name: stringValue(row.provider_name),
    program_name: stringValue(row.program_name),
    categories: stringValue(row.categories),
    host: stringValue(row.host),
    city: stringValue(row.city),
    state: stringValue(row.state),
    geo_lat: numberOrNull(row.geo_lat),
    geo_lon: numberOrNull(row.geo_lon),
    geo_precision: stringValue(row.geo_precision),
    geo_cluster_id: integerOrNull(row.geo_cluster_id),
    phones: arrayValue(row.phones),
    emails: arrayValue(row.emails),
    websites: arrayValue(row.websites),
    addresses: arrayValue(row.addresses),
    hours: arrayValue(row.hours),
    eligibility: arrayValue(row.eligibility),
    intake_steps: arrayValue(row.intake_steps),
    required_documents: arrayValue(row.required_documents),
    fees: arrayValue(row.fees),
    languages: arrayValue(row.languages),
    accessibility: arrayValue(row.accessibility),
    travel_info: arrayValue(row.travel_info),
    area_served: arrayValue(row.area_served),
    geo: recordOrNull(row.geo),
  };
}

function normalizeDuckDbValue(value: unknown): unknown {
  if (value == null) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeDuckDbValue(item));
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<unknown>, (item) => normalizeDuckDbValue(item));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    const withJson = value as { toJSON?: () => unknown };
    if (typeof withJson.toJSON === "function") {
      const jsonValue = withJson.toJSON();
      if (jsonValue !== value) {
        return normalizeDuckDbValue(jsonValue);
      }
    }
    const entries = Object.entries(value as Record<string, unknown>);
    return Object.fromEntries(entries.map(([key, child]) => [key, normalizeDuckDbValue(child)]));
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function numberOrNull(value: unknown): number | null | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function integerOrNull(value: unknown): number | null | undefined {
  const numeric = numberOrNull(value);
  return numeric == null ? numeric : Math.trunc(numeric);
}

function arrayValue(value: unknown): any[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function recordOrNull(value: unknown): Record<string, unknown> | null | undefined {
  if (value == null) {
    return undefined;
  }
  return isRecord(value) ? value : null;
}

function buildReadParquetQuery(parquetUrl: string, query: DuckDbParquetQuery): string {
  const whereClauses: string[] = [];
  if (query.docTypes?.length) {
    whereClauses.push(`doc_type IN (${query.docTypes.map(sqlStringLiteral).join(", ")})`);
  }
  if (query.clusterIds?.length) {
    const clusterColumn = query.clusterColumn || "geo_cluster_id";
    const clusterClauses = [
      `${clusterColumn} IN (${query.clusterIds.map((value) => String(Math.trunc(value))).join(", ")})`,
    ];
    if (query.includeNullCluster) {
      clusterClauses.push(`${clusterColumn} IS NULL`);
    }
    const clusterClause = `(${clusterClauses.join(" OR ")})`;
    if (query.clusterFilterDocTypes?.length) {
      whereClauses.push(`(doc_type IN (${query.clusterFilterDocTypes.map(sqlStringLiteral).join(", ")}) AND ${clusterClause})`);
    } else {
      whereClauses.push(clusterClause);
    }
  } else if (query.includeNullCluster) {
    const clusterColumn = query.clusterColumn || "geo_cluster_id";
    if (query.clusterFilterDocTypes?.length) {
      whereClauses.push(
        `(doc_type IN (${query.clusterFilterDocTypes.map(sqlStringLiteral).join(", ")}) AND ${clusterColumn} IS NULL)`,
      );
    } else {
      whereClauses.push(`${clusterColumn} IS NULL`);
    }
  }
  if (query.docIds?.length) {
    whereClauses.push(`doc_id IN (${query.docIds.map(sqlStringLiteral).join(", ")})`);
  }
  if (query.documentReferences?.length) {
    const references = query.documentReferences.map(sqlStringLiteral).join(", ");
    whereClauses.push(
      `(doc_id IN (${references}) OR source_content_cid IN (${references}) OR source_page_cid IN (${references}))`,
    );
  }
  if (query.serviceDocIds?.length) {
    whereClauses.push(`service_doc_id IN (${query.serviceDocIds.map(sqlStringLiteral).join(", ")})`);
  }

  const selectColumns = query.columns?.length ? query.columns.join(", ") : "*";
  const clauses = [`SELECT ${selectColumns} FROM read_parquet(${sqlStringLiteral(parquetUrl)})`];
  if (whereClauses.length) {
    clauses.push(`WHERE ${whereClauses.join(" AND ")}`);
  }
  if (query.orderBy?.length) {
    clauses.push(`ORDER BY ${query.orderBy.join(", ")}`);
  }
  if (query.limit && query.limit > 0) {
    clauses.push(`LIMIT ${Math.trunc(query.limit)}`);
  }
  return clauses.join(" ");
}

function buildClusterOrderExpression(clusterIds: number[], includeNullCluster: boolean, clusterColumn: string): string {
  return `CASE ${clusterIds
    .map((clusterId, index) => `WHEN ${clusterColumn} = ${String(Math.trunc(clusterId))} THEN ${index}`)
    .join(" ")}${includeNullCluster ? ` WHEN ${clusterColumn} IS NULL THEN ${clusterIds.length}` : ""} ELSE ${
    clusterIds.length + (includeNullCluster ? 1 : 0)
  } END`;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
