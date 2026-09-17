/**
 * The synthetic corpus.
 *
 * This module is a *generator*, not a loader: it turns an integer claim index into
 * the exact bytes of one claim, the event that carries it, the evidence span inside
 * that event, and the embedding input text. Everything is a pure function of
 * `(seed, index)`, and that is the property the whole benchmark rests on:
 *
 *   * the loader can stop and resume at any index without the remaining rows
 *     changing shape, so a resumed run produces the same dataset as an
 *     uninterrupted one;
 *   * a second run against the same tenant slug is idempotent, because the primary
 *     keys are derived from the index rather than from a random source;
 *   * the report can name the corpus by seed and size, and someone else can
 *     regenerate byte-identical data on their own machine.
 *
 * ## What this corpus is not
 *
 * It is **not** extracted, gated or promoted. A million gate decisions through the
 * application write path would take hours and would measure the write path, which
 * is not what the v0.1 latency target is about. The loader inserts rows directly and
 * the benchmark therefore measures the **read path only**. See `load.ts` for the
 * long version of that statement. The claim rows are shaped exactly like
 * gate-promoted rows (status `accepted`, an authority class, a real evidence span
 * whose digest verifies) so that the read path does the same work it would do on
 * real data — but no `decisions` row exists and this corpus proves nothing about the
 * gate.
 *
 * ## Distribution, stated because it drives the numbers
 *
 *   * 84% of claims are open intervals (`valid_to IS NULL`, status `accepted`) —
 *     the "currently believed" set a `current` query sees.
 *   * 16% are closed intervals (status `superseded`) inside the same 180-day
 *     recorded window, which is what makes `as_of` and `during` queries return a
 *     different set rather than the same rows under a different predicate.
 *   * interval widths are mixed (1/3/7/14/30/90 days). A `during` query over a
 *     30-day window therefore overlaps a large fraction of the table, and over a
 *     1-day window a small one: the benchmark reports which windows it issued
 *     instead of quoting a single flattering one.
 *   * 2% of claims have a `contradicts` relation, so hydration's conflict branch
 *     runs on a realistic fraction of returned packets.
 */
import { createHash } from "node:crypto";

/** Purpose the whole benchmark corpus is written and read under. */
export const BENCH_PURPOSE = "release_planning";

/** Project dimension for the benchmark tenant's scopes. */
export const BENCH_PROJECT = "payments-api";

/** Principal the benchmark queries as. Project-scoped: it reaches every user scope. */
export const BENCH_PRINCIPAL = "agent:perf-bench-runner";

/** Synthetic users whose scopes the corpus is partitioned across. */
export const BENCH_USER_COUNT = 40;

/** Length of the recorded-time window, in days, ending at the corpus anchor. */
export const RECORDED_WINDOW_DAYS = 180;

const DAY_MS = 86_400_000;

const STATUSES = ["accepted", "superseded"] as const;
export type CorpusStatus = (typeof STATUSES)[number];

const AUTHORITIES = ["verified_record", "observation", "user_self_report"] as const;
export type CorpusAuthority = (typeof AUTHORITIES)[number];

const ORIGINS = ["agent", "tool", "user", "document"] as const;
export type CorpusOrigin = (typeof ORIGINS)[number];

const KINDS = ["observation", "event", "decision", "procedure", "preference"] as const;
export type CorpusKind = (typeof KINDS)[number];

/** Interval widths, in days, drawn for closed claims. */
const INTERVAL_WIDTH_DAYS = [1, 3, 7, 14, 30, 90] as const;

/**
 * Observable, mechanically checkable facts.
 *
 * Two properties matter and both are deliberate. The statement *names the subject
 * and the object as literal tokens in the text*, because the entity channel joins
 * `entity_aliases` on `canonical = c.subject` — a corpus whose prose never mentions
 * its own subject would make that channel return nothing and the benchmark would
 * silently measure three channels instead of four. And the predicate is a word the
 * FTS index actually carries, because `search_tsv` is built from the statement, not
 * from the source event.
 */
interface PredicateTemplate {
  readonly predicate: string;
  readonly kind: CorpusKind;
  readonly authority: CorpusAuthority;
  readonly origin: CorpusOrigin;
  readonly render: (subject: string, object: string) => string;
}

