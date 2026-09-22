/**
 * Structural plan digests.
 *
 * ## Why a digest at all
 *
 * `EXPLAIN ANALYZE` output contains timing and buffer counters that change on every run.
 * Two executions of the same query on the same data produce plans that differ in dozens
 * of fields and agree in the only ones that matter: the node types, the relations and
 * indexes touched, the join and filter structure, the sort keys, and the parallel
 * topology. A regression test that compared raw plans would be flaky; one that compared
 * nothing would be useless.
 *
 * So the raw plan is reduced to a canonical structural form, that form is hashed, and
 * **both** are stored: the digest for comparison, the raw plan for diagnosis. A digest
 * that disagrees tells you something changed; the raw plans tell you what.
 *
 * ## What is removed, and why the list is explicit
 *
 * Removal is by name, not by "anything numeric". A structural field that happens to be a
 * number — an index column position, a `Parallel Aware` flag's neighbours — is kept,
 * because losing it would hide a real change. The volatile fields are enumerated in
 * `VOLATILE_KEYS` so that adding one to the ignore list is a deliberate act with a
 * reviewer looking at it.
 *
 * The one judgement call worth naming: **estimated** row counts (`Plan Rows`,
 * `Total Cost`) are also dropped. They are not volatile after a re-plan — a deterministic
 * planner produces them identically — but they are sensitive to statistics,
 * `effective_cache_size` and table size, so keeping them would make the digest change
 * when the *data* changed rather than when the *plan shape* changed. This artifact is for
 * detecting shape regressions, and conflating the two would make it noisy for the thing it
 * is for. The estimates survive in the raw plan.
 */
import { createHash } from "node:crypto";
import { canonicalExpression } from "./plan-sanitize.ts";

/**
 * Keys whose string value is a rewritten SQL expression rather than an identifier.
 *
 * The same set the sanitizer uses, for the same reason: these are the fields PostgreSQL
 * fills with the statement plus its bound values.
 */
const EXPRESSION_BEARING = new Set([
  "Filter",
  "Index Cond",
  "Recheck Cond",
  "Hash Cond",
  "Join Filter",
  "Merge Cond",
  "One-Time Filter",
  "Index Recheck",
  "Function Call",
  "Output",
  "Sort Key",
  "Group Key",
  "Cache Key",
  "Cache Mode",
  "Presorted Key",
  "Order By",
]);

/**
 * Fields dropped from the canonical form: everything that varies between two executions
 * of the same plan on the same data, plus planner estimates that vary with statistics.
 */
const VOLATILE_KEYS = new Set([
  // Timing.
  "Planning Time",
  "Execution Time",
  "Actual Startup Time",
  "Actual Total Time",
  // Row and loop counts.
  "Actual Rows",
  "Actual Loops",
  "Plan Rows",
  "Plan Width",
  // Cost estimates.
  "Startup Cost",
  "Total Cost",
  // Buffer counters.
  "Shared Hit Blocks",
  "Shared Read Blocks",
  "Shared Dirtied Blocks",
  "Shared Written Blocks",
  "Local Hit Blocks",
  "Local Read Blocks",
  "Local Dirtied Blocks",
  "Local Written Blocks",
  "Temp Read Blocks",
  "Temp Written Blocks",
  // WAL counters.
  "WAL Records",
  "WAL FPI",
  "WAL Bytes",
  "WAL Buffers Full",
  /**
   * `Workers Launched` is runtime: PostgreSQL reports how many workers it actually started,
   * which varies with load and `max_parallel_workers`. Two runs of the same plan can report
   * different numbers, so it cannot be part of a digest that is meant to detect *shape*
   * change.
   */
  "Workers Launched",
  /**
   * `Workers Planned` is **kept**. It is the planner's decision — part of the topology —
   * and dropping it would make a plan that intends two workers indistinguishable from one
   * that intends none. `Parallel Aware` is likewise kept, because it is what distinguishes a
   * parallel-aware node from its serial form.
   */
  // Measurements that move with the data rather than with the shape.
  "Peak Memory Usage",
  "Rows Removed by Filter",
  "Rows Removed by Join Filter",
  "Rows Removed by Index Recheck",
  "Sort Method",
  "Sort Space Used",
  "Sort Space Type",
  "Memory Usage",
  "Disk Usage",
]);

/**
 * Reduce one plan node — and its children — to a canonical structural value.
 *
 * Objects are emitted with sorted keys so that key order, which PostgreSQL does not
 * promise, cannot change the digest. Arrays keep their order: sibling plan nodes are ordered
 * by execution and a reordering is a real change.
 *
 * **Expression strings are canonicalized**, not merely sanitized. `EXPLAIN` rewrites a
 * statement with its bound values substituted, so two captures of the same query shape for
 * two different tenants produce `Index Cond: (tenant_id = '3f2a…'::uuid)` and
 * `(tenant_id = '9c1b…'::uuid)`. Hashing those verbatim would give different digests for
 * identical topology — which defeats the whole purpose, since the digest exists to answer
 * "did the plan shape change?" and the answer would be "yes" on every run against different
 * data. Canonicalization replaces literals and UUIDs with placeholders first, so the digest
 * is a function of topology, relations, indexes, join structure and operators.
 */
