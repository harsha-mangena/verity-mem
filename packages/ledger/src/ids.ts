/**
 * Identifiers and clocks.
 *
 * Both are injected rather than imported, because replay equality and
 * deterministic tests require the ability to run the whole pipeline under a
 * fixed clock and a seeded identifier generator. A `Date.now()` buried in a
 * helper is a nondeterminism bug that only shows up as a replay mismatch weeks
 * later.
 */
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Fixed clock that only advances when told to. Tests use this. */
export function fixedClock(start: Date | string = "2026-09-17T00:00:00.000Z"): Clock & {
  advance(ms: number): void;
  set(at: Date | string): void;
} {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
    set(at: Date | string) {
      current = new Date(at);
    },
  };
}

export interface IdGenerator {
  next(prefix: IdPrefix): string;
}

export type IdPrefix =
  | "evt"
  | "spn"
  | "cnd"
  | "clm"
  | "dec"
  | "qry"
  | "grt"
  | "ret"
  | "evr";

/**
 * UUIDv7-style sortable identifier with a type prefix.
 *
 * The time component makes ids index-friendly and log-readable, and the prefix
 * makes a stray id obvious in a log line without a join. `randomUUID` supplies
 * the entropy, so no Math.random path exists to seed.
 */
export function generateId(prefix: IdPrefix, now: Date = new Date()): string {
  const ms = now.getTime();
  const hex = ms.toString(16).padStart(12, "0");
  const entropy = randomUUID().replace(/-/g, "").slice(0, 20);
  return `${prefix}_${hex}${entropy}`;
}

export const systemIds: IdGenerator = {
  next: (prefix) => generateId(prefix),
};

/**
 * Deterministic ids for replay and tests: a counter mixed with a seed. Same seed
 * and same call order gives the same ids, which is what makes a byte-identical
 * projection rebuild possible to assert.
 *
 * The body is a well-formed UUID so that seeded runs exercise exactly the same
 * code path as production, including UUID coercion at the database boundary.
 */
export function seededIds(seed = "veritymem"): IdGenerator {
  const seedHash = createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 20);
  let counter = 0;
  return {
    next(prefix) {
      counter += 1;
      const n = counter.toString(16).padStart(12, "0");
      return `${prefix}_${seedHash}${n}`;
    },
  };
}

export function workerId(): string {
  return `${hostname()}:${process.pid}`;
}
