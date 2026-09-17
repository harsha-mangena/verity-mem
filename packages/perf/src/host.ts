/**
 * Facts about the machine, the database and the index that produced a measurement.
 *
 * Everything here is *read*, never hardcoded. A latency figure with a hand-written
 * hardware string next to it is a rumour: it survives a `git clone` onto a different
 * laptop and keeps claiming the same CPU. The one thing this module deliberately does
 * **not** do is decide whether the machine counts as a reference machine — it records
 * what it found and `report.ts` labels the result accordingly.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { totalmem, cpus, platform, arch, release, version as osVersion } from "node:os";
import type pg from "pg";

export interface HostFacts {
  readonly cpu_model: string;
  readonly cpu_cores_logical: number;
  readonly cpu_cores_physical: number | null;
  readonly cpu_performance_cores: number | null;
  readonly cpu_efficiency_cores: number | null;
  readonly ram_bytes: number;
  readonly ram_gb: number;
  readonly os: string;
  readonly os_version: string;
  readonly kernel: string;
  readonly arch: string;
  readonly node_version: string;
  /** True when the machine reports a battery, i.e. it is a laptop. */
  readonly is_laptop: boolean | null;
  readonly source: string;
}

export interface PostgresFacts {
  readonly version: string;
  readonly version_num: number;
  readonly pgvector_version: string | null;
  readonly database_size_bytes: number;
  readonly settings: Readonly<Record<string, string>>;
  readonly hnsw: readonly HnswIndex[];
  readonly indexes: readonly IndexFact[];
  readonly table_sizes: readonly TableSize[];
}

export interface HnswIndex {
  readonly index_name: string;
  readonly table_name: string;
  readonly columns: string;
  readonly operator_class: string;
  readonly m: number | null;
  readonly ef_construction: number | null;
  readonly definition: string;
  readonly size_bytes: number | null;
}

export interface IndexFact {
  readonly index_name: string;
  readonly table_name: string;
  readonly access_method: string;
  readonly columns: string;
  readonly size_bytes: number | null;
}

export interface TableSize {
  readonly table_name: string;
  readonly rows: number;
  readonly total_bytes: number;
  readonly index_bytes: number;
}

/**
 * Read the machine's own description of itself.
 *
 * `sysctl` on Darwin and `/proc`+`lscpu` on Linux, because Node's `os.cpus()` reports
 * "Apple M1 Pro" on macOS but a generic family string on many Linux kernels, and the
 * exact model is the part a reader needs in order to compare their run with this one.
 */
export function readHostFacts(): HostFacts {
  const platformName = platform();
  let cpuModel = cpus()[0]?.model ?? "unknown";
  let physical: number | null = null;
  let performance: number | null = null;
  let efficiency: number | null = null;
  let laptop: boolean | null = null;
  let source = "node:os";

  if (platformName === "darwin") {
    cpuModel = sysctl("machdep.cpu.brand_string") ?? cpuModel;
    const physicalCores = sysctl("hw.physicalcpu");
    physical = physicalCores === null ? null : Number(physicalCores);
    const perf = sysctl("hw.perflevel0.physicalcpu");
    const eff = sysctl("hw.perflevel1.physicalcpu");
    performance = perf === null ? null : Number(perf);
    efficiency = eff === null ? null : Number(eff);
    laptop = sysctl("hw.model") !== null;
    source = "sysctl + node:os";
  } else if (platformName === "linux") {
    const cpuinfo = safeRead("/proc/cpuinfo");
    const match = /^model name\s*:\s*(.+)$/m.exec(cpuinfo ?? "");
    if (match?.[1]) cpuModel = match[1].trim();
    const cores = /^cpu cores\s*:\s*(\d+)$/m.exec(cpuinfo ?? "");
    physical = cores?.[1] ? Number(cores[1]) * countSockets(cpuinfo ?? "") : null;
    laptop = safeRead("/sys/class/power_supply/BAT0/type")?.trim() === "Battery";
    source = "/proc/cpuinfo + node:os";
  }

  return {
    cpu_model: cpuModel,
    cpu_cores_logical: cpus().length,
    cpu_cores_physical: physical,
    cpu_performance_cores: performance,
    cpu_efficiency_cores: efficiency,
    ram_bytes: totalmem(),
    ram_gb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    os: `${platformName} ${osVersion()}`,
    os_version: platformName === "darwin" ? (sysctl("kern.osproductversion") ?? osVersion()) : osVersion(),
    kernel: release(),
    arch: arch(),
    node_version: process.version,
    is_laptop: laptop,
    source,
  };
}

function countSockets(cpuinfo: string): number {
  const ids = new Set<string>();
  for (const match of cpuinfo.matchAll(/^physical id\s*:\s*(\d+)$/gm)) {
    if (match[1]) ids.add(match[1]);
  }
  return Math.max(1, ids.size);
}

