/**
 * Deterministic hashing for tool observations and store writes.
 *
 * `@veritymem/ledger` already exports `canonicalize`, and this file is a
 * deliberate second implementation of the same rule rather than an import of it.
 * The reason is a dependency boundary, not a preference: `@veritymem/ledger`
 * re-exports its database module, so importing it would make the LangGraph adapter
 * — which needs nothing but `fetch` and `crypto` — uninstallable without
 * PostgreSQL. The rule ("sorted keys, no whitespace, stable across processes") is
 * the ledger's; the code is duplicated so the boundary holds. If the two ever
 * disagree, an observation hash stops matching the ledger's content hash and the
 * hashes in this package become noise, so `langgraph.test.ts` cross-checks them
 * against the ledger whenever that package is resolvable.
 */
import { createHash } from "node:crypto";

/**
 * Sorted-key, no-whitespace JSON.
 *
 * Exists because `JSON.stringify` follows insertion order: two processes that
 * build the same observation with different key order would otherwise record two
 * different hashes for one fact, and idempotency would silently stop working.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalOrder(value));
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `values`, in order. */
export function sha256Hex(...values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values) hash.update(value, "utf8");
  return hash.digest("hex");
}

/** SHA-256 over the canonical JSON form of a value. */
export function hashValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function canonicalOrder(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonicalJson: non-finite number is not JSON-representable: ${value}`);
    }
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => canonicalOrder(item));
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      // `undefined` members are dropped rather than serialized as null, matching
      // the ledger: an absent field and a null field must hash the same way only
      // if the ledger says so, and it does not.
      if (item === undefined) continue;
      out[key] = canonicalOrder(item);
    }
    return out;
  }
  throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
}