const PREDICATES: readonly PredicateTemplate[] = [
  {
    predicate: "status_of",
    kind: "observation",
    authority: "verified_record",
    origin: "tool",
    render: (s, o) => `CI result: build ${o} status_of ${s} is passing`,
  },
  {
    predicate: "owner_of",
    kind: "decision",
    authority: "observation",
    origin: "user",
    render: (s, o) => `Decision record: ${o} owner_of ${s} is confirmed`,
  },
  {
    predicate: "deployed_at",
    kind: "event",
    authority: "observation",
    origin: "tool",
    render: (s, o) => `Deploy log: ${s} deployed_at ${o} completed`,
  },
  {
    predicate: "depends_on",
    kind: "observation",
    authority: "verified_record",
    origin: "document",
    render: (s, o) => `Service map: ${s} depends_on ${o} recorded`,
  },
  {
    predicate: "blocks",
    kind: "observation",
    authority: "observation",
    origin: "agent",
    render: (s, o) => `Tracker: ${o} blocks ${s} escalation`,
  },
  {
    predicate: "prefers",
    kind: "preference",
    authority: "user_self_report",
    origin: "user",
    render: (s, o) => `Standup note: ${s} prefers ${o} workflow`,
  },
  {
    predicate: "assigned_to",
    kind: "decision",
    authority: "observation",
    origin: "user",
    render: (s, o) => `Assignment: ${o} assigned_to ${s} approved`,
  },
  {
    predicate: "expires_on",
    kind: "procedure",
    authority: "verified_record",
    origin: "document",
    render: (s, o) => `Runbook: ${s} expires_on ${o} renewal`,
  },
];

const SERVICE_NAMES = [
  "checkout", "ledger", "search", "billing", "identity", "notify", "gateway",
  "ingest", "gate", "planner", "vector", "retention", "outbox", "billing-sync",
  "webhooks", "analytics", "router", "scheduler", "audit", "vault",
] as const;

const REPOS = [
  "verity-core", "verity-api", "verity-web", "verity-infra", "verity-worker",
  "verity-sdk", "verity-mobile", "verity-cli",
] as const;

const COMMITS = [
  "a41f9c2", "77b0e13", "0d9aa54", "e5c7f60", "3fa81bd", "c92e704", "18b6d3f",
  "5c0e877", "b7a2d41", "24f9e08", "9ed3c66", "6b15a0f", "d80c472", "f3a5b19",
] as const;

const RUNBOOKS = [
  "incident-rotation", "key-rotation", "schema-migration", "capacity-review",
  "release-checklist", "oncall-handover",
] as const;

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as const;

/**
 * 32-bit PRNG state derived from a string.
 *
 * `hashSeed` rather than a numeric seed because the caller names a corpus as
 * `(label, index)`, and folding the label in here is what keeps two corpus variants
 * from correlating on their first draws.
 */
function hashSeed(...parts: readonly (string | number)[]): number {
  const digest = createHash("sha256").update(parts.join("\u0000"), "utf8").digest();
  return digest.readUInt32BE(0) || 0x9e3779b9;
}

/**
 * SplitMix32.
 *
 * A full-width integer generator is used rather than `Math.random` for the obvious
 * reason (reproducibility), and rather than an LCG because this one has no
 * low-bit correlation, which matters when `next() % small` picks an enum member.
 */
function nextInt(state: number): { readonly state: number; readonly value: number } {
  let next = (state + 0x9e3779b9) | 0;
  let z = next;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  z = (z ^ (z >>> 15)) >>> 0;
  return { state: next, value: z };
}

function pick<T>(items: readonly T[], value: number): T {
  const item = items[value % items.length];
  if (item === undefined) throw new Error("pick() called with an empty list");
  return item;
}

function unit(value: number): number {
  return value / 0x1_0000_0000;
}

/** Uppercase hex, no dashes — the form `toPublicId` produces from a UUID. */
function hexOf(digest: Buffer): string {
  return digest.toString("hex");
}

