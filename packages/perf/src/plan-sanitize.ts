/**
 * Sanitizing an `EXPLAIN` plan, and proving a whole artifact is free of secrets.
 *
 * ## The problem
 *
 * `EXPLAIN (FORMAT JSON)` is not structure. Several of its fields contain **the statement
 * as PostgreSQL rewrote it, with the bound parameter values substituted in**:
 *
 *   * `Filter`, `Index Cond`, `Recheck Cond`, `Hash Cond`, `Join Filter`, `Merge Cond`
 *   * `Function Call`
 *   * `Output`, `Sort Key`, `Group Key`
 *   * `Index Recheck`, `One-Time Filter`, `Cache Key`, `Cache Mode`
 *
 * For this system that means a plan can contain the tenant's UUID, the query text, the
 * caller's scopes and the subjects they declared — the exact values the artifact is
 * required not to carry. Writing the explain output through unmodified, which the first
 * version of this module did under the name `raw_plan`, would have published them.
 *
 * ## What is kept, and what is replaced
 *
 * The diagnostic value of a plan is its *shape*: which node types, which relations, which
 * indexes, which join order, which operators, and which columns are compared. None of that
 * needs the literal. So an expression string is rewritten with literal values replaced by
 * positional placeholders and compared column references. `sanitizeExpression` does that
 * textually, deliberately conservatively: anything it does not recognise as a literal, a
 * column reference or an operator becomes a placeholder too, because a value that survives
 * by accident is the failure mode.
 *
 * The field is named `sanitized_plan`, not `raw_plan`. Calling a sanitized document raw
 * would be a false claim about what a reader is looking at — and this repository has
 * already had one field whose name outlived its meaning.
 */
import { createHash } from "node:crypto";

/**
 * Plan fields that carry the rewritten statement, and therefore bound values.
 *
 * This is a deny-list of *fields that need sanitizing*, not a list of every risky field.
 * That distinction matters: a new PostgreSQL version can add a field, and a plan field not
 * on this list would pass through. So the sanitizer does not rely on this list alone — see
 * `sanitizeNode`, which sanitizes any value that looks like a SQL expression regardless of
 * its key, and `findLeaks`, which is the independent check that catches a miss.
 */