function canonicalNode(node: unknown, key?: string): unknown {
  if (Array.isArray(node)) return node.map((child) => canonicalNode(child, key));
  if (node === null || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  for (const childKey of Object.keys(node as Record<string, unknown>).sort()) {
    if (VOLATILE_KEYS.has(childKey)) continue;
    const value = (node as Record<string, unknown>)[childKey];
    // A string under a key that carries an expression is canonicalized; identifiers such as
    // `Relation Name` and `Index Name` are preserved because a different relation *is* a
    // different plan.
    if (typeof value === "string" && EXPRESSION_BEARING.has(childKey)) {
      out[childKey] = canonicalExpression(value);
    } else {
      out[childKey] = canonicalNode(value, childKey);
    }
  }
  return out;
}

/**
 * Canonical structural form of one `EXPLAIN (FORMAT JSON)` document.
 *
 * The top level of the explain output is an array of one object holding `Plan` beside the
 * volatile `Planning Time` and `Execution Time`. Only the plan tree is structural;
 * `Triggers` is kept because a trigger firing is a real behavioural difference.
 */
export function canonicalPlan(explainRows: readonly unknown[]): unknown {
  if (!Array.isArray(explainRows) || explainRows.length === 0) return null;
  const document = explainRows[0] as Record<string, unknown> | null | undefined;
  // `null` is `typeof "object"`, so the null check is not redundant with the type check —
  // without it the `in` below throws on a document PostgreSQL never produces but a caller
  // can: an explain result that came back empty.
  if (document === null || document === undefined || typeof document !== "object") return null;

  const out: Record<string, unknown> = {};
  if ("Plan" in document) out["Plan"] = canonicalNode(document["Plan"]);
  if ("Triggers" in document) out["Triggers"] = canonicalNode(document["Triggers"]);

  // A document with neither has no plan tree. Returning `{}` would give every such
  // document the same digest, so two *failed* captures would compare as equal — the
  // failure mode this module exists to make impossible. `null` says "absent".
  return Object.keys(out).length === 0 ? null : out;
}

/** SHA-256 of the canonical structural form, as lowercase hex. */
export function structuralDigest(explainRows: readonly unknown[]): string {
  const canonical = canonicalPlan(explainRows);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** The timing fields the digest deliberately excludes, reported beside it. */
export function planTimings(explainRows: readonly unknown[]): {
  readonly planning_time_ms: number | null;
  readonly execution_time_ms: number | null;
} {
  const document = (explainRows[0] ?? {}) as Record<string, unknown>;
  const planning = document["Planning Time"];
  const execution = document["Execution Time"];
  return {
    planning_time_ms: typeof planning === "number" ? planning : null,
    execution_time_ms: typeof execution === "number" ? execution : null,
  };
}

/** Buffer and WAL totals across every node, reported beside the digest rather than in it. */
export function planCounters(explainRows: readonly unknown[]): {
  readonly shared_hit: number;
  readonly shared_read: number;
  readonly local_hit: number;
  readonly local_read: number;
  readonly temp_read: number;
  readonly temp_written: number;
  readonly wal_records: number;
  readonly wal_bytes: number;
} {
  const totals = {
    shared_hit: 0,
    shared_read: 0,
    local_hit: 0,
    local_read: 0,
    temp_read: 0,
    temp_written: 0,
    wal_records: 0,
    wal_bytes: 0,
  };
  const fields: Record<string, keyof typeof totals> = {
    "Shared Hit Blocks": "shared_hit",
    "Shared Read Blocks": "shared_read",
    "Local Hit Blocks": "local_hit",
    "Local Read Blocks": "local_read",
    "Temp Read Blocks": "temp_read",
    "Temp Written Blocks": "temp_written",
    "WAL Records": "wal_records",
    "WAL Bytes": "wal_bytes",
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const field = fields[key];
      if (field !== undefined && typeof value === "number") totals[field] += value;
      else walk(value);
    }
  };

  walk(explainRows[0]);
  return totals;
}

/**
 * Node types and relations touched, in plan order.
 *
 * A compact human-readable summary. It is not used for comparison — the digest is — but
 * it is what makes a failing assertion legible without opening the raw plan.
 */
export function planOutline(explainRows: readonly unknown[]): readonly string[] {
  const out: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record["Node Type"] === "string") {
      const relation = typeof record["Relation Name"] === "string" ? ` on ${record["Relation Name"]}` : "";
      const index = typeof record["Index Name"] === "string" ? ` using ${record["Index Name"]}` : "";
      out.push(`${"  ".repeat(depth)}${record["Node Type"]}${relation}${index}`);
    }
    // Descend into the child-bearing keys. `Plan` is the root document's key and holds the
    // whole tree: omitting it — which the first version did — made every outline empty,
    // because the walk started at the document rather than at the plan.
    for (const key of ["Plan", "Plans", "InitPlan"]) {
      if (key in record) walk(record[key], key === "Plans" ? depth + 1 : depth);
    }
  };
  walk(explainRows[0], 0);
  return out;
}