/**
 * A deterministic UUID for a corpus row.
 *
 * The loader's primary keys are `(tenant, label, index)` rather than random, so a
 * second run against the same tenant conflicts on the same keys instead of
 * duplicating the corpus. UUID version and variant bits are set so the values are
 * valid UUIDs rather than arbitrary 128-bit strings.
 */
export function corpusUuid(tenantId: string, label: string, index: number): string {
  const digest = createHash("sha256").update(`${tenantId}:${label}:${index}`, "utf8").digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** One claim, with the event and span that carry its evidence. */
export interface CorpusClaim {
  readonly index: number;
  /** Raw UUIDs, exactly as Postgres stores them. */
  readonly claimId: string;
  readonly eventId: string;
  readonly spanId: string;
  readonly scopeIndex: number;
  readonly subject: string;
  readonly predicate: string;
  readonly objectText: string;
  /** The object column. String values, because the entity channel reads them. */
  readonly objectJson: string;
  readonly kind: CorpusKind;
  readonly authority: CorpusAuthority;
  readonly status: CorpusStatus;
  readonly origin: CorpusOrigin;
  readonly validFrom: Date;
  readonly validTo: Date | null;
  readonly recordedAt: Date;
  readonly actorId: string;
  readonly streamId: string;
  readonly sequence: number;
  /** Full event payload. The span is a slice of it, offsets included. */
  readonly payload: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly spanDigestHex: string;
  readonly contentHashHex: string;
  /** Exactly the text the dense projection embeds: `projectionText()` of this claim. */
  readonly embeddingText: string;
  /** Index of the later claim this one contradicts, or null. */
  readonly contradictsIndex: number | null;
}

export interface CorpusOptions {
  readonly seed: string;
  /**
   * Upper bound of `recorded_at`. Passed in rather than read from the clock inside
   * this function so that one generation pass produces one coherent time axis even
   * if a batch is generated after midnight.
   */
  readonly anchor: Date;
}

/**
 * The scope a claim index belongs to.
 *
 * Round-robin rather than random: with a random assignment, a small prefix of the
 * corpus (a smoke run) could leave a user scope empty, and a `user`-scoped query
 * would then measure an empty result. Round-robin guarantees every user scope is
 * populated from index `BENCH_USER_COUNT` onwards.
 */
export function scopeIndexFor(claimIndex: number): number {
  return claimIndex % BENCH_USER_COUNT;
}

/** Which claims carry a `contradicts` relation. Two percent, by index, not at random. */
export function contradictionPartner(claimIndex: number): number | null {
  if (claimIndex % 50 !== 7) return null;
  return claimIndex - 1;
}

/**
 * Generate one claim.
 *
 * Every draw is seeded from `(seed, index)`, so generation is independent of batch
 * boundaries and of how many claims were requested before this one. An earlier
 * version seeded the whole batch from a running counter, which made the corpus
 * depend on where the previous run stopped — a resumed load produced different rows
 * than an uninterrupted one, and the benchmark would then have been measuring a
 * dataset it could not name.
 */
export function generateClaim(index: number, options: CorpusOptions): CorpusClaim {
  let state = hashSeed(options.seed, "claim", index);
  const draw = (): number => {
    const step = nextInt(state);
    state = step.state;
    return step.value;
  };

  const scopeIndex = scopeIndexFor(index);
  const template = pick(PREDICATES, draw());
  const service = pick(SERVICE_NAMES, draw());
  const repo = pick(REPOS, draw());
  const commit = pick(COMMITS, draw());
  const runbook = pick(RUNBOOKS, draw());
  const weekday = pick(WEEKDAYS, draw());

  const isUserScoped = scopeIndex % 3 !== 1;
  const subject = isUserScoped ? `user:eng-${String(scopeIndex).padStart(2, "0")}` : `service:${service}`;

  // The object template is chosen with the predicate, so the sentence reads like
  // something the predicate could actually be extracted from.
  const objectVariant = draw() % 4;
  const object =
    objectVariant === 0
      ? `${repo}@${commit}`
      : objectVariant === 1
        ? `weekday:${weekday}`
        : objectVariant === 2
          ? `service:${service}`
          : `runbook:${runbook}`;

  const quote = template.render(subject, object);

  // The payload contains the quote verbatim at a non-zero offset, so span digest
  // verification is exercised against a real slice rather than the whole payload.
  const payload = `${template.origin} event #${index}: "${quote}" (recorded by veritymem perf corpus)`;
  const startOffset = payload.indexOf(quote);
  const endOffset = startOffset + Buffer.byteLength(quote, "utf8");

  const status: CorpusStatus = index % 25 < 21 ? "accepted" : "superseded";

  // Recorded time spread across the whole window, so an `as_of` query at any point
  // in it matches a materially different row set.
  const recordedOffsetMs = Math.floor(unit(draw()) * RECORDED_WINDOW_DAYS * DAY_MS);
  const recordedAt = new Date(options.anchor.getTime() - recordedOffsetMs);

  // Valid time is anchored on the recorded time and runs forward. For an open
  // claim the interval is [valid_from, ∞); for a closed one it is a real interval
  // inside the past, which is what a `during` query needs to find.
  const validFrom = recordedAt;
  const widthDays =
    status === "superseded" ? pick(INTERVAL_WIDTH_DAYS, draw()) : 0;
  const validTo =
    status === "superseded" && widthDays > 0
      ? new Date(Math.min(validFrom.getTime() + widthDays * DAY_MS, options.anchor.getTime()))
      : null;

  const payloadBytes = Buffer.from(payload, "utf8");
  const spanBytes = payloadBytes.subarray(startOffset, endOffset);
  const digest = createHash("sha256").update(spanBytes).digest();

  return {
    index,
    claimId: corpusUuid(options.seed, "clm", index),
    eventId: corpusUuid(options.seed, "evt", index),
    spanId: corpusUuid(options.seed, "spn", index),
    scopeIndex,
    subject,
    predicate: template.predicate,
    objectText: object,
    // A JSON string literal: `jsonb_to_tsvector` indexes strings, and the entity
    // channel lowercases `object::text`, which for a JSON string is the value.
    objectJson: JSON.stringify(object),
    kind: template.kind,
    authority: template.authority,
    status,
    origin: template.origin,
    validFrom,
    validTo,
    recordedAt,
    actorId: `agent:perf-writer-${scopeIndex % 8}`,
    streamId: `perf-${scopeIndex}`,
    sequence: index + 1,
    payload,
    startOffset,
    endOffset,
    spanDigestHex: hexOf(digest),
    contentHashHex: hexOf(createHash("sha256").update(payloadBytes).digest()),
    embeddingText: `${subject} ${template.predicate} ${object}`,
    contradictsIndex: contradictionPartner(index),
  };
}

/** The claim id of `index`, without generating the whole row. Used for relation edges. */
export function claimIdAt(index: number, seed: string): string {
  return corpusUuid(seed, "clm", index);
}

/**
 * A distinct, representative query string for a position in the workload.
 *
 * Distinct because a repeated identical query is answered partly from the plan cache
 * and the buffer pool in a way a first-time query is not, and a workload made of one
 * query repeated ten thousand times would report a number no user ever experiences.
 * The vocabulary is drawn from the corpus so the queries actually match rows.
 */
export function queryTextFor(
  position: number,
  options: { readonly seed: string; readonly origin: Date },
): string {
  let state = hashSeed(options.seed, "query", position);
  const draw = (): number => {
    const step = nextInt(state);
    state = step.state;
    return step.value;
  };

  const service = pick(SERVICE_NAMES, draw());
  const repo = pick(REPOS, draw());
  const runbook = pick(RUNBOOKS, draw());
  const user = `eng-${String(draw() % BENCH_USER_COUNT).padStart(2, "0")}`;
  const shuffle = (users: number): string => `${Math.floor(unit(users) * 900) + 100}`;

  switch (position % 4) {
    case 0:
      return `what is the build status_of service:${service} now ${shuffle(draw())}`;
    case 1:
      return `owner_of ${repo} release ${shuffle(draw())} ${runbook}`;
    case 2:
      return `user:${user} prefers which workflow for ${repo} ${shuffle(draw())}`;
    default:
      return `does service:${service} depends_on ${repo} still hold ${shuffle(draw())}`;
  }
}

export { DAY_MS, RECORDED_WINDOW_DAYS as WINDOW_DAYS };