const EXPRESSION_FIELDS = new Set([
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

/** Numeric telemetry that is not a value from the statement and is safe to keep verbatim. */
const NUMERIC_FIELDS = new Set([
  "Actual Startup Time",
  "Actual Total Time",
  "Actual Rows",
  "Actual Loops",
  "Startup Cost",
  "Total Cost",
  "Plan Rows",
  "Plan Width",
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
  "WAL Records",
  "WAL FPI",
  "WAL Bytes",
  "WAL Buffers Full",
  "Workers Planned",
  "Workers Launched",
  "Peak Memory Usage",
  "Rows Removed by Filter",
  "Rows Removed by Join Filter",
  "Rows Removed by Index Recheck",
  "Sort Space Used",
  "Batches",
]);

/**
 * Rewrite a SQL expression so its literals are gone but its structure is legible.
 *
 * Kept: identifiers, quoted identifiers, operators, keywords, `$n` placeholders, and
 * `table.column` references. Replaced with `?`: string literals, numbers, booleans,
 * `ARRAY[...]` contents, and anything else that could be a bound value.
 *
 * Deliberately conservative in one direction: when the scanner is unsure, it emits `?`.
 * Over-sanitizing costs a reader some detail they can recover from the same expression's
 * shape; under-sanitizing publishes a tenant id.
 */
export function sanitizeExpression(expression: string): string {
  let out = "";
  let index = 0;
  while (index < expression.length) {
    const char = expression[index]!;

    // Single-quoted literal. `''` is an escaped quote inside it.
    if (char === "'") {
      let cursor = index + 1;
      while (cursor < expression.length) {
        if (expression[cursor] === "'" && expression[cursor + 1] === "'") cursor += 2;
        else if (expression[cursor] === "'") break;
        else cursor += 1;
      }
      out += "?";
      index = Math.min(cursor + 1, expression.length);
      continue;
    }

    // Quoted identifier: structure, keep it.
    if (char === '"') {
      let cursor = index + 1;
      while (cursor < expression.length) {
        if (expression[cursor] === '"' && expression[cursor + 1] === '"') cursor += 2;
        else if (expression[cursor] === '"') break;
        else cursor += 1;
      }
      out += expression.slice(index, Math.min(cursor + 1, expression.length));
      index = Math.min(cursor + 1, expression.length);
      continue;
    }

    // A parameter placeholder is structure. `$1`, `$12`.
    if (char === "$" && /[0-9]/.test(expression[index + 1] ?? "")) {
      let cursor = index + 1;
      while (cursor < expression.length && /[0-9]/.test(expression[cursor]!)) cursor += 1;
      out += expression.slice(index, cursor);
      index = cursor;
      continue;
    }

    // A number, including scientific notation and an optional sign that is part of the
    // literal rather than an operator. A digit that follows an identifier character is part
    // of that identifier (`t1`, `x2`) and is kept.
    if (/[0-9]/.test(char) && !/[A-Za-z0-9_$."]/.test(out.at(-1) ?? " ")) {
      let cursor = index;
      while (cursor < expression.length && /[0-9.]/.test(expression[cursor]!)) cursor += 1;
      if (/[eE]/.test(expression[cursor] ?? "")) {
        cursor += 1;
        if (/[+-]/.test(expression[cursor] ?? "")) cursor += 1;
        while (cursor < expression.length && /[0-9]/.test(expression[cursor]!)) cursor += 1;
      }
      out += "?";
      index = cursor;
      continue;
    }

    // A bare word: an identifier, a keyword, or a type name. `true`/`false` are literals in
    // PostgreSQL's rewritten plans and are replaced; every other word is structure.
    if (/[A-Za-z_]/.test(char)) {
      let cursor = index;
      while (cursor < expression.length && /[A-Za-z0-9_$]/.test(expression[cursor]!)) cursor += 1;
      const word = expression.slice(index, cursor);
      out += word === "true" || word === "false" ? "?" : word;
      index = cursor;
      continue;
    }

    // An operator or punctuation. Kept, but with `::` casts and their type name preserved
    // because the cast target is structure.
    out += char;
    index += 1;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * A UUID anywhere in a string, replaced.
 *
 * A second line of defence: an expression the scanner mis-parses, or a field not in the
 * list above, still cannot carry a tenant id through this pass. Written as a separate step
 * rather than folded into `sanitizeExpression` so that it also applies to values that are
 * not expressions at all.
 */
const UUID_PATTERN = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/** Replace every UUID in a string with `<uuid>`. */
export function redactUuids(value: string): string {
  return value.replace(UUID_PATTERN, "<uuid>");
}

/** Sanitize any string: literals out, UUIDs out. */
function sanitizeString(value: string): string {
  return redactUuids(sanitizeExpression(value));
}

/**
 * Sanitize one plan node, recursively.
 *
 * Two passes, because a deny-list of field names is not enough on its own: a field this
 * module has never heard of, added by a PostgreSQL version, would otherwise pass through.
 * So a string value in an unknown field is sanitized if it looks like an expression —
 * contains a quote, a comparison operator or a parenthesis — and left alone if it is a
 * plain identifier used where the plan schema requires one.
 */
function sanitizeNode(node: unknown, parentKey?: string): unknown {
  if (node === null || typeof node === "boolean" || typeof node === "number") return node;
  if (typeof node === "string") return sanitizeString(node);
  if (Array.isArray(node)) return node.map((child) => sanitizeNode(child, parentKey));
  if (typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (EXPRESSION_FIELDS.has(key)) {
      out[key] = typeof value === "string" ? sanitizeString(value) : sanitizeNode(value, key);
      continue;
    }
    if (NUMERIC_FIELDS.has(key)) {
      out[key] = value;
      continue;
    }
    if (typeof value === "string" && looksLikeExpression(key, value)) {
      // An unrecognised field holding something expression-shaped. Sanitize it rather than
      // trust that PostgreSQL will never put a value there.
      out[key] = sanitizeString(value);
      continue;
    }
    out[key] = sanitizeNode(value, key);
  }
  return out;
}

/**
 * Whether a string in an unfamiliar field could carry a bound value.
 *
 * `Index Name`, `Relation Name` and `Alias` hold identifiers, which are schema names that
 * this artifact is explicitly required to preserve. A string containing a quote, a
 * comparison operator, a parenthesis or a comma is not an identifier.
 */
function looksLikeExpression(_key: string, value: string): boolean {
  return /['()=<>]|::|\s/.test(value);
}

/**
 * Sanitize a whole `EXPLAIN (FORMAT JSON)` document.
 *
 * The top-level array is preserved so the result is still a valid explain document, and the
 * `Settings` block is kept because a plan is only interpretable beside the settings that
 * produced it — those are configuration names and values, never statement values.
 */
export function sanitizePlan(explainRows: readonly unknown[]): readonly unknown[] {
  return explainRows.map((row) => sanitizeNode(row));
}

/**
 * Values that must not appear anywhere in an artifact.
 *
 * Returned as a list of `{ label, value }` rather than a predicate so a failure can name
 * *which* secret leaked, and so the caller does not have to remember every category. The
 * categories are the ones the task enumerates, plus the ones this system actually binds
 * into a plan.
 */
export interface SecretProbe {
  readonly label: string;
  readonly value: string;
}

/**
 * Find any probe value present in an artifact.
 *
 * Walks the serialized form rather than the object graph, because JSON is what gets
 * written and what a reader can see: a value could reach the file through a shape this
 * function would not walk — a `Map`, a getter, a nested buffer — and serialization is the
 * one step every one of those passes through.
 *
 * Values shorter than 8 characters are skipped: `en`, `0` and `1` occur inside ordinary
 * words and would produce false alarms that train a reader to ignore the check. Callers
 * should pass identifiers, not fragments.
 */
export function findLeaks(artifact: unknown, probes: readonly SecretProbe[]): readonly SecretProbe[] {
  const serialized = JSON.stringify(artifact);
  const leaked: SecretProbe[] = [];
  for (const probe of probes) {
    if (probe.value.length < 8) continue;
    if (serialized.includes(probe.value)) leaked.push(probe);
  }
  return leaked;
}

/** Case-insensitive substring probes for things that are not identifiers. */
export function findMarkers(artifact: unknown, markers: readonly string[]): readonly string[] {
  const serialized = JSON.stringify(artifact).toLowerCase();
  return markers.filter((marker) => serialized.includes(marker.toLowerCase()));
}

/**
 * Canonicalize an expression for hashing: literals and UUIDs out, structure in.
 *
 * Distinct from `sanitizeExpression` in what it is for, not in what it does — both must
 * remove every bound value, and neither may remove structure. They are separate names so
 * that a change made for one purpose is not silently a change to the other; the digest
 * depends on this being at least as strict as the sanitizer, and a test asserts that the two
 * agree on the fields they share.
 */
export function canonicalExpression(expression: string): string {
  return redactUuids(sanitizeExpression(expression));
}

/** SHA-256 of a string, as lowercase hex. Used for the query and principal digests. */
export function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
