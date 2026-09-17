/**
 * Canonical serialization.
 *
 * Replay equality and idempotency both depend on two processes agreeing that two
 * values are the same value. `JSON.stringify` does not guarantee that: key order
 * follows insertion order, so the same logical record can serialize two ways.
 * Everything that hashes or compares structured data goes through here.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Sorted-key, no-whitespace JSON. Stable across processes and package versions. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalOrder(value));
}

/**
 * Recursively reorder object keys and normalise values that JSON cannot carry.
 * `undefined` inside an array becomes null, matching JSON.stringify's array
 * behaviour, rather than shifting subsequent elements.
 */
function canonicalOrder(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonicalize: non-finite number is not JSON-representable: ${value}`);
    }
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => canonicalOrder(item));
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item === undefined) continue;
      out[key] = canonicalOrder(item);
    }
    return out;
  }
  throw new TypeError(`canonicalize: unsupported type ${typeof value}`);
}

/** Deep equality over canonical form. Used by replay and conflict detection. */
export function canonicalEquals(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}