function sysctl(key: string): string | null {
  try {
    return execFileSync("sysctl", ["-n", key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const PgVersion = (() => {
  try {
    return createRequire(import.meta.url)("pg").version as string;
  } catch {
    return "unknown";
  }
})();

/** The `pg` client library version, recorded so a driver change is visible in a diff. */
export function readPgLibraryVersion(): string {
  return PgVersion;
}

/** Index parameters and server configuration, read from the database that was measured. */
export async function readPostgresFacts(client: pg.PoolClient): Promise<PostgresFacts> {
  const version = await client.query<{ version: string; version_num: number }>(
    `SELECT version() AS version, current_setting('server_version_num')::int AS version_num`,
  );
  const vector = await client.query<{ extversion: string }>(
    `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
  );
  const size = await client.query<{ bytes: number }>(
    `SELECT pg_database_size(current_database())::bigint AS bytes`,
  );

  const settingNames = [
    "shared_buffers",
    "work_mem",
    "maintenance_work_mem",
    "effective_cache_size",
    "max_connections",
    "max_worker_processes",
    "max_parallel_workers",
    "max_parallel_workers_per_gather",
    "random_page_cost",
    "synchronous_commit",
    "wal_level",
    "jit",
    "track_io_timing",
    "hnsw.ef_search",
    "hnsw.iterative_scan",
    "hnsw.max_scan_tuples",
    "hnsw.scan_mem_multiplier",
  ];
  const settings = await client.query<{ name: string; setting: string }>(
    `SELECT name, setting FROM pg_settings WHERE name = ANY($1::text[]) ORDER BY name`,
    [settingNames],
  );

  const indexRows = await client.query<{
    index_name: string;
    table_name: string;
    access_method: string;
    columns: string;
    definition: string;
    size_bytes: number | null;
  }>(
    `SELECT c.relname AS index_name,
            t.relname AS table_name,
            am.amname  AS access_method,
            pg_get_indexdef(i.indexrelid) AS definition,
            pg_get_indexdef(i.indexrelid, 0, true) AS columns,
            pg_relation_size(c.oid)::bigint AS size_bytes
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_am am ON am.oid = c.relam
      WHERE t.relnamespace = 'public'::regnamespace
        AND t.relname IN ('claims','claim_embeddings','evidence_spans','events','entity_aliases','claim_relations')
      ORDER BY t.relname, c.relname`,
  );

  const tableRows = await client.query<{
    table_name: string;
    rows: number;
    total_bytes: number;
    index_bytes: number;
  }>(
    `SELECT c.relname AS table_name,
            GREATEST(c.reltuples, 0)::bigint AS rows,
            pg_total_relation_size(c.oid)::bigint AS total_bytes,
            pg_indexes_size(c.oid)::bigint AS index_bytes
       FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relkind = 'r'
        AND c.relname IN ('claims','claim_embeddings','evidence_spans','events','claim_relations','entity_aliases')
      ORDER BY c.relname`,
  );

  const indexes: IndexFact[] = indexRows.rows.map((row) => ({
    index_name: row.index_name,
    table_name: row.table_name,
    access_method: row.access_method,
    columns: row.columns,
    size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
  }));

  const hnsw: HnswIndex[] = indexRows.rows
    .filter((row) => row.access_method === "hnsw")
    .map((row) => ({
      index_name: row.index_name,
      table_name: row.table_name,
      columns: row.columns,
      operator_class: /vector_\w+_ops/.exec(row.definition)?.[0] ?? "unknown",
      m: numericOption(row.definition, "m"),
      ef_construction: numericOption(row.definition, "ef_construction"),
      definition: row.definition,
      size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
    }));

  const settingsMap: Record<string, string> = {};
  for (const row of settings.rows) settingsMap[row.name] = row.setting;

  return {
    version: version.rows[0]?.version ?? "unknown",
    version_num: Number(version.rows[0]?.version_num ?? 0),
    pgvector_version: vector.rows[0]?.extversion ?? null,
    database_size_bytes: Number(size.rows[0]?.bytes ?? 0),
    settings: settingsMap,
    hnsw,
    indexes,
    table_sizes: tableRows.rows.map((row) => ({
      table_name: row.table_name,
      rows: Number(row.rows),
      total_bytes: Number(row.total_bytes),
      index_bytes: Number(row.index_bytes),
    })),
  };
}

function numericOption(definition: string, key: string): number | null {
  const match = new RegExp(`${key}\\s*=\\s*'?(\\d+)'?`, "i").exec(definition);
  if (!match?.[1]) return null;
  return Number(match[1]);
}

/** Buffer-cache counters for the tables the read path touches, before and after a pass. */
export interface BufferStats {
  readonly heap_blks_read: number;
  readonly heap_blks_hit: number;
  readonly idx_blks_read: number;
  readonly idx_blks_hit: number;
  readonly hit_ratio: number | null;
}

/**
 * `pg_statio_user_tables` counters summed over the read path's tables.
 *
 * Reported so that "cold" and "warm" are *evidenced* rather than asserted: a reader
 * can see whether the buffers were actually being filled during the pass. These are
 * cumulative counters, so a pass reports the delta between two reads.
 */
export async function readBufferStats(client: pg.PoolClient): Promise<BufferStats> {
  const result = await client.query<{
    heap_blks_read: number;
    heap_blks_hit: number;
    idx_blks_read: number;
    idx_blks_hit: number;
  }>(
    `SELECT COALESCE(sum(heap_blks_read), 0)::bigint AS heap_blks_read,
            COALESCE(sum(heap_blks_hit), 0)::bigint  AS heap_blks_hit,
            COALESCE(sum(idx_blks_read), 0)::bigint  AS idx_blks_read,
            COALESCE(sum(idx_blks_hit), 0)::bigint   AS idx_blks_hit
       FROM pg_statio_user_tables
      WHERE relname IN ('claims','claim_embeddings','evidence_spans','events','claim_relations','entity_aliases','scopes','principal_scopes')`,
  );
  const row = result.rows[0];
  const heapRead = Number(row?.heap_blks_read ?? 0);
  const heapHit = Number(row?.heap_blks_hit ?? 0);
  const idxRead = Number(row?.idx_blks_read ?? 0);
  const idxHit = Number(row?.idx_blks_hit ?? 0);
  const reads = heapRead + idxRead;
  const hits = heapHit + idxHit;
  return {
    heap_blks_read: heapRead,
    heap_blks_hit: heapHit,
    idx_blks_read: idxRead,
    idx_blks_hit: idxHit,
    hit_ratio: reads + hits === 0 ? null : hits / (reads + hits),
  };
}
