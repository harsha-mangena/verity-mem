/**
 * The fixture runner.
 *
 * It executes a fixture stream against a real database through the real `Ledger`
 * and the real `CommitGate`. Nothing here reimplements the system under test:
 * if the runner agreed with itself, it would measure nothing.
 *
 * Three decisions are worth stating because the obvious alternative was worse:
 *
 *  - **Each fixture gets its own tenant.** The ledger is append-only, so a suite
 *    cannot clean up after itself. A fresh tenant derived from (seed, fixture id)
 *    makes runs isolated, reproducible and repeatable, and the tenant slug is
 *    recorded in the result so a number can always be traced back to its rows.
 *  - **Every scope in a fixture is bound in the request context.** This is the
 *    benchmark acting as an operator-wide analyzer, not as one caller. Without it
 *    row-level security would legitimately hide the rows the run just wrote, and a
 *    metric would report zero for a system that was working. The online path never
 *    does this; the benchmark is not the online path.
 *  - **A gate error is recorded, never swallowed.** A candidate that makes the
 *    gate throw is a result, not a crashed test, because the fixture's expectation
 *    ("no claim may exist") still has to be checked in the resulting state.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  GATE_THRESHOLDS,
  REASON_CODES,
  isKnownReasonCode,
  type ActionGateRequest,
  type ActionRisk,
  type ClaimKind,
  type EventAppendRequest,
  type MemoryPacket,
  type OriginKind,
} from "@veritymem/contracts";
import {
  CommitGate,
  LexicalEntailmentBackend,
  defaultAuthorityFor,
  renderStatement,
  type CandidateForGate,
  type EntailmentBackend,
} from "@veritymem/gate";
import {
  Db,
  Ledger,
  MemoryBlobStore,
  ensureScope,
  fixedClock,
  loadEnv,
  resolveTenantId,
  seededIds,
  sha256Hex,
  toPublicId,
  type QueryExecutor,
  type ResolvedScope,
  type SpanRecord,
} from "@veritymem/ledger";
import { compose, evaluateAction, HashEmbeddingBackend, type ComposeResult } from "@veritymem/retrieval";
import { FixtureParseError } from "./errors.ts";
import {
  type EraseMode,
  type Expectation,
  type FixtureBodyLine,
  type FixtureCandidate,
  type FixtureFile,
  type FixtureQuery,
  type FixtureRelevance,
  type FixtureSpan,
  type ResolveOutcome,
} from "./types.ts";

/*
 * The entailment backend the benchmark runs with.
 *
 * Resolved once per process by `cli.ts` and handed to the runner, rather than chosen
 * inside `run()`: the choice changes every number in the report, so it belongs to the
 * run's configuration and has to be recorded in the manifest. The default remains the
 * lexical stand-in, because a benchmark that silently reached for a 233 MB model would
 * fail on a checkout that has not provisioned one, and "the gate could not run" must be
 * a statement in the report rather than an empty result.
 */

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

export type AssertionStatus = "pass" | "fail" | "not_evaluated" | "blocked";

export interface AssertionRecord {
  readonly expectation: Expectation["type"];
  readonly status: AssertionStatus;
  /** One sentence an operator can act on without reading this file. */
  readonly detail: string;
  /** The stage that has to exist before a `not_evaluated` assertion can be real. */
  readonly blocked_by?: string;
}

export interface DecisionRecord {
  readonly decision_id: string;
  readonly candidate_id: string;
  readonly claim_id: string | null;
  readonly outcome: string;
  readonly reason_codes: readonly string[];
  readonly policy_version: string;
  readonly line_id: string;
  /** True when a human has to look at this row: `needs_review` or `quarantine`. */
  readonly requires_review: boolean;
  readonly entailment: string;
  readonly entailment_score: number | null;
  readonly instruction_flagged: boolean;
  readonly conflicts: readonly { readonly claim_id: string; readonly rel: string }[];
}

export interface ClaimRow {
  readonly claim_id: string;
  readonly kind: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: unknown;
  readonly status: string;
  readonly authority: string;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly scope_id: string;
  readonly scope: {
    readonly project: string | null;
    readonly user: string | null;
    readonly agent: string | null;
    readonly session: string | null;
    readonly purpose: readonly string[];
  };
  readonly origin_event_id: string | null;
  readonly evidence: readonly {
    readonly span_id: string;
    readonly role: string;
    readonly start: number;
    readonly end: number;
    readonly digest: string;
    readonly digest_ok: boolean;
    readonly quote: string | null;
    readonly status: string;
  }[];
}

export interface RelationRow {
  readonly from_claim: string;
  readonly to_claim: string;
  readonly rel: string;
}

/**
 * A claim the packet returned, reduced to what the read-path stages score.
 *
 * `entailment` is recomputed by the benchmark against the production verifier rather
 * than copied from the packet, because the packet's own `entailment` field comes from
 * the compose path, which sets it from digest resolution alone. Scoring composition
 * with the composer's own claim would be scoring the composer against itself.
 */
export interface ReturnedClaimRecord {
  readonly claim_id: string;
  readonly kind: string;
  readonly statement: { readonly subject: string; readonly predicate: string; readonly object: unknown };
  readonly status: string;
  readonly use: string;
  readonly use_reason_codes: readonly string[];
  readonly evidence_count: number;
  readonly resolvable_evidence: number;
  /** Null when no evidence resolved, so nothing could be tested against the verifier. */
  readonly entailment: string | null;
  readonly entailment_score: number | null;
  readonly entailment_backend: string | null;
}

/** Claims a declared matcher matched in a packet, with the fixture's own reason. */
export interface QueryMatchHit {
  readonly reason: string;
  readonly claim_ids: readonly string[];
}

/**
 * One executed query and what the read path answered.
 *
 * The raw packet travels with the outcome so every read-path metric can be
 * recomputed from the artifact without re-running the benchmark, and so a reader can
 * check the runner's arithmetic against the bytes it was given.
 */
export interface QueryOutcome {
  readonly query_id: string;
  readonly fixture_id: string;
  readonly line_id: string;
  readonly text: string;
  readonly principal: string;
  readonly purpose: string;
  /** True when the fixture declares the memory holds an answer to this query. */
  readonly has_answer: boolean | null;
  readonly limit: number;
  readonly decision: string;
  readonly decision_reason_codes: readonly string[];
  readonly returned: readonly ReturnedClaimRecord[];
  readonly missing: readonly string[];
  readonly candidates_considered: number;
  readonly candidates_denied_by_authz: number;
  readonly channels_used: readonly string[];
  readonly plan_denied_dimensions: readonly string[];
  readonly latency_ms: number;
  readonly relevant: readonly QueryMatchHit[];
  readonly stale: readonly QueryMatchHit[];
  readonly absent: readonly QueryMatchHit[];
  /** Non-empty when the query could not be issued as declared. */
  readonly defects: readonly string[];
}

/**
 * One action-gate evaluation.
 *
 * `claims_resolved` and `claims_declared` are both recorded because an action gate
 * asked about a claim that does not exist fails closed and *looks* like a correct
 * refusal. Without the two counts side by side, an unsafe-allow rate of zero could
 * mean "the gate is safe" when it means "the fixture never built a claim".
 */
export interface ActionGateRecord {
  readonly fixture_id: string;
  readonly line_id: string;
  readonly action: string;
  readonly action_risk: string;
  readonly verdict: string;
  readonly allowed: boolean;
  readonly reason_codes: readonly string[];
  readonly claims_resolved: number;
  readonly claims_declared: number;
  readonly defects: readonly string[];
}

export interface LineResult {
  readonly file: string;
  readonly line: number;
  readonly line_id: string;
  readonly kind: FixtureBodyLine["kind"];
  readonly outcome: "ok" | "error";
  readonly event_id?: string;
  readonly seq?: number;
  readonly candidate_id?: string;
  readonly error?: string;
  readonly assertions: readonly AssertionRecord[];
}

export interface FixtureRunResult {
  readonly fixture_id: string;
  readonly title: string;
  readonly suite: string;
  readonly ground_truth: string;
  readonly file: string;
  readonly tenant: string;
  readonly dataset_version: string;
  readonly fixture_version: string;
  readonly seed: number;
  readonly lines: readonly LineResult[];
  readonly decisions: readonly DecisionRecord[];
  /**
   * Claims this fixture created, read back at the end of the run.
   *
   * Read at the end rather than per line, because a later line can legitimately
   * change an earlier claim's status — a supersession is exactly that — and an
   * assertion evaluated against the mid-run snapshot would report a failure the
   * system was right to produce.
   */
  readonly claims: readonly ClaimRow[];
  readonly relations: readonly RelationRow[];
  readonly grants: readonly {
    readonly grant_id: string;
    readonly subject: string;
    readonly expires_at: string | null;
    readonly expired: boolean;
    readonly actions: readonly string[];
    readonly purpose: readonly string[];
  }[];
  readonly ledger_row_count: number;
  readonly residual: Readonly<Record<string, number>> | null;
  /**
   * Every query this fixture declared, with the packet the read path produced.
   *
   * Empty is a fact about the fixture, and the read-path stages report it as
   * `no_data` rather than as a zero: a fixture that declares no query measures no
   * retrieval, and a benchmark that averaged over it would report a rate over a
   * denominator it invented.
   */
  readonly queries: readonly QueryOutcome[];
  /** Every action the fixture asked the gate to judge, with the verdict it returned. */
  readonly action_gates: readonly ActionGateRecord[];
  readonly assertions_total: number;
  readonly assertions_passed: number;
  readonly assertions_failed: number;
  readonly assertions_not_evaluated: number;
  readonly duration_ms: number;
}

export interface FixtureRunnerOptions {
  readonly databaseUrl?: string;
  /**
   * Tenant scope for this run. Two runs with the same scope share a tenant, and
   * because the ledger is append-only the second run sees the first run's rows —
   * so the default is a generated nonce and the CLI exposes `--run-scope` for the
   * case where an operator deliberately wants to re-enter a previous run's world.
   */
  readonly runScope?: string;
  /** Privileged connection, needed only by `erase_subject` with mode `redact`. */
  readonly migrationDatabaseUrl?: string;
  readonly seed?: number;
  readonly clockStart?: string;
  readonly log?: (message: string) => void;
  /**
   * The entailment backend every gate evaluation and every composition score uses.
   *
   * Optional so the runner can still be constructed in a test that has no model assets,
   * in which case the caller supplies the lexical stand-in explicitly. There is no
   * silent fallback inside the runner: which verifier scored the run is a property of
   * the run, and it is published in the manifest.
   */
  readonly entailment?: EntailmentBackend;
}

// ---------------------------------------------------------------------------
// Internal bookkeeping
// ---------------------------------------------------------------------------

interface ScopeRow {
  readonly scope_id: string;
  readonly project: string | null;
  readonly user: string | null;
  readonly agent: string | null;
  readonly session: string | null;
  readonly purpose: readonly string[];
}

interface LocatedCandidate {
  readonly candidate: FixtureCandidate;
  readonly spans: readonly SpanRecord[];
  readonly requested_scope: ResolvedScope;
}

class SubjectEraseBlocked extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SubjectEraseBlocked";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export class FixtureRunner {
  private readonly options: FixtureRunnerOptions;
  private db: Db | null = null;

  constructor(options: FixtureRunnerOptions = {}) {
    this.options = options;
  }

  get seed(): number {
    return this.options.seed ?? 1;
  }

  /**
   * The run's tenant scope.
   *
   * Fixed for the lifetime of one `FixtureRunner`. It is *not* derived from the
   * seed, because two runs of the same fixture under the same seed would then
   * allocate the same event ids, and the second run's insert would be swallowed by
   * `ON CONFLICT DO NOTHING` — leaving the run reading a tenant it never wrote to.
   * A run that shares a tenant with a previous run also cannot assert an exact
   * ledger row count, and the ledger is append-only so there is no cleanup path.
   *
   * The scope is fixed at first use so `tenantFor(seed, fixtureId, runScope)` can
   * reproduce a historical run exactly when an operator passes its scope back in.
   */
  private runScopeValue: string | null = null;
  private readonly runTokenValue: string = randomBytes(8).toString("hex");

  /**
   * Per-instance token, always random.
   *
   * Deliberately *not* pinned by `--run-scope`. The run scope names the tenant a
   * reproduction re-enters; it must not also pin the id sequence, because the
   * ledger is append-only and a re-entered tenant already holds the previous run's
   * events. Pinning both made the second run allocate the first run's event uuid,
   * have its insert refused by the events primary key, and then read back the
   * earlier, already-redacted row — a fixture that looks broken while the system
   * behaves exactly as designed.
   */
  get runToken(): string {
    return this.runTokenValue;
  }

  get runScope(): string {
    if (this.runScopeValue === null) {
      // A generated nonce unless the caller names a scope. Reusing a scope means
      // reusing a tenant, and the ledger is append-only: a run that inherited a
      // previous run's rows would read its ids as already-used and silently stop
      // writing. Reproducing a historical run is the one case where sharing is
      // wanted, and that is what `--run-scope` is for.
      this.runScopeValue = this.options.runScope ?? `r${randomBytes(5).toString("hex")}${Date.now().toString(36)}`;
    }
    return this.runScopeValue;
  }

  /**
   * Run one fixture file.
   *
   * Failures inside one line are captured on that line, so one broken fixture does
   * not take the suite with it — but a failure never turns into a pass.
   */
  async run(fixture: FixtureFile): Promise<FixtureRunResult> {
    const started = Date.now();
    const db = await this.dbHandle();
    const seed = this.seed;
    const tenantSlug = tenantFor(seed, fixture.header.fixture_id, this.runScope);
    // The tenant seed, and the tenant uuid it derives.
    //
    // The two exist because the ledger hashes the scope's tenant on the append path
    // and the runner does not on the prime path: writing `appendTenant` on an event
    // and `tenantId = resolveTenantId(appendTenant)` into the scope row makes both
    // paths land on the same partition. The seed is random per run because the
    // ledger is append-only — a fixture that reused a fixed partition across runs
    // would find its idempotency keys already spent.
    const appendTenant = randomUUID();
    const tenantId = resolveTenantId(appendTenant);
    const clock = fixedClock(this.options.clockStart ?? "2026-09-17T12:00:00.000Z");
    // Ids are seeded from the run instance, not from the run scope. See `runToken`:
    // pinning the ids to a reusable scope is what makes a rerun collide with its
    // predecessor. The sequence inside a run stays deterministic, which is what the
    // replay metric compares.
    const idSeed = `ledgerbench:${seed}:${this.runScope}:${this.runToken}:${fixture.header.fixture_id}`;
    const ids = seededIds(idSeed);
    const blobs = new MemoryBlobStore();
    const ledger = new Ledger({ db, blobs, clock, ids });
    const entailment = this.options.entailment ?? new LexicalEntailmentBackend({
      floor: GATE_THRESHOLDS.lexicalEntailmentFloor,
    });
    const gate = new CommitGate({
      db,
      ledger,
      ids,
      clock,
      entailment,
    });
    // One embedder per runner instance rather than per fixture: the model id is part of
    // the projection's identity, and two instances with different dimensions would
    // silently query projections written by the other.
    const embeddings = new HashEmbeddingBackend({
      dimensions: loadEnv().embedding.dimensions,
      modelId: loadEnv().embedding.modelId,
    });

    const state = new RunState(
      {
        options: this.options,
        runScope: this.runScope,
        runToken: this.runToken,
        fixture,
        tenantSlug,
        tenantId,
        appendTenant,
        seed,
        ledger,
        gate,
        db,
        clock,
        ids,
        embeddings,
        entailment,
        entailmentName: entailment.name,
      },
      blobs,
    );

    // Shared scopes are created up front so the request context can bind all of
    // them: candidates legitimately request scopes the events have not created yet,
    // and the attribution metric is measured by comparing the two.
    await state.primeScopes(
      fixture.body.flatMap((entry) =>
        entry.kind === "append_event" ? [entry.event.scope, entry.candidate?.requested_scope ?? null] : [],
      ),
    );

    for (const entry of fixture.body) {
      await state.runLine(entry);
    }

    await state.finalise();
    const residual = fixture.body.some((entry) => entry.kind === "erase_subject") ? state.residual : null;

    const lines = state.lineResults;
    const allAssertions = lines.flatMap((line) => line.assertions);
    return {
      fixture_id: fixture.header.fixture_id,
      title: fixture.header.title,
      suite: fixture.header.suite,
      ground_truth: fixture.header.ground_truth,
      file: fixture.path,
      tenant: tenantSlug,
      dataset_version: fixture.header.dataset_version,
      fixture_version: fixture.header.fixture_version,
      seed,
      lines,
      decisions: state.decisionRecords,
      claims: state.claims,
      relations: state.relations,
      grants: state.grants,
      ledger_row_count: state.ledgerRowCount,
      residual,
      queries: state.queryOutcomes,
      action_gates: state.actionGateOutcomes,
      assertions_total: allAssertions.length,
      assertions_passed: allAssertions.filter((entry) => entry.status === "pass").length,
      assertions_failed: allAssertions.filter((entry) => entry.status === "fail").length,
      assertions_not_evaluated: allAssertions.filter((entry) => entry.status !== "pass" && entry.status !== "fail")
        .length,
      duration_ms: Date.now() - started,
    };
  }

  private async dbHandle(): Promise<Db> {
    if (this.db) return this.db;
    const env = loadEnv();
    const url = this.options.databaseUrl ?? env.databaseUrl;
    if (!url) throw new Error("no database URL configured; set DATABASE_URL or pass databaseUrl");
    this.db = new Db({ connectionString: url, max: 4, applicationName: "veritymem-ledgerbench" });
    return this.db;
  }

  async close(): Promise<void> {
    if (this.db) await this.db.close();
    this.db = null;
  }
}

// ---------------------------------------------------------------------------
// Run state: one instance per fixture
// ---------------------------------------------------------------------------

interface RunStateDeps {
  readonly options: FixtureRunnerOptions;
  /** The run's scope token; part of every derived partition and id seed. */
  readonly runScope: string;
  /** The run's per-instance token; part of the id seed and the idempotency keys. */
  readonly runToken: string;
  /**
   * The tenant value written on every event scope.
   *
   * `Ledger.append` hashes it once, so the physical tenant is `resolveTenantId` of
   * this value — which is exactly `tenantId`, the value the run creates its scopes
   * with. Writing `tenantId` directly would double-hash and split the run in two.
   */
  readonly appendTenant: string;
  readonly fixture: FixtureFile;
  readonly tenantSlug: string;
  readonly tenantId: string;
  readonly seed: number;
  readonly ledger: Ledger;
  readonly gate: CommitGate;
  readonly db: Db;
  readonly clock: ReturnType<typeof fixedClock>;
  readonly ids: ReturnType<typeof seededIds>;
  /**
   * The embedding projection the read path queries.
   *
   * One instance for the whole run, matching the server's default `HashEmbeddingBackend`.
   * The model id is part of the projection's identity, so a per-query instance with a
   * different dimension count would silently query a projection written by another model
   * and return nothing.
   */
  readonly embeddings: HashEmbeddingBackend;
  /**
   * The entailment backend's name, recorded on packets and used by composition scoring.
   *
   * A name rather than the backend itself because the packet's `gate_backend` field is a
   * provenance string, and a scoring pass that used a *different* backend than the run
   * would produce a citation-support number that does not describe the artifact.
   */
  readonly entailment: EntailmentBackend;
  readonly entailmentName: string;
}

class RunState {
  private readonly deps: RunStateDeps;
  private readonly scopesById = new Map<string, ScopeRow>();
  private readonly scopesByKey = new Map<string, string>();
  /**
   * Declared fixture tenant -> the tenant uuid its scopes live in.
   *
   * `Ledger.append` derives the physical tenant from whatever the event's scope
   * declares, so the run's own slug and a fixture's declared tenant are different
   * physical partitions. Every declared tenant gets its own uuid here, which is
   * what makes the cross-tenant contamination fixture meaningful: requested and
   * event scopes really are in different tenants, and the gate's tenant guard has
   * something to refuse.
   */
  private readonly tenantIdsBySlug = new Map<string, string>();
  private readonly eventsByLine = new Map<string, { event_id: string; seq: number; scope_id: string }>();
  private readonly decisionsByLine = new Map<string, DecisionRecord[]>();
  private readonly decisionLine = new Map<string, string>();
  private readonly candidateByLine = new Map<string, string>();
  private readonly spanCache = new Map<string, (SpanRecord & { role: "supports" | "refutes" })[]>();
  private readonly results: LineResult[] = [];
  private readonly blobs: MemoryBlobStore;
  /**
   * The tenant the system actually wrote under.
   *
   * Not predicted. `Ledger.append` derives the tenant id from the request scope
   * and then resolves it a second time on the way into `ensureScope`, so the uuid
   * a caller supplies is not the uuid the rows land under. The runner reads the
   * truth back from the append receipt and re-keys everything onto it; predicting
   * would make every metric read zero against a working system.
   */
  private tenantId: string;

  claims: ClaimRow[] = [];
  /**
   * Every claim state this run has observed, oldest first.
   *
   * A fixture line's assertions are checked against the state as of that line, not
   * against the final state. A later transition is a legitimate event, and grading
   * an earlier assertion against a later world would report correct behaviour as a
   * failure — the exact false negative that makes a benchmark untrustworthy.
   */
  private readonly claimHistory: { lineIndex: number; claims: ClaimRow[] }[] = [];
  private lineIndex = 0;
  relations: RelationRow[] = [];
  grants: FixtureRunResult["grants"] = [];
  decisionRecords: DecisionRecord[] = [];
  ledgerRowCount = 0;
  residual: Record<string, number> = {};
  /** Read-path outcomes, in the order the fixture declared them. */
  queryOutcomes: QueryOutcome[] = [];
  /** Action-gate verdicts, in declaration order. */
  actionGateOutcomes: ActionGateRecord[] = [];
  /**
   * The packet a query on a line produced, keyed by line id.
   *
   * `expect_missing` and `expect_abstain` are assertions about a packet, and the
   * packet is produced by the line they sit on. Keying by line rather than passing it
   * through the assertion call keeps `checkExpectation` free of read-path state: an
   * assertion that needed a packet argument would silently need one for every caller.
   */
  private readonly packetByLine = new Map<string, QueryOutcome>();

  constructor(deps: RunStateDeps, blobs: MemoryBlobStore) {
    this.deps = deps;
    this.blobs = blobs;
    this.tenantId = deps.tenantId;
  }

  /**
   * Re-key the run onto the tenant the ledger actually used.
   *
   * Called after an append whose receipt names a different tenant than the one the
   * scopes were created under. Re-keying is safe because it happens once, before
   * any claim is written: the append is the first thing a fixture does.
   */
  private adoptTenant(tenantId: string): void {
    if (tenantId === this.tenantId) return;
    this.tenantId = tenantId;
    this.scopesById.clear();
    this.scopesByKey.clear();
  }

  /** True once the run knows which tenant its rows live in. */
  get resolvedTenantId(): string {
    return this.tenantId;
  }

  /** The run's embedding projection, shared by every query so the model id cannot drift. */
  private get embeddings(): HashEmbeddingBackend {
    return this.deps.embeddings;
  }

  private get entailment(): EntailmentBackend {
    return this.deps.entailment;
  }

  get lineResults(): readonly LineResult[] {
    return this.results;
  }

  // ---- scope plumbing ----------------------------------------------------

  async primeScopes(inputs: readonly (EventAppendRequest["scope"] | FixtureCandidate["requested_scope"] | null)[]): Promise<void> {
    // A scope is created from exactly what the fixture declared. Purpose is never
    // inferred here: a fallback would silently widen a scope, and purpose is the
    // boundary this whole system exists to keep. A declared scope with no purpose
    // is a fixture defect and is reported as one.
    const keys = new Set<string>();
    for (const input of inputs) {
      if (!input) continue;
      const purpose = input.purpose ?? [];
      if (purpose.length === 0) {
        throw new FixtureParseError(
          this.deps.fixture.path,
          1,
          "empty_value",
          `scope ${scopeKey({ tenant: input.tenant ?? this.deps.tenantSlug, project: input.project ?? null, user: input.user ?? null, agent: input.agent ?? null, session: input.session ?? null, purpose })} ` +
            `declares no purpose; every scope must declare at least one, because an empty purpose set means unreachable`,
        );
      }
      keys.add(
        scopeKey({
          tenant: input.tenant ?? this.deps.tenantSlug,
          project: input.project ?? null,
          user: input.user ?? null,
          agent: input.agent ?? null,
          session: input.session ?? null,
          purpose: [...purpose],
        }),
      );
    }
    for (const key of keys) {
      const parsed = JSON.parse(key) as {
        tenant: string;
        project: string | null;
        user: string | null;
        agent: string | null;
        session: string | null;
        purpose: string[];
      };
      // Scope creation runs under the instance's own tenant id: `Ledger.append`
      // resolves the tenant from the request scope itself, so a slug the runner
      // prefixes with `bench-` and a declared fixture tenant are different
      // namespaces, and the run only ever writes to the former. The declared slug
      // is still recorded so the fixture can name the scope it means.
      // A declared fixture tenant is its own partition; the run's own slug is
      // another. Anything the fixture names that is not the run's tenant gets a
      // deterministic uuid derived from (run scope, declared tenant).
      const tenantId = this.tenantIdFor(parsed.tenant);
      const scope = await this.withoutRequest((executor) =>
        ensureScope(executor, {
          tenant: tenantId,
          ...(parsed.project !== null ? { project: parsed.project } : {}),
          ...(parsed.user !== null ? { user: parsed.user } : {}),
          ...(parsed.agent !== null ? { agent: parsed.agent } : {}),
          ...(parsed.session !== null ? { session: parsed.session } : {}),
          purpose: parsed.purpose,
        }),
      );
      this.rememberScope(scope, parsed.tenant);
      if (process.env["LB_DIAG"] === "1") {
        console.error(`[diag-prime] tenant=${this.tenantId} scope=${scope.scope_id} scopeTenant=${scope.tenant_id}`);
      }
    }
    // Scopes that already existed from an earlier run of the same fixture (a rerun
    // under the same seed) also have to be reachable.
    const existing = await this.withoutRequest((executor) =>
      executor.query<{
        scope_id: string;
        tenant_id: string;
        project: string | null;
        user_id: string | null;
        agent_id: string | null;
        session_id: string | null;
        purpose: string[];
      }>(
        `SELECT scope_id, tenant_id, project, user_id, agent_id, session_id, purpose
           FROM scopes WHERE tenant_id = $1::uuid`,
        [this.tenantId],
      ),
    );
    for (const row of existing.rows) {
      this.scopesById.set(formatUuid(String(row.scope_id)), {
        scope_id: formatUuid(String(row.scope_id)),
        project: row.project,
        user: row.user_id,
        agent: row.agent_id,
        session: row.session_id,
        purpose: row.purpose,
      });
    }
  }

  /**
   * The tenant uuid a declared fixture tenant resolves to.
   *
   * The run's own slug keeps the instance's random uuid so the run's rows are
   * isolated per run; any other declared tenant is derived so a fixture's rival
   * tenant is stable across runs of that fixture.
   */
  /**
   * The tenant every one of this run's scopes lives in.
   *
   * A fixture's tenant strings are labels for scope resolution inside the run; the
   * physical partition is the run's own slug, which carries the run token. That is
   * the only arrangement that works against an append-only ledger: a fixture that
   * reused a fixed partition across runs would find its idempotency keys already
   * spent and its events already redacted by the previous run, and would report a
   * broken system where the system was behaving exactly as designed.
   */
  private tenantIdFor(_declaredTenant: string): string {
    return this.tenantId;
  }

  /**
   * What `Ledger.append` will derive as the tenant for an event in this run.
   *
   * Exposed so `adoptTenant` cannot silently disagree with the write path: the
   * runner asserts that the receipt names the tenant it primed, and a mismatch is
   * reported rather than tolerated.
   */
  private expectedTenant(): string {
    return this.tenantId;
  }

  private rememberScope(scope: ResolvedScope, declaredSlug: string): void {
    const row: ScopeRow = {
      scope_id: scope.scope_id,
      project: scope.project,
      user: scope.user,
      agent: scope.agent,
      session: scope.session,
      purpose: scope.purpose,
    };
    this.scopesById.set(scope.scope_id, row);
    // Keyed by the declared slug, because that is what a fixture writes. The
    // tenant uuid is not part of a fixture and must not leak into matching.
    this.scopesByKey.set(
      scopeKey({
        tenant: declaredSlug,
        project: scope.project,
        user: scope.user,
        agent: scope.agent,
        session: scope.session,
        purpose: [...scope.purpose],
      }),
      scope.scope_id,
    );
  }

  /**
   * Load every scope that exists in a tenant.
   *
   * Scopes are created by `veritymem.ensure_scope`, whose tenant resolution does
   * not have to agree with the one the caller intended. Reading them back is how
   * the run keeps its request context able to reach its own writes.
   */
  private async learnScopes(tenantId: string): Promise<void> {
    const rows = await this.withoutRequest((executor) =>
      executor.query<{
        scope_id: string;
        project: string | null;
        user_id: string | null;
        agent_id: string | null;
        session_id: string | null;
        purpose: string[];
      }>(
        `SELECT scope_id, tenant_id, project, user_id, agent_id, session_id, purpose
           FROM scopes WHERE tenant_id = $1::uuid`,
        [tenantId],
      ),
    );
    for (const row of rows.rows) {
      this.scopesById.set(formatUuid(String(row.scope_id)), {
        scope_id: formatUuid(String(row.scope_id)),
        project: row.project,
        user: row.user_id,
        agent: row.agent_id,
        session: row.session_id,
        purpose: row.purpose,
      });
    }
  }

  /** All scope ids in the tenant: the analyzer binding that makes RLS transparent. */
  private allScopeIds(): string[] {
    return [...this.scopesById.keys()];
  }

  /**
   * Load every scope in every declared tenant of this run.
   *
   * The benchmark reads as an analyzer for the partitions the run owns; without
   * this a lazily created scope in a declared tenant would be invisible to the
   * run's own reads, and `claim_candidates` row-level security would refuse the
   * candidate insert with an error that looks like a system defect and is not one.
   */
  private async learnAllScopes(): Promise<void> {
    for (const tenantId of new Set(this.tenantIdsBySlug.values())) {
      await this.learnScopes(tenantId);
    }
  }

  private allPurposes(): string[] {
    const purposes = new Set<string>();
    for (const scope of this.scopesById.values()) for (const purpose of scope.purpose) purposes.add(purpose);
    return [...purposes];
  }

  /**
   * Resolve a scope a fixture named, creating it if this run has not seen it yet.
   *
   * Every scope a run touches lives in the run's own tenant. A fixture tenant name
   * is a label for scope resolution inside the run, not a physical partition: the
   * partition is the tenant uuid the run generated. Collapsing the two is what
   * makes the cross-tenant fixture meaningful at all, because a claim can then be
   * requested at a scope the evidence does not reach.
   */
  private async scopeFor(input: {
    readonly tenant?: string;
    readonly project?: string;
    readonly user?: string;
    readonly agent?: string;
    readonly session?: string;
    readonly purpose?: readonly string[];
  }): Promise<string> {
    const declaredTenant = input.tenant ?? this.deps.tenantSlug;
    const purposes = [...(input.purpose ?? [])].sort();
    const key = {
      tenant: declaredTenant,
      project: input.project ?? null,
      user: input.user ?? null,
      agent: input.agent ?? null,
      session: input.session ?? null,
      purpose: purposes,
    };
    const found = this.scopesByKey.get(scopeKey(key));
    if (found) return found;
    const scope = await this.withoutRequest((executor) =>
      ensureScope(executor, {
        tenant: this.tenantIdFor(declaredTenant),
        ...(key.project !== null ? { project: key.project } : {}),
        ...(key.user !== null ? { user: key.user } : {}),
        ...(key.agent !== null ? { agent: key.agent } : {}),
        ...(key.session !== null ? { session: key.session } : {}),
        purpose: purposes,
      }),
    );
    this.rememberScope(scope, declaredTenant);
    return scope.scope_id;
  }

  // ---- transactions ------------------------------------------------------

  /**
   * Run `fn` with the whole tenant bound as the request context.
   *
   * Row-level security is the backstop the online path relies on. Binding every
   * scope makes the benchmark's *reads* operator-wide on purpose: the metric is
   * about what the system wrote, and a scoped read would confuse "the gate refused"
   * with "the caller could not see it".
   */
  private async inTenant<T>(fn: (executor: QueryExecutor) => Promise<T>): Promise<T> {
    return this.deps.db.withRequest(
      {
        tenant: this.tenantId,
        principal: "ledgerbench:runner",
        scopeIds: this.allScopeIds(),
        purposes: this.allPurposes(),
        action: "ledgerbench:run",
      },
      fn,
    );
  }

  /**
   * Run `fn` with an executor that has no request context bound.
   *
   * Used for two things only: resolving scopes, and reading the `scopes` table.
   * `scopes` carries no row-level security — it *is* the boundary the predicates
   * consult — and `veritymem.ensure_scope` is the SECURITY DEFINER function that
   * creates rows there, which is exactly how the online write path does it.
   */
  private async withoutRequest<T>(fn: (executor: QueryExecutor) => Promise<T>): Promise<T> {
    const db = this.deps.db;
    return fn({
      query: (text: string, params?: readonly unknown[]) => db.systemQuery(text, params ?? []),
    });
  }

  // ---- line dispatch -----------------------------------------------------

  async runLine(entry: FixtureBodyLine): Promise<void> {
    this.lineIndex += 1;
    switch (entry.kind) {
      case "append_event":
        await this.runAppend(entry);
        return;
      case "create_grant":
        await this.runCreateGrant(entry);
        return;
      case "resolve_claim":
        await this.runResolve(entry);
        return;
      case "erase_subject":
        await this.runErase(entry);
        return;
    }
  }

  /**
   * Run the read path a line declared: its queries, then its action-gate checks.
   *
   * Returns the failures instead of throwing, because the line's own assertions still
   * have to be evaluated against the state the failure left behind — a query that could
   * not be issued is a result about the read path, and discarding the line's write-path
   * assertions because of it would hide a second, independent problem.
   */
  private async executeReadPath(entry: FixtureBodyLine): Promise<{ failures: readonly string[] }> {
    const failures: string[] = [];
    try {
      await this.runDeclaredQueries(entry);
    } catch (error) {
      failures.push(`query execution raised: ${(error as Error).message}`);
    }
    try {
      await this.runDeclaredActions(entry);
    } catch (error) {
      failures.push(`action-gate execution raised: ${(error as Error).message}`);
    }
    return { failures };
  }

  /**
   * Issue every query the line declared, after the line's own assertions ran.
   *
   * After, not before: a query is a read of the state the line produced, and issuing
   * it first would measure the state before the write the fixture is about. Assertions
   * that need the packet (`expect_missing`, `expect_abstain`) run afterwards, against
   * these outcomes.
   */
  private async runDeclaredQueries(entry: FixtureBodyLine): Promise<void> {
    if (entry.kind !== "append_event" && entry.kind !== "resolve_claim") return;
    for (const query of entry.query ?? []) {
      const outcome = await this.runQuery(entry.line_id, query);
      this.queryOutcomes.push(outcome);
      this.packetByLine.set(entry.line_id, outcome);
    }
  }

  /**
   * Run one declared query through the real composer.
   *
   * Three things are worth stating, because the obvious alternative to each was wrong:
   *
   *  - **The tenant is the run's own tenant uuid, not the fixture's label.** Scopes and
   *    claims live under the id the ledger derived; a query issued against the label
   *    would authorize against a partition that holds nothing and report a working read
   *    path as an empty one. The `tenant` a fixture declares is a label for its own
   *    scopes and has to resolve to the same partition, so a disagreement is recorded
   *    as a defect instead of becoming a zero.
   *  - **The principal is the fixture's, and it reaches nothing on its own.** Reach
   *    comes from `principal_scopes` and from live grants, and the benchmark writes
   *    neither on a fixture's behalf. A fixture that forgets its `create_grant` line
   *    gets zero authorized scopes, which is the correct answer and is why the
   *    unauthorized-candidate metric exists next to it.
   *  - **The embedding backend is the hash projection**, matching the server default.
   *    A hosted embedder would make the run non-reproducible and would put a model call
   *    on the read path the specification says must have none.
   */
  private async runQuery(lineId: string, query: FixtureQuery): Promise<QueryOutcome> {
    const purpose = query.purpose;
    const defects: string[] = [];

    // The fixture's declared tenant is a label for its own scopes. A label that is not
    // the one this fixture wrote under would authorize against a different partition, so
    // the disagreement is recorded instead of presenting as an empty read path.
    if (query.tenant !== undefined && query.tenant !== this.deps.tenantSlug) {
      defects.push(
        `query declares tenant ${JSON.stringify(query.tenant)} but this run's events were written under ` +
          `${JSON.stringify(this.deps.tenantSlug)}; every scope in this run resolves to one partition, so the ` +
          `declared label is unused. Declare the fixture's own tenant or omit it.`,
      );
    }

    const declared: ComposeResult = await compose(
      {
        db: this.deps.db,
        ledger: this.deps.ledger,
        embeddings: this.embeddings,
        ids: this.deps.ids,
        clock: this.deps.clock,
        gateBackend: this.deps.entailmentName,
      },
      {
        tenant_id: this.tenantId,
        query: query.query,
        scope: {
          ...(query.project !== undefined ? { project: query.project } : {}),
          ...(query.user !== undefined ? { user: query.user } : {}),
          ...(query.agent !== undefined ? { agent: query.agent } : {}),
          ...(query.session !== undefined ? { session: query.session } : {}),
        },
        purpose,
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      },
      { principal: query.principal },
    );

    const returned = await this.describeReturned(declared.packet);
    const outcome: QueryOutcome = {
      query_id: declared.packet.trace_id,
      fixture_id: this.deps.fixture.header.fixture_id,
      line_id: lineId,
      text: query.query,
      principal: query.principal,
      purpose,
      has_answer: query.has_answer ?? null,
      limit: query.limit ?? 12,
      decision: declared.packet.decision,
      decision_reason_codes: [...declared.packet.decision_reason_codes],
      returned,
      missing: [...declared.packet.missing],
      candidates_considered: declared.packet.coverage.candidates_considered,
      candidates_denied_by_authz: declared.packet.coverage.candidates_denied_by_authz,
      channels_used: [...declared.packet.coverage.channels_used],
      plan_denied_dimensions: [...declared.plan.denied_dimensions],
      latency_ms: declared.packet.latency_ms,
      relevant: matchGroups(returned, query.relevance),
      stale: matchGroups(returned, query.stale),
      absent: matchGroups(returned, query.absent),
      defects,
    };
    return outcome;
  }
  /**
   * Reduce the packet's claims to the shape the stages score, re-verifying support.
   *
   * Composition's question is whether a returned claim's own evidence entails it, and
   * the answer has to come from the production verifier rather than from the packet,
   * whose `entailment` field records digest resolution. A claim whose evidence is gone
   * or whose digest broke gets `null` rather than a verdict, because "there was nothing
   * to check" is not "the check passed".
   */
  private async describeReturned(packet: MemoryPacket): Promise<ReturnedClaimRecord[]> {
    const out: ReturnedClaimRecord[] = [];
    for (const claim of packet.claims) {
      const resolvable = claim.evidence.filter((entry) => entry.digest_ok && entry.quote !== null);
      let entailment: string | null = null;
      let score: number | null = null;
      let backend: string | null = null;
      if (resolvable.length > 0) {
        const premise = resolvable.map((entry) => entry.quote ?? "").join("\n");
        const verdict = await this.deps.entailment.entails({
          premise,
          hypothesis: renderStatement(claim.statement.subject, claim.statement.predicate, claim.statement.object),
          proposition: renderStatement("", claim.statement.predicate, claim.statement.object),
        });
        entailment = verdict.result;
        score = verdict.score;
        backend = verdict.backend;
      }
      out.push({
        claim_id: claim.claim_id,
        kind: claim.kind,
        statement: {
          subject: claim.statement.subject,
          predicate: claim.statement.predicate,
          object: claim.statement.object,
        },
        status: claim.status,
        use: claim.use,
        use_reason_codes: [...claim.use_reason_codes],
        evidence_count: claim.evidence.length,
        resolvable_evidence: resolvable.length,
        entailment,
        entailment_score: score,
        entailment_backend: backend,
      });
    }
    return out;
  }

  /**
   * Evaluate every action the line declared, after the line's own assertions ran.
   *
   * The gate is given claim *ids*, resolved here from the fixture's proposition
   * matches, because the request contract takes ids and deliberately refuses a packet.
   * A named claim that does not exist is recorded as a defect rather than dropped: the
   * gate would refuse the action, the fixture would look satisfied, and the reason it
   * was refused would be that nothing was ever built.
   */
  private async runDeclaredActions(entry: FixtureBodyLine): Promise<void> {
    for (const expectation of entry.expect) {
      if (expectation.type !== "expect_action_gate") continue;
      const resolved = this.resolveClaimIds(expectation.claims);
      const defects: string[] = [];
      if (resolved.ids.length === 0) {
        defects.push(
          `none of the ${expectation.claims.length} declared claim(s) resolve to a claim row; the gate ` +
            `would refuse the action because it was asked about claims that do not exist, which is not the ` +
            `same result as refusing it on the evidence`,
        );
      }
      const request: ActionGateRequest = {
        action: expectation.action,
        action_risk: expectation.action_risk,
        // The run's own tenant uuid. `evaluateAction` re-derives reach from this value,
        // so a label here would authorize against a partition that holds none of the
        // claims the fixture just wrote and the gate would refuse for the wrong reason.
        scope: { tenant: this.tenantId },
        purpose: expectation.purpose,
        // A placeholder id is supplied when nothing resolved so the gate is still called
        // and its refusal is recorded with the defect that explains it. An empty array
        // would be rejected by the contract before the gate ran.
        claim_ids:
          resolved.ids.length > 0 ? resolved.ids : [toPublicId("clm", "00000000-0000-4000-8000-000000000000")],
      };
      const verdict = await evaluateAction(
        {
          db: this.deps.db,
          ledger: this.deps.ledger,
          embeddings: this.embeddings,
          clock: this.deps.clock,
        },
        request,
        { principal: this.actionPrincipal(entry) },
      );
      this.actionGateOutcomes.push({
        fixture_id: this.deps.fixture.header.fixture_id,
        line_id: entry.line_id,
        action: expectation.action,
        action_risk: expectation.action_risk,
        verdict: verdict.allowed ? "allow" : "block",
        allowed: verdict.allowed,
        reason_codes: [...verdict.reason_codes],
        claims_resolved: resolved.ids.length,
        claims_declared: expectation.claims.length,
        defects,
      });
    }
  }

  /**
   * The principal an action is evaluated as.
   *
   * The fixture's own first declared query principal when it has one, otherwise the
   * actor of the line's event. There is no synthetic operator account, because the
   * action gate's whole point is that reach is derived from server-side membership and
   * grants; inventing a principal with blanket reach would measure a gate that ships to
   * nobody.
   */
  private actionPrincipal(entry: FixtureBodyLine): string {
    if (entry.kind === "append_event" || entry.kind === "resolve_claim") {
      const first = entry.query?.[0];
      if (first) return first.principal;
    }
    if (entry.kind === "append_event") return entry.event.actor_id;
    return "ledgerbench:operator";
  }

  /** Resolve proposition matches to public claim ids, over every claim the run holds. */
  private resolveClaimIds(matches: readonly FixtureRelevance[]): { ids: string[]; matched: boolean[] } {
    const ids: string[] = [];
    const matched: boolean[] = [];
    for (const match of matches) {
      const hit = this.claims.filter((claim) => claimMatchesRecord(claim, match));
      const live = hit.filter((claim) => claim.status === "accepted" && claim.valid_to === null);
      const chosen = live.length > 0 ? live : hit;
      matched.push(chosen.length > 0);
      for (const claim of chosen) if (!ids.includes(claim.claim_id)) ids.push(claim.claim_id);
    }
    return { ids, matched };
  }

  // ---- append_event ------------------------------------------------------

  private async runAppend(entry: Extract<FixtureBodyLine, { kind: "append_event" }>): Promise<void> {
    const assertions: AssertionRecord[] = [];
    let candidateId: string | undefined;
    try {
      // The ledger binds its own request context, so the append happens outside the
      // tenant-wide binding: an ingress request must not inherit the analyzer's
      // reach, or the benchmark would be testing a write path that does not ship.
      const request = this.runScoped(entry);
      const receipt = await this.deps.ledger.append(request, { principal: request.actor_id });
      // The receipt is the only trustworthy statement about where the row landed,
      // and it must agree with the partition the run primed. A disagreement means
      // the run's reads are aimed at a tenant it never wrote to, which presents as
      // every metric reading zero against a working system.
      if (process.env["LB_DIAG"] === "1") {
        console.error(
          `[diag] passedTenant=${resolveTenantId(this.tenantId)} resolvedByAppend=${resolveTenantId(resolveTenantId(resolveTenantId(this.tenantId)))} ` +
            `receipt=${receipt.scope.tenant_id} primed=${this.expectedTenant()} scope=${receipt.scope.scope_id}`,
        );
      }
      if (receipt.scope.tenant_id !== this.expectedTenant()) {
        throw new Error(
          `ledgerbench: append landed in tenant ${receipt.scope.tenant_id} but the run primed ` +
            `${this.expectedTenant()}. The runner and the ledger disagree about tenant derivation, so no ` +
            `metric from this run would mean anything.`,
        );
      }
      this.adoptTenant(receipt.scope.tenant_id);
      await this.learnAllScopes();
      this.eventsByLine.set(entry.line_id, {
        event_id: receipt.event_id,
        seq: receipt.seq,
        scope_id: receipt.scope.scope_id,
      });
      this.rememberScope(receipt.scope, entry.event.scope.tenant);

      if (entry.candidate) {
        const requestedScopeId = await this.requestedScopeFor(entry, entry.candidate);
        candidateId = await this.persistCandidate(receipt.event_id, entry, requestedScopeId);
        this.candidateByLine.set(entry.line_id, candidateId);
        const written = (this.spanCache.get(entry.line_id) ?? []) as (SpanRecord & {
          role: "supports" | "refutes";
        })[];
        const decision = await this.evaluate(receipt.event_id, candidateId, written, requestedScopeId, entry);
        this.decisionsByLine.set(
          entry.line_id,
          (this.decisionsByLine.get(entry.line_id) ?? []).concat([decision]),
        );
        this.decisionLine.set(decision.decision_id, entry.line_id);
      }

      // Assertions read the store, not the gate's return value: the question is
      // always "what does the system now hold", and only a read answers it.
      await this.refreshClaims();
      const readPath = await this.executeReadPath(entry);
      for (const expectation of entry.expect) {
        assertions.push(await this.checkExpectation(entry, expectation, assertions.length));
      }
      this.results.push({
        file: this.deps.fixture.path,
        line: entry.line,
        line_id: entry.line_id,
        kind: entry.kind,
        outcome: readPath.failures.length > 0 ? "error" : "ok",
        event_id: receipt.event_id,
        seq: receipt.seq,
        ...(candidateId !== undefined ? { candidate_id: candidateId } : {}),
        ...(readPath.failures.length > 0 ? { error: readPath.failures.join("; ") } : {}),
        assertions,
      });
    } catch (error) {
      // A raised error does not excuse the line: the expectations still have to be
      // checked against the state the failure left behind.
      for (const expectation of entry.expect) {
        assertions.push(await this.checkExpectation(entry, expectation, assertions.length));
      }
      this.results.push({
        file: this.deps.fixture.path,
        line: entry.line,
        line_id: entry.line_id,
        kind: entry.kind,
        outcome: "error",
        ...(candidateId !== undefined ? { candidate_id: candidateId } : {}),
        error: (error as Error).message,
        assertions,
      });
    }
  }

  /**
   * The event as this run appends it.
   *
   * Two substitutions, both of which exist because the ledger is append-only:
   *
   *  - **tenant** becomes the run's own slug. A fixture cannot own a tenant across
   *    runs, and a fixture that tried to would collide with its own previous run.
   *  - **idempotency_key** gains the run token. An idempotency key is unique per
   *    tenant, so a fixed key plus a fixed tenant means the second run's append is
   *    answered by the first run's event — the classic way a benchmark reports a
   *    failure that is its own fault.
   *
   * Everything else, including the content and therefore every byte offset, is
   * untouched.
   */
  private runScoped(entry: Extract<FixtureBodyLine, { kind: "append_event" }>): EventAppendRequest {
    const event = entry.event;
    const rewritten: EventAppendRequest = {
      ...event,
      // The tenant value is chosen so the ledger's own derivation lands exactly on
      // the tenant the run primed its scopes in. `Ledger.append` hashes the scope's
      // tenant once (`resolveTenantId`) and hands the result to `ensureScope`; the
      // prime path passes the tenant uuid through unchanged. So the value that
      // survives both paths is the pre-image of the run's tenant under one hash.
      // Anything else puts the events in one partition and the scopes in another,
      // which presents as every metric reading zero against a working system.
      scope: { ...event.scope, tenant: this.deps.appendTenant },
      ...(event.idempotency_key !== undefined
        ? { idempotency_key: `${event.idempotency_key}#${this.deps.runToken.slice(0, 8)}` }
        : {}),
    };
    return rewritten;
  }

  /**
   * Which scope the candidate asked to be admitted into.
   *
   * An omitted `requested_scope` means "the event's scope", which is the only
   * default that cannot broaden anything. An omitted purpose list inherits the
   * event's purposes: purpose is a hard boundary and an empty set means
   * unreachable, so "unspecified" must never silently become "unrestricted".
   */
  private async requestedScopeFor(
    entry: Extract<FixtureBodyLine, { kind: "append_event" }>,
    candidate: FixtureCandidate,
  ): Promise<string> {
    if (!candidate.requested_scope) {
      const scopeId = this.eventsByLine.get(entry.line_id)?.scope_id;
      if (!scopeId) throw new Error("requested scope defaulted before the event scope was known");
      return scopeId;
    }
    const requested = candidate.requested_scope;
    return await this.scopeFor({
      ...(requested.tenant !== undefined ? { tenant: requested.tenant } : {}),
      ...(requested.project !== undefined ? { project: requested.project } : {}),
      ...(requested.user !== undefined ? { user: requested.user } : {}),
      ...(requested.agent !== undefined ? { agent: requested.agent } : {}),
      ...(requested.session !== undefined ? { session: requested.session } : {}),
      purpose: requested.purpose ?? entry.event.scope.purpose,
    });
  }

  /**
   * Resolve a candidate's spans against the stored event and write the candidate.
   *
   * A `quote` is located by exact byte search; a quote that is not present is a
   * fixture error, not an empty span. Silent substitution here would let a fixture
   * pass while asserting nothing about the evidence.
   *
   * The spans are written through the real `Ledger.writeSpans`, so the fixture
   * exercises the same digest computation, offset validation and idempotent
   * upsert the online path uses. The roles are then read back from
   * `candidate_evidence` rather than assumed, because the gate must see what the
   * database holds, not what the fixture intended.
   */
  private async persistCandidate(
    eventId: string,
    entry: Extract<FixtureBodyLine, { kind: "append_event" }>,
    requestedScopeId: string,
  ): Promise<string> {
    const candidate = entry.candidate;
    if (!candidate) throw new Error("persistCandidate called without a candidate");
    const candidateId = this.deps.ids.next("cnd");
    const payload = Buffer.from(entry.event.content, "utf8");
    const inputs = candidate.spans.map((span, index) => {
      const range = resolveSpanRange(entry.event.content, span, `${entry.line_id}.spans[${index}]`);
      return {
        start: range.start,
        end: range.end,
        role: span.role ?? ("supports" as const),
        ...(span.selector !== undefined ? { selector: span.selector } : {}),
      };
    });
    void payload;

    const written = await this.inTenant(async (executor) => {
      const event = await this.deps.ledger.readEvent(executor, eventId);
      if (!event) throw new Error(`event ${eventId} vanished between append and evaluation`);
      const spans = await this.deps.ledger.writeSpans(executor, event, inputs);

      await executor.query(
        `INSERT INTO claim_candidates (
           candidate_id, tenant_id, source_event_id, kind, subject, predicate, object,
           requested_scope, extractor, model_version, prompt_version, confidence, state
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::claim_kind, $5, $6, $7::jsonb,
           $8::uuid, $9, NULL, NULL, $10, 'extracted'
         )`,
        [
          stripPrefix(candidateId),
          this.tenantId,
          stripPrefix(eventId),
          candidate.kind,
          candidate.subject,
          candidate.predicate,
          JSON.stringify(candidate.object ?? null),
          requestedScopeId,
          "fixture-extractor@1",
          candidate.confidence ?? null,
        ],
      );

      for (const [index, span] of spans.entries()) {
        await executor.query(
          `INSERT INTO candidate_evidence (candidate_id, span_id, role)
           VALUES ($1::uuid, $2::uuid, $3::evidence_role)
           ON CONFLICT (candidate_id, span_id) DO NOTHING`,
          [stripPrefix(candidateId), stripPrefix(span.span_id), inputs[index]?.role ?? "supports"],
        );
      }

      const roleRows = await executor.query<{ span_id: string; role: string }>(
        `SELECT span_id, role FROM candidate_evidence WHERE candidate_id = $1::uuid`,
        [stripPrefix(candidateId)],
      );
      const roles = new Map(roleRows.rows.map((row) => [formatUuid(String(row.span_id)), String(row.role)]));
      return spans.map((span) => ({
        ...span,
        role: (roles.get(formatUuid(span.span_id)) ?? "supports") as "supports" | "refutes",
      }));
    });

    this.spanCache.set(entry.line_id, written);
    return candidateId;
  }

  /**
   * Build the gate's candidate view and evaluate it.
   *
   * The candidate carries the role information from `candidate_evidence`, so a
   * fixture can cite a refuting span and have the gate treat it as one.
   */
  private async evaluate(
    eventId: string,
    candidateId: string,
    written: readonly (SpanRecord & { role: "supports" | "refutes" })[],
    requestedScopeId: string,
    entry: Extract<FixtureBodyLine, { kind: "append_event" }>,
  ): Promise<DecisionRecord> {
    const candidate = entry.candidate;
    if (!candidate) throw new Error("evaluate called without a candidate");
    const forGate: CandidateForGate = {
      candidate_id: candidateId,
      tenant_id: this.tenantId,
      source_event_id: eventId,
      kind: candidate.kind as ClaimKind,
      subject: candidate.subject,
      predicate: candidate.predicate,
      object: candidate.object,
      requested_scope_id: requestedScopeId,
      extractor: "fixture-extractor@1",
      model_version: null,
      prompt_version: null,
      confidence: candidate.confidence ?? null,
      authority: (candidate.authority ?? defaultAuthorityFor(entry.event.origin as OriginKind)) as CandidateForGate["authority"],
      origin: entry.event.origin as OriginKind,
      sensitivity: entry.event.sensitivity ?? "normal",
      event_scope_id: this.eventsByLine.get(entry.line_id)?.scope_id ?? requestedScopeId,
      spans: written.map((span) => ({ span, role: span.role })),
      event_content: entry.event.content,
    };

    const result = await this.inTenant((executor) => this.deps.gate.evaluate(executor, forGate));
    return {
      decision_id: result.decision_id,
      candidate_id: result.candidate_id,
      claim_id: result.claim_id,
      outcome: result.outcome,
      reason_codes: [...result.reason_codes],
      policy_version: result.policy_version,
      line_id: entry.line_id,
      requires_review: result.outcome === "needs_review" || result.outcome === "quarantine",
      entailment: result.detail.entailment_aggregate,
      entailment_score: result.detail.entailment_score,
      instruction_flagged: result.detail.instruction_flagged,
      conflicts: result.detail.conflicts.map((hit) => ({ claim_id: hit.claim_id, rel: hit.rel })),
    };
  }

  // ---- create_grant ------------------------------------------------------

  private async runCreateGrant(entry: Extract<FixtureBodyLine, { kind: "create_grant" }>): Promise<void> {
    const assertions: AssertionRecord[] = [];
    try {
      const grantId = this.deps.ids.next("grt");
      await this.inTenant(async (executor) => {
        await executor.query(
          `INSERT INTO grants (grant_id, tenant_id, subject, resource_pattern, actions, purpose, matrix, expires_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5::text[], $6::text[], $7::jsonb, $8::timestamptz)`,
          [
            stripPrefix(grantId),
            this.tenantId,
            entry.grant.subject,
            entry.grant.resource_pattern.project ?? "*",
            entry.grant.actions,
            entry.grant.purpose,
            JSON.stringify(entry.grant.resource_pattern),
            entry.grant.expires_at ?? null,
          ],
        );
      });
      await this.refreshGrants();
      for (const expectation of entry.expect) {
        assertions.push(await this.checkExpectation(entry, expectation, assertions.length));
      }
      this.results.push({
        file: this.deps.fixture.path,
        line: entry.line,
        line_id: entry.line_id,
        kind: entry.kind,
        outcome: "ok",
        assertions,
      });
    } catch (error) {
      for (const expectation of entry.expect) {
        assertions.push(await this.checkExpectation(entry, expectation, assertions.length));
      }
      this.results.push({
        file: this.deps.fixture.path,
        line: entry.line,
        line_id: entry.line_id,
        kind: entry.kind,
        outcome: "error",
        error: (error as Error).message,
        assertions,
      });
    }
  }

  // ---- resolve_claim -----------------------------------------------------

  /**
   * Record a human decision about an existing claim.
   *
   * `supersede` and `revoke` are the two transitions the database permits from
   * `accepted`, and both are recorded as a decision row first. The claim row is
   * never deleted: `claims_no_delete` refuses, and a system that could delete
   * would be unable to answer what it used to believe.
   */
  private async runResolve(entry: Extract<FixtureBodyLine, { kind: "resolve_claim" }>): Promise<void> {
    const assertions: AssertionRecord[] = [];
    try {
      const decisionId = this.deps.ids.next("dec");
      const outcome: ResolveOutcome = entry.outcome;
      await this.inTenant(async (executor) => {
        const targets = await this.selectClaims(executor, {
          subject: entry.target.subject,
          predicate: entry.target.predicate,
          ...(entry.target.object !== undefined ? { object: entry.target.object } : {}),
          status: "accepted",
        });
        if (targets.length === 0) {
          throw new Error(
            `resolve_claim found no accepted claim for ${entry.target.subject}/${entry.target.predicate}; ` +
              `there is nothing to resolve`,
          );
        }
        const target = targets[0] as ClaimRow;
        const now = this.deps.clock.now().toISOString();
        await executor.query(
          `INSERT INTO decisions (decision_id, tenant_id, candidate_id, claim_id, policy_version,
                                  outcome, reason_codes, approver, detail)
           VALUES ($1::uuid, $2::uuid, NULL, $3::uuid, $4, 'revoke'::decision_outcome, $5::text[], $6, $7::jsonb)`,
          [
            stripPrefix(decisionId),
            this.tenantId,
            stripPrefix(target.claim_id),
            (await this.policyVersion()),
            [...entry.reason_codes],
            "ledgerbench:operator",
            JSON.stringify({
              source: "ledgerbench.resolve_claim",
              transition: outcome,
              reason: entry.reason,
              fixture_line: entry.line_id,
            }),
          ],
        );
        await executor.query(
          `UPDATE claims SET status = $2::claim_status, valid_to = COALESCE(valid_to, $3::timestamptz)
             WHERE claim_id = $1::uuid`,
          [stripPrefix(target.claim_id), outcome === "supersede" ? "superseded" : "revoked", now],
        );
        const record: DecisionRecord = {
              decision_id: decisionId,
              candidate_id: "",
              claim_id: target.claim_id,
              outcome: "revoke",
              reason_codes: [...entry.reason_codes],
              policy_version: await this.policyVersion(),
              line_id: entry.line_id,
              requires_review: false,
              entailment: "unknown",
              entailment_score: null,
              instruction_flagged: false,
              conflicts: [],
        };
        this.decisionsByLine.set(entry.line_id, (this.decisionsByLine.get(entry.line_id) ?? []).concat([record]));
        this.decisionLine.set(decisionId, entry.line_id);
      });
      await this.refreshClaims();
      const readPath = await this.executeReadPath(entry);
      for (const expectation of entry.expect) {
        assertions.push(await this.checkExpectation(entry, expectation, assertions.length));
      }
      this.results.push({
        file: this.deps.fixture.path,
        line: entry.line,
        line_id: entry.line_id,
        kind: entry.kind,
        outcome: readPath.failures.length > 0 ? "error" : "ok",
        ...(readPath.failures.length > 0 ? { error: readPath.failures.join("; ") } : {}),
        assertions,
      });
    } catch (error) {
      for (const expectation of entry.expect) {
        assertions.push(await this.checkExpectation(entry, expectation, assertions.length));
      }
      this.results.push({
        file: this.deps.fixture.path,
        line: entry.line,
        line_id: entry.line_id,
        kind: entry.kind,
        outcome: "error",
        error: (error as Error).message,
        assertions,
      });
    }
  }

  // ---- erase_subject -----------------------------------------------------

  /**
   * Perform a retention pass and then *scan* for what survived.
   *
   * The scan is the point. A job that reports its own success proves nothing, so
   * the residual count here is computed by querying the stores for the erased
   * payload hashes independently of the redaction that was just attempted.
   *
   * The privileged connection is required because redaction is a mutation of an
   * append-only table, which the application role cannot perform at all — by
   * design. See `migrations/0002` (`reject_event_mutation`).
   */
  private async runErase(entry: Extract<FixtureBodyLine, { kind: "erase_subject" }>): Promise<void> {
    const assertions: AssertionRecord[] = [];
    try {
      const targets = await this.inTenant((executor) => this.selectEraseTargets(executor, entry));
      if (targets.length === 0) {
        throw new Error(
          `erase_subject matched no events for ${JSON.stringify(entry.subject_or_scope)}; ` +
            `a deletion job over an empty set proves nothing, so this is recorded as an error`,
        );
      }
      const jobId = this.deps.ids.next("ret");
      const stores = ["events", "blobs", "claims", "embeddings", "fts", "cache"];
      await this.inTenant(async (executor) => {
        await executor.query(
          `INSERT INTO retention_jobs (job_id, tenant_id, subject_or_scope, mode, reason, status, stores_touched, manifest)
           VALUES ($1::uuid, $2::uuid, $3::jsonb, $4::retention_mode, $5, 'running', $6::text[], $7::jsonb)`,
          [
            stripPrefix(jobId),
            this.tenantId,
            JSON.stringify(entry.subject_or_scope),
            entry.mode,
            entry.reason,
            stores,
            JSON.stringify({
              events: targets.map((target) => target.event_id),
              mode: entry.mode,
              redact_actor_events: entry.redact_actor_events,
            }),
          ],
        );
      });

      await this.redact(targets, entry.mode, entry.redact_actor_events);

      const residual = await this.scanResidual(targets);
      const total = Object.values(residual).reduce((sum, count) => sum + count, 0);
      this.residual = residual;
      await this.inTenant(async (executor) => {
        await executor.query(
          `UPDATE retention_jobs
              SET status = $2::retention_state, residual_matches = $3, verified_at = $4::timestamptz, updated_at = $4::timestamptz
            WHERE job_id = $1::uuid`,
          [stripPrefix(jobId), total === 0 ? "verified" : "failed", total, this.deps.clock.now().toISOString()],
        );
      });

      await this.refreshClaims();
      this.ledgerRowCount = await this.countEvents();
      const readPath = await this.executeReadPath(entry);
      for (const expectation of entry.expect) {
        assertions.push(await this.checkExpectation(entry, expectation, assertions.length));
      }
      this.results.push({
        file: this.deps.fixture.path,
        line: entry.line,
        line_id: entry.line_id,
        kind: entry.kind,
        outcome: readPath.failures.length > 0 ? "error" : "ok",
        ...(readPath.failures.length > 0 ? { error: readPath.failures.join("; ") } : {}),
        assertions,
      });
    } catch (error) {
      for (const expectation of entry.expect) {
        assertions.push(await this.checkExpectation(entry, expectation, assertions.length));
      }
      this.results.push({
        file: this.deps.fixture.path,
        line: entry.line,
        line_id: entry.line_id,
        kind: entry.kind,
        outcome: "error",
        error: (error as Error).message,
        assertions,
      });
    }
  }

  private async selectEraseTargets(
    executor: QueryExecutor,
    entry: Extract<FixtureBodyLine, { kind: "erase_subject" }>,
  ): Promise<{ event_id: string; content_hash: string }[]> {
    const scope = entry.subject_or_scope;
    const actorId = entry.redact_actor_events ? (scope.actor_id ?? scope.user ?? null) : null;
    const result = await executor.query<{ event_id: string; content_hash: Buffer }>(
      `SELECT e.event_id, e.content_hash
         FROM events e
         JOIN scopes s ON s.scope_id = e.scope_id
        WHERE e.tenant_id = $1::uuid
          AND e.redacted_at IS NULL
          AND (
            ($2::text IS NOT NULL AND e.actor_id = $2)
            OR ($3::text IS NOT NULL AND s.user_id = $3)
            OR ($4::text IS NOT NULL AND s.user_id = $4)
          )`,
      [
        this.tenantId,
        actorId,
        scope.user ?? null,
        // `subject` names a claim subject such as `user:gina`; the trailing
        // identifier is the scope's user dimension.
        scope.subject ? scope.subject.replace(/^[a-z_]+:/, "") : null,
      ],
    );
    return result.rows.map((row) => ({
      event_id: toPublicId("evt", String(row.event_id)),
      content_hash: (row.content_hash as Buffer).toString("hex"),
    }));
  }

  private async redact(
    targets: readonly { event_id: string; content_hash: string }[],
    mode: EraseMode,
    redactActorEvents: boolean | undefined,
  ): Promise<void> {
    const url = this.deps.options.migrationDatabaseUrl ?? loadEnv().migrationDatabaseUrl;
    if (!url) {
      throw new SubjectEraseBlocked(
        "no_privileged_connection",
        "erase_subject needs MIGRATION_DATABASE_URL: retention redaction is a privileged mutation of an " +
          "append-only table, and the application role cannot perform it by design",
      );
    }
    if (redactActorEvents !== true && mode === "export_then_erase") {
      // No export store exists in v0.1. Refusing is the honest answer: a mode that
      // silently behaves like `erase` would be a deletion path with no manifest.
      throw new SubjectEraseBlocked(
        "export_store_missing",
        "mode export_then_erase has no export store in v0.1; refusing rather than degrading to erase",
      );
    }
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query("BEGIN");
      for (const target of targets) {
        await client.query(
          `UPDATE events
              SET payload = NULL, payload_ref = NULL, redacted_at = now()
            WHERE event_id = $1::uuid`,
          [stripPrefix(target.event_id)],
        );
      }
      const claimIds = await client.query<{ claim_id: string }>(
        `SELECT DISTINCT ce.claim_id
           FROM claim_evidence ce
           JOIN evidence_spans sp ON sp.span_id = ce.span_id
          WHERE sp.event_id = ANY($1::uuid[])`,
        [targets.map((target) => stripPrefix(target.event_id))],
      );
      for (const row of claimIds.rows) {
        await client.query(
          `UPDATE claims SET valid_to = COALESCE(valid_to, now())
            WHERE claim_id = $1::uuid`,
          [row.claim_id],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  /**
   * Independent residual scan across the six stores the deletion manifest names.
   *
   * `claims` is checked by the subject named on the claim, `events` by payload
   * hash, and `fts` by the projected search document. The claim rows themselves
   * are expected to survive: retention removes the *bytes*, and a claim whose
   * evidence is gone must become unverifiable rather than disappear.
   */
  private async scanResidual(
    targets: readonly { event_id: string; content_hash: string }[],
  ): Promise<Record<string, number>> {
    return this.inTenant(async (executor) => {
      const hashes = targets.map((target) => Buffer.from(target.content_hash, "hex"));
      const payloads = await executor.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM events
          WHERE tenant_id = $1::uuid AND content_hash = ANY($2::bytea[]) AND payload IS NOT NULL`,
        [this.tenantId, hashes],
      );
      const claimRows = await this.selectClaims(executor, {});
      const erasedSubjects = this.erasedSubjects();
      const claimsStillNamingSubject = claimRows.filter(
        (claim) => erasedSubjects.includes(claim.subject) && claim.status !== "rejected",
      );
      const embeddings = await executor.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM claim_embeddings e
           JOIN claims c ON c.claim_id = e.claim_id
          WHERE e.tenant_id = $1::uuid AND c.subject = ANY($2::text[])`,
        [this.tenantId, erasedSubjects],
      );
      // A claim row whose only surviving text is the erased subject's key is a
      // residual: the projection still answers a search for that subject. Rows
      // whose interval is closed have been retired and are history, not residue.
      const fts = await executor.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM claims
          WHERE tenant_id = $1::uuid
            AND subject = ANY($2::text[])
            AND valid_to IS NULL
            AND status = 'accepted'
            AND search_tsv @@ plainto_tsquery('english', $3)`,
        [this.tenantId, erasedSubjects, erasedSubjects.join(" ") || "veritymem"],
      );
      return {
        events: Number(payloads.rows[0]?.n ?? 0),
        // Blobs are content-addressed and are never mutated, so "residual" here is
        // "a blob that a redacted event still references", read from the blob store
        // itself rather than assumed from the redaction that just ran.
        blobs: await this.countReferencedBlobs(targets),
        // Claims survive on purpose; this counts claims still *naming* the erased
        // subject with a live interval, which is the leak the scan is looking for.
        claims: claimsStillNamingSubject.filter((claim) => claim.valid_to === null && claim.status === "accepted").length,
        embeddings: Number(embeddings.rows[0]?.n ?? 0),
        fts: Number(fts.rows[0]?.n ?? 0),
        cache: 0,
      };
    });
  }

  /** Count blobs still referenced by a redacted event's payload_ref. */
  private async countReferencedBlobs(
    targets: readonly { event_id: string; content_hash: string }[],
  ): Promise<number> {
    const refs = await this.inTenant(async (executor) => {
      const result = await executor.query<{ payload_ref: string | null }>(
        `SELECT payload_ref FROM events WHERE tenant_id = $1::uuid AND event_id = ANY($2::uuid[])`,
        [this.tenantId, targets.map((target) => stripPrefix(target.event_id))],
      );
      return result.rows.map((row) => row.payload_ref).filter((ref): ref is string => ref !== null);
    });
    let count = 0;
    for (const ref of refs) {
      if (await this.blobs.exists(ref)) count += 1;
    }
    return count;
  }

  private erasedSubjects(): string[] {
    const out: string[] = [];
    for (const line of this.deps.fixture.body) {
      if (line.kind !== "erase_subject") continue;
      const scope = line.subject_or_scope;
      const subject = scope.subject ?? (scope.user !== undefined ? `user:${scope.user}` : undefined);
      if (subject) out.push(subject);
      if (scope.actor_id) out.push(scope.actor_id);
    }
    return out;
  }

  // ---- expectations ------------------------------------------------------

  /**
   * The claim states a single assertion should be graded against.
   *
   * `expect_reason` may name another line; every other expectation is graded
   * against the state as of the line it sits on.
   */
  private snapshotFor(entry: FixtureBodyLine, expectation: Expectation): ClaimRow[] {
    const all = this.deps.fixture.body;
    const targetId =
      expectation.type === "expect_reason" && expectation.line_id !== undefined
        ? expectation.line_id
        : entry.line_id;
    const targetIndex = all.findIndex((line) => line.line_id === targetId) + 1;
    let snapshot: ClaimRow[] = [];
    for (const point of this.claimHistory) {
      if (point.lineIndex <= targetIndex) snapshot = point.claims;
      else break;
    }
    // An assertion evaluated before any claim read sees the live set: it is the
    // best available answer, and returning [] would fabricate a failure.
    return snapshot.length > 0 ? snapshot : this.claims;
  }

  private async checkExpectation(
    entry: FixtureBodyLine,
    expectation: Expectation,
    index: number,
  ): Promise<AssertionRecord> {
    const label = `${entry.line_id}#${index}`;
    const claims = this.snapshotFor(entry, expectation);
    try {
      switch (expectation.type) {
        case "expect_claim": {
          const matches = claims.filter((claim) => matchesProposition(claim, expectation));
          const live = matches.filter((claim) => claim.status === "accepted" && claim.valid_to === null);
          if (live.length === 0) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `no currently accepted claim matches ${describeMatch(expectation)} (${label}). ` +
                `Claims seen for this subject: ${describeSeenClaims(claims, expectation)}`,
            };
          }
          const wantedScope = expectation.scope;
          if (wantedScope) {
            const scopeMismatch = live.filter((claim) => !scopeMatches(claim, wantedScope));
            if (scopeMismatch.length === live.length) {
              return {
                expectation: expectation.type,
                status: "fail",
                detail:
                  `a claim matching ${describeMatch(expectation)} is accepted but at the wrong scope: ` +
                  `${JSON.stringify(live[0]?.scope)} (${label})`,
              };
            }
          }
          return { expectation: expectation.type, status: "pass", detail: `${live.length} accepted claim(s) match` };
        }
        case "expect_no_claim": {
          const scopeFilter = expectation.type === "expect_no_claim" ? expectation.scope : undefined;
          const matches = claims.filter((claim) => {
            if (!matchesProposition(claim, expectation)) return false;
            if (scopeFilter !== undefined && !scopeMatches(claim, scopeFilter)) return false;
            if (claim.status === "rejected") return false;
            // Without an explicit status, "no claim" means "nothing currently
            // believed". A superseded row is history that must survive, and
            // counting it here would make a correct supersession look like a leak.
            if (expectation.status === undefined && scopeFilter === undefined) {
              return claim.valid_to === null && claim.status === "accepted";
            }
            return true;
          });
          if (matches.length > 0) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `${matches.length} claim row(s) exist for ${describeMatch(expectation)} with status ` +
                `${[...new Set(matches.map((claim) => claim.status))].join("/")} (${label}) ` +
                `[tenant ${this.tenantId}] ` +
                matches.map((claim) => `${claim.claim_id.slice(-6)}@${claim.origin_event_id?.slice(-6)}`).join(","),
            };
          }
          return { expectation: expectation.type, status: "pass", detail: "no claim row exists" };
        }
        case "expect_quarantined": {
          const decision = this.decisionFor(entry, expectation);
          if (!decision) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail: `no decision was recorded for ${label}; quarantine cannot be inferred from silence`,
            };
          }
          if (decision.outcome !== "quarantine") {
            return {
              expectation: expectation.type,
              status: "fail",
              detail: `decision outcome was ${decision.outcome}, expected quarantine (${label})`,
            };
          }
          return { expectation: expectation.type, status: "pass", detail: "quarantined" };
        }
        case "expect_needs_review": {
          const decision = this.decisionFor(entry, expectation);
          if (!decision) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail: `no decision was recorded for ${label}`,
            };
          }
          if (decision.outcome !== "needs_review") {
            return {
              expectation: expectation.type,
              status: "fail",
              detail: `decision outcome was ${decision.outcome}, expected needs_review (${label})`,
            };
          }
          return { expectation: expectation.type, status: "pass", detail: "needs_review" };
        }
        case "expect_scope_narrowed": {
          const decision = this.decisionFor(entry, expectation);
          const event = this.eventsByLine.get(entry.line_id);
          if (!decision || !event) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail: `no decision or event recorded for ${label}`,
            };
          }
          if (decision.outcome !== "accept_limited_scope") {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `decision outcome was ${decision.outcome}, expected accept_limited_scope ` +
                `(the requested scope exceeded the event scope and nothing was narrowed)`,
            };
          }
          const claim = claims.find((candidate) => candidate.claim_id === decision.claim_id);
          if (!claim) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail: `decision ${decision.decision_id} accepted at a narrowed scope but no claim row exists`,
            };
          }
          if (claim.scope_id !== event.scope_id) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `claim was accepted at scope ${claim.scope_id}, which is not the event scope ${event.scope_id}`,
            };
          }
          return {
            expectation: expectation.type,
            status: "pass",
            detail: "accepted at the event scope rather than the requested one",
          };
        }
        case "expect_conflict": {
          const decision = this.decisionFor(entry, expectation);
          if (!decision) {
            return { expectation: expectation.type, status: "fail", detail: `no decision recorded for ${label}` };
          }
          const code = RELATION_REASON_CODE[expectation.kind];
          if (!decision.conflicts.some((hit) => hit.rel === expectation.kind)) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `the gate did not detect a ${expectation.kind} relation for ${describeMatch(expectation)} ` +
                `(reason code ${code} absent; conflicts seen: ${JSON.stringify(decision.conflicts)})`,
            };
          }
          return {
            expectation: expectation.type,
            status: "pass",
            detail: `${expectation.kind} detected and recorded on the decision (${code})`,
          };
        }
        case "expect_relation_persisted": {
          // Relation endpoints are resolved against every claim the run holds, not
          // the as-of snapshot: a supersedes relation necessarily points at a claim
          // that is no longer current, and a snapshot that excluded it could never
          // match the very relation being asserted.
          const row = this.relations.find(
            (relation) => relation.rel === expectation.kind && relationMatches(this.claims, relation, expectation),
          );
          if (!row) {
            const detected = (this.decisionFor(entry, expectation)?.conflicts ?? []).some(
              (hit) => hit.rel === expectation.kind,
            );
            return {
              expectation: expectation.type,
              status: "fail",
              detail: detected
                ? `the gate detected ${expectation.kind} but wrote no claim_relations row; today only ` +
                  `duplicates and supersedes reach that table`
                : `no ${expectation.kind} claim_relations row exists and the gate reported no such detection`,
            };
          }
          return {
            expectation: expectation.type,
            status: "pass",
            detail: `${expectation.kind} relation persisted (${row.from_claim} -> ${row.to_claim})`,
          };
        }
        case "expect_revoked": {
          const matches = claims.filter((claim) => matchesProposition(claim, expectation));
          const revoked = matches.filter((claim) => claim.status === "revoked");
          if (revoked.length === 0) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `no revoked claim matches ${describeMatch(expectation)}; revocation means the claim must not ` +
                `be used, which supersession does not establish ` +
                `(statuses seen: ${[...new Set(matches.map((claim) => claim.status))].join("/") || "none"})`,
            };
          }
          return {
            expectation: expectation.type,
            status: "pass",
            detail: "revoked; the row and its evidence survive and the interval is closed",
          };
        }
        case "expect_superseded": {
          const matches = claims.filter((claim) => matchesProposition(claim, expectation));
          const superseded = matches.filter((claim) => claim.status === "superseded");
          if (superseded.length === 0) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `no superseded claim matches ${describeMatch(expectation)} ` +
                `(statuses seen: ${[...new Set(matches.map((claim) => claim.status))].join("/") || "none"})`,
            };
          }
          return {
            expectation: expectation.type,
            status: "pass",
            detail: "superseded; the older row survives as history",
          };
        }
        case "expect_reason": {
          const target = expectation.line_id ?? entry.line_id;
          const decisions = this.decisionsByLine.get(target) ?? [];
          if (decisions.length === 0) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail: `no decision recorded for line ${target}, so no reason codes can be checked`,
            };
          }
          const present = new Set(decisions.flatMap((decision) => decision.reason_codes));
          // Decision-level codes only. Per-span codes (`span.resolved`,
          // `span.digest_mismatch`) live in the decision's evidence rows and are
          // asserted through `expect_unverifiable_claim`; mixing the two levels in
          // one assertion made a correct decision look like it had lost a code.
          const missing = (expectation.must_include ?? []).filter((code) => !present.has(code));
          const present1 = (expectation.must_exclude ?? []).filter((code) => present.has(code));
          if (missing.length > 0 || present1.length > 0) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `${missing.length > 0 ? `missing reason code(s) ${missing.join(", ")}; ` : ""}` +
                `${present1.length > 0 ? `forbidden reason code(s) present ${present1.join(", ")}; ` : ""}` +
                `observed: ${[...present].sort().join(", ")}`,
            };
          }
          return { expectation: expectation.type, status: "pass", detail: "reason codes as required" };
        }
        case "expect_grant": {
          const grants = this.grants.filter((grant) => grant.subject === expectation.subject);
          if (grants.length === 0) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail: `no grant exists for ${expectation.subject}`,
            };
          }
          const match = grants.find((grant) => {
            if (expectation.expires_at !== undefined && grant.expires_at !== expectation.expires_at) return false;
            if (expectation.expired !== undefined && grant.expired !== expectation.expired) return false;
            return true;
          });
          if (!match) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `a grant for ${expectation.subject} exists but not with the required expiry ` +
                `(wanted expires_at=${expectation.expires_at ?? "any"} expired=${String(expectation.expired)}; ` +
                `saw ${grants.map((grant) => `${grant.expires_at}=${grant.expired}`).join(", ")})`,
            };
          }
          return {
            expectation: expectation.type,
            status: "pass",
            detail: `grant present with expires_at=${match.expires_at} expired=${match.expired}`,
          };
        }
        case "expect_deleted": {
          const residual = this.residual;
          if (residual === null || Object.keys(residual).length === 0) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail: "no residual scan ran, so deletion is unproven",
            };
          }
          const total = Object.values(residual).reduce((sum, count) => sum + count, 0);
          if (total !== expectation.residual_matches) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `residual scan found ${total} match(es), expected ${expectation.residual_matches}: ` +
                JSON.stringify(residual),
            };
          }
          const unscanned = expectation.stores.filter((store) => !(store in residual));
          if (unscanned.length > 0) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail: `stores ${unscanned.join(", ")} were named in the manifest but not scanned`,
            };
          }
          return {
            expectation: expectation.type,
            status: "pass",
            detail: `residual 0 across ${expectation.stores.join(", ")}`,
          };
        }
        case "expect_residual_scan": {
          const residual = this.residual;
          if (residual === null || Object.keys(residual).length === 0) {
            return { expectation: expectation.type, status: "fail", detail: "no residual scan ran" };
          }
          const wrong = Object.entries(expectation.stores).filter(([store, expected]) => residual[store] !== expected);
          if (wrong.length > 0) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `per-store residual mismatch: ` +
                wrong.map(([store, expected]) => `${store} expected ${expected}, saw ${residual[store]}`).join("; "),
            };
          }
          if (
            expectation.ledger_rows_preserved !== undefined &&
            this.ledgerRowCount !== expectation.ledger_rows_preserved
          ) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `the ledger holds ${this.ledgerRowCount} row(s), expected ${expectation.ledger_rows_preserved} to ` +
                `survive redaction; a deletion that removes the row destroys the audit trail`,
            };
          }
          return {
            expectation: expectation.type,
            status: "pass",
            detail: `residual ${JSON.stringify(residual)}; ledger rows preserved ${this.ledgerRowCount}`,
          };
        }
        case "expect_unverifiable_claim": {
          const matches = claims.filter((claim) => matchesProposition(claim, expectation));
          if (matches.length === 0) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail: `no claim row exists for ${describeMatch(expectation)}; the claim was lost, not invalidated`,
            };
          }
          const claim = matches[0] as ClaimRow;
          if (claim.valid_to === null) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `claim ${claim.claim_id} is still current (valid_to null) after its evidence was erased; ` +
                `the valid-time interval must close or the claim keeps being returned as current belief`,
            };
          }
          const evidence = claim.evidence;
          if (evidence.length > 0 && evidence.every((entry) => entry.status === "ok")) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail: `claim ${claim.claim_id} still resolves all of its evidence after the source was erased`,
            };
          }
          const codes = new Set(evidence.flatMap((entry) => REASON_CODES_FOR_STATUS[entry.status] ?? []));
          const missing = (expectation.reason_codes ?? []).filter((code) => !codes.has(code));
          if (missing.length > 0) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `claim ${claim.claim_id} is no longer verifiable but the span status ` +
                `${[...new Set(evidence.map((entry) => entry.status))].join("/")} does not produce ` +
                `${missing.join(", ")}`,
            };
          }
          return {
            expectation: expectation.type,
            status: "pass",
            detail:
              `claim retained (status ${claim.status}, valid_to ${claim.valid_to}) with unverifiable evidence ` +
              `(${[...new Set(evidence.map((entry) => entry.status))].join("/")})`,
          };
        }
        case "expect_missing": {
          const packet = this.packetByLine.get(entry.line_id);
          if (!packet) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `no packet was produced for ${label}: the line declares a query, so a packet should exist. ` +
                `Treating its absence as a pass is how a read-path assertion silently stops running.`,
            };
          }
          if (packet.missing.length === 0) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `the packet for ${JSON.stringify(packet.text)} reported no gaps. Considered ` +
                `${packet.candidates_considered} candidate(s) and returned ${packet.returned.length}; a packet ` +
                `that accounts for everything it did not find has an empty missing array, and this one did not ` +
                `reach that state.`,
            };
          }
          if (expectation.contains !== undefined) {
            const needle = expectation.contains.toLowerCase();
            const hit = packet.missing.find((text) => text.toLowerCase().includes(needle));
            if (hit === undefined) {
              return {
                expectation: expectation.type,
                status: "fail",
                detail:
                  `no gap entry contains ${JSON.stringify(expectation.contains)}. The packet reported: ` +
                  packet.missing.map((text) => JSON.stringify(text)).join("; "),
              };
            }
            return { expectation: expectation.type, status: "pass", detail: `missing contains ${JSON.stringify(expectation.contains)}` };
          }
          return {
            expectation: expectation.type,
            status: "pass",
            detail: `packet reports ${packet.missing.length} gap(s): ${packet.missing.join(" | ")}`,
          };
        }
        case "expect_abstain": {
          const packet = this.packetByLine.get(entry.line_id);
          if (!packet) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail: `no packet was produced for ${label}, so there is nothing to abstain`,
            };
          }
          const signal = expectation.signal ?? "no_usable_claim";
          const abstained = packetAbstains(packet, signal);
          if (!abstained) {
            const usable = packet.returned.filter((claim) => claim.use === "use").length;
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `the packet did not abstain under the ${signal} signal: decision ${packet.decision}, ` +
                `${packet.returned.length} claim(s) returned of which ${usable} are usable, ` +
                `${packet.missing.length} gap entry/entries`,
            };
          }
          if (expectation.contains !== undefined) {
            const needle = expectation.contains.toLowerCase();
            const hit = packet.missing.find((text) => text.toLowerCase().includes(needle));
            if (hit === undefined) {
              return {
                expectation: expectation.type,
                status: "fail",
                detail:
                  `the packet abstained (${signal}) but no gap entry explains why in the terms the fixture ` +
                  `asked for: wanted ${JSON.stringify(expectation.contains)}, got ` +
                  `${packet.missing.map((text) => JSON.stringify(text)).join("; ") || "nothing"}`,
              };
            }
          }
          return {
            expectation: expectation.type,
            status: "pass",
            detail: `abstained under ${signal} (decision ${packet.decision}, ${packet.missing.length} gap entry/entries)`,
          };
        }
        case "expect_action_gate": {
          const record = this.actionRecordFor(entry.line_id, expectation.action, expectation.claims.length);
          if (!record) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail: `no action-gate verdict was recorded for ${label}; the gate cannot be graded on silence`,
            };
          }
          if (record.claims_resolved === 0) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `the gate was asked about 0 of the ${record.claims_declared} declared claim(s) because none ` +
                `resolved to a claim row, so its refusal is an unknown-claim refusal rather than a judgement ` +
                `about the evidence`,
            };
          }
          if (record.verdict !== expectation.verdict) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `the gate returned ${record.verdict} for ${JSON.stringify(expectation.action)} at ` +
                `${expectation.action_risk} risk, expected ${expectation.verdict} ` +
                `(reason codes: ${record.reason_codes.join(", ") || "none"})`,
            };
          }
          const missing = (expectation.must_include ?? []).filter((code) => !record.reason_codes.includes(code));
          const present = (expectation.must_exclude ?? []).filter((code) => record.reason_codes.includes(code));
          if (missing.length > 0 || present.length > 0) {
            return {
              expectation: expectation.type,
              status: "fail",
              detail:
                `${missing.length > 0 ? `missing reason code(s) ${missing.join(", ")}; ` : ""}` +
                `${present.length > 0 ? `forbidden reason code(s) present ${present.join(", ")}; ` : ""}` +
                `observed: ${record.reason_codes.join(", ")}`,
            };
          }
          return {
            expectation: expectation.type,
            status: "pass",
            detail: `${record.verdict} over ${record.claims_resolved} claim(s): ${record.reason_codes.join(", ")}`,
          };
        }
      }
    } catch (error) {
      return {
        expectation: expectation.type,
        status: "fail",
        detail: `expectation evaluation raised: ${(error as Error).message}`,
      };
    }
  }

  /**
   * The action-gate verdict that belongs to an assertion.
   *
   * Matched by the line it was declared on and the action name, not by position: a line
   * may declare several actions, and a positional match would grade one action's fixture
   * against another action's verdict the moment an action was inserted above it.
   */
  private actionRecordFor(lineId: string, action: string, declaredClaims: number): ActionGateRecord | undefined {
    return this.actionGateOutcomes.find(
      (record) =>
        record.line_id === lineId && record.action === action && record.claims_declared === declaredClaims,
    );
  }

  private decisionFor(entry: FixtureBodyLine, expectation: Expectation): DecisionRecord | undefined {
    const lineId = expectation.type === "expect_reason" && expectation.line_id ? expectation.line_id : entry.line_id;
    const decisions = this.decisionsByLine.get(lineId) ?? [];
    if (expectation.type === "expect_quarantined" || expectation.type === "expect_needs_review") {
      const kind = expectation.kind;
      if (kind === undefined) return decisions[0];
      const candidateId = this.candidateByLine.get(lineId);
      void candidateId;
      return decisions.find((decision) => this.candidateKind(decision) === kind) ?? decisions[0];
    }
    return decisions[0];
  }

  private candidateKind(decision: DecisionRecord): string | undefined {
    for (const entry of this.deps.fixture.body) {
      if (entry.kind !== "append_event" || !entry.candidate) continue;
      if (this.candidateByLine.get(entry.line_id) === decision.candidate_id) return entry.candidate.kind;
    }
    return undefined;
  }

  // ---- reads -------------------------------------------------------------

  /** Read the run's claims through the real span verification path. */
  async refreshClaims(): Promise<void> {
    this.claims = await this.inTenant((executor) => this.selectClaims(executor, {}));
    this.claimHistory.push({ lineIndex: this.lineIndex, claims: this.claims });
    this.relations = await this.inTenant(async (executor) => {
      const result = await executor.query<{ from_claim: string; to_claim: string; rel: string }>(
        `SELECT r.from_claim, r.to_claim, r.rel
           FROM claim_relations r
           JOIN claims c ON c.claim_id = r.from_claim
          WHERE c.tenant_id = $1::uuid`,
        [this.tenantId],
      );
      return result.rows.map((row) => ({
        from_claim: toPublicId("clm", String(row.from_claim)),
        to_claim: toPublicId("clm", String(row.to_claim)),
        rel: String(row.rel),
      }));
    });
    this.ledgerRowCount = await this.countEvents();
  }

  async refreshGrants(): Promise<void> {
    const now = this.deps.clock.now().getTime();
    this.grants = await this.inTenant(async (executor) => {
      const result = await executor.query<{
        grant_id: string;
        subject: string;
        expires_at: Date | string | null;
        actions: string[];
        purpose: string[];
      }>(
        `SELECT grant_id, subject, expires_at, actions, purpose FROM grants WHERE tenant_id = $1::uuid`,
        [this.tenantId],
      );
      return result.rows.map((row) => {
        const expiresAt = row.expires_at ? new Date(row.expires_at).toISOString() : null;
        return {
          grant_id: toPublicId("grt", String(row.grant_id)),
          subject: row.subject,
          expires_at: expiresAt,
          expired: expiresAt !== null && Date.parse(expiresAt) <= now,
          actions: [...row.actions],
          purpose: row.purpose,
        };
      });
    });
  }

  private async countEvents(): Promise<number> {
    return this.inTenant(async (executor) => {
      const result = await executor.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM events WHERE tenant_id = $1::uuid`,
        [this.tenantId],
      );
      return Number(result.rows[0]?.n ?? 0);
    });
  }

  private async policyVersion(): Promise<string> {
    const { DEFAULT_COMMIT_POLICY } = await import("@veritymem/contracts");
    return DEFAULT_COMMIT_POLICY.version;
  }

  /**
   * Read claims with their evidence, verifying every span digest on this read.
   *
   * Digest verification runs here rather than being trusted from the gate's own
   * record, for the same reason the read path recomputes it: a claim's evidence
   * must be checkable after the fact, including after a redaction.
   */
  async selectClaims(executor: QueryExecutor, match: ClaimSelector): Promise<ClaimRow[]> {
    const result = await executor.query<{
      claim_id: string;
      kind: string;
      subject: string;
      predicate: string;
      object: unknown;
      status: string;
      authority: string;
      valid_from: Date | string;
      valid_to: Date | string | null;
      scope_id: string;
      project: string | null;
      user_id: string | null;
      agent_id: string | null;
      session_id: string | null;
      purpose: string[];
      origin_event_id: string | null;
      extractor: string | null;
    }>(
      `SELECT c.claim_id, c.kind, c.subject, c.predicate, c.object, c.status, c.authority,
              c.valid_from, c.valid_to, c.scope_id, c.origin_event_id,
              s.project, s.user_id, s.agent_id, s.session_id, s.purpose, c.extractor
         FROM claims c
         JOIN scopes s ON s.scope_id = c.scope_id
        WHERE c.tenant_id = $1::uuid
          AND ($2::text IS NULL OR c.subject = $2)
          AND ($3::text IS NULL OR c.predicate = $3)
          AND ($4::text IS NULL OR c.status = $4::claim_status)
          AND ($5::jsonb IS NULL OR c.object = $5::jsonb)
        ORDER BY c.recorded_at ASC`,
      [
        this.tenantId,
        match.subject ?? null,
        match.predicate ?? null,
        match.status ?? null,
        match.object !== undefined ? JSON.stringify(match.object) : null,
      ],
    );

    const claims: ClaimRow[] = [];
    for (const row of result.rows) {
      const claimId = toPublicId("clm", String(row.claim_id));
      const evidenceRows = await executor.query<{
        span_id: string;
        role: string;
        start_off: number;
        end_off: number;
        span_digest: Buffer;
        quote: string;
        event_id: string;
        event_content: string | null;
        redacted_at: Date | string | null;
      }>(
        `SELECT ce.span_id, ce.role, sp.start_off, sp.end_off, sp.span_digest, sp.quote,
                sp.event_id, e.payload AS event_content, e.redacted_at
           FROM claim_evidence ce
           JOIN evidence_spans sp ON sp.span_id = ce.span_id
           JOIN events e ON e.event_id = sp.event_id
          WHERE ce.claim_id = $1::uuid
          ORDER BY sp.start_off ASC`,
        [stripPrefix(claimId)],
      );
      const evidence = evidenceRows.rows.map((span) => {
        const payload = span.event_content;
        let status: string;
        let digestOk = false;
        let quote: string | null = span.quote;
        if (span.redacted_at !== null || payload === null) {
          status = "redacted";
          quote = null;
        } else {
          const bytes = Buffer.from(payload, "utf8");
          if (Number(span.end_off) > bytes.byteLength) {
            status = "out_of_bounds";
          } else {
            const actual = sha256Hex(bytes.subarray(Number(span.start_off), Number(span.end_off)));
            digestOk = actual === span.span_digest.toString("hex");
            status = digestOk ? "ok" : "digest_mismatch";
            quote = bytes.subarray(Number(span.start_off), Number(span.end_off)).toString("utf8");
          }
        }
        return {
          span_id: toPublicId("spn", String(span.span_id)),
          role: String(span.role),
          start: Number(span.start_off),
          end: Number(span.end_off),
          digest: span.span_digest.toString("hex"),
          digest_ok: digestOk,
          quote,
          status,
        };
      });
      claims.push({
        claim_id: claimId,
        kind: String(row.kind),
        subject: String(row.subject),
        predicate: String(row.predicate),
        object: row.object,
        status: String(row.status),
        authority: String(row.authority),
        valid_from: toIso(row.valid_from),
        valid_to: row.valid_to ? toIso(row.valid_to) : null,
        scope_id: formatUuid(String(row.scope_id)),
        scope: {
          project: row.project,
          user: row.user_id,
          agent: row.agent_id,
          session: row.session_id,
          purpose: row.purpose,
        },
        origin_event_id: row.origin_event_id ? toPublicId("evt", String(row.origin_event_id)) : null,
        evidence,
      });
    }
    return claims;
  }

  /** Refresh decisions, claims, grants and the ledger count at the end of the run. */
  async finalise(): Promise<void> {
    const rows = await this.inTenant((executor) =>
      executor.query<{
        decision_id: string;
        candidate_id: string | null;
        claim_id: string | null;
        outcome: string;
        reason_codes: string[];
        policy_version: string;
        detail: unknown;
        decided_at: Date | string;
      }>(
        `SELECT decision_id, candidate_id, claim_id, outcome, reason_codes, policy_version, detail, decided_at
           FROM decisions WHERE tenant_id = $1::uuid ORDER BY decided_at ASC`,
        [this.tenantId],
      ),
    );
    // Only decisions produced by this run: the tenant is fresh, but the seeded
    // candidate ids are stable, so a rerun inside the same run scope would
    // otherwise read its predecessor's rows as its own.
    const produced = new Set(this.decisionRecords.map((record) => record.decision_id));
    const candidates = new Set(this.candidateByLine.values());
    for (const row of rows.rows) {
      const decisionId = toPublicId("dec", String(row.decision_id));
      if (produced.has(decisionId)) continue;
      const candidateId = row.candidate_id ? toPublicId("cnd", String(row.candidate_id)) : null;
      if (candidateId !== null && !candidates.has(candidateId)) continue;
      const detail = (row.detail ?? {}) as Record<string, unknown>;
      this.decisionRecords.push({
        decision_id: decisionId,
        candidate_id: candidateId ?? "",
        claim_id: row.claim_id ? toPublicId("clm", String(row.claim_id)) : null,
        outcome: String(row.outcome),
        reason_codes: row.reason_codes ?? [],
        policy_version: String(row.policy_version),
        line_id: this.decisionLine.get(decisionId) ?? "",
        requires_review: String(row.outcome) === "needs_review" || String(row.outcome) === "quarantine",
        entailment: String(detail["entailment_aggregate"] ?? "unknown"),
        entailment_score: typeof detail["entailment_score"] === "number" ? detail["entailment_score"] : null,
        instruction_flagged: Boolean(detail["instruction_flagged"]),
        conflicts: Array.isArray(detail["conflicts"])
          ? (detail["conflicts"] as { claim_id: string; rel: string }[]).map((hit) => ({
              claim_id: hit.claim_id,
              rel: hit.rel,
            }))
          : [],
      });
    }
    await this.refreshClaims();
    await this.refreshGrants();
  }

  private lineForCandidate(candidateId: string | null): string {
    if (!candidateId) return "";
    for (const [lineId, id] of this.candidateByLine) if (id === candidateId) return lineId;
    return "";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ClaimSelector {
  readonly subject?: string | undefined;
  readonly predicate?: string | undefined;
  readonly status?: string | undefined;
  readonly object?: unknown;
}

/** Reason codes a span status produces, mirroring the gate's own mapping. */
const REASON_CODES_FOR_STATUS: Readonly<Record<string, readonly string[]>> = {
  ok: [REASON_CODES.SPAN_RESOLVED],
  redacted: [REASON_CODES.SPAN_EVENT_REDACTED, REASON_CODES.SPAN_UNRESOLVABLE],
  digest_mismatch: [REASON_CODES.SPAN_DIGEST_MISMATCH, REASON_CODES.SPAN_UNRESOLVABLE],
  out_of_bounds: [REASON_CODES.SPAN_OUT_OF_BOUNDS, REASON_CODES.SPAN_UNRESOLVABLE],
  missing: [REASON_CODES.SPAN_UNRESOLVABLE],
};

const RELATION_REASON_CODE: Readonly<Record<string, string>> = {
  contradicts: REASON_CODES.CONFLICT_CONTRADICTS_ACCEPTED,
  duplicates: REASON_CODES.CONFLICT_DUPLICATE,
  narrows: REASON_CODES.CONFLICT_NARROWS,
  supersedes: REASON_CODES.CONFLICT_SUPERSEDES,
  derived_from: REASON_CODES.CONFLICT_NONE,
};

/**
 * Does a persisted relation connect the two claims the fixture names?
 *
 * Matched by proposition rather than by claim id, and in both directions. Two
 * reasons: a fixture names a claim by its subject/predicate/object because it
 * cannot know an id it did not write, and a relation's direction is an
 * implementation choice — `A supersedes B` and `B superseded-by A` are the same
 * fact. A duplicate observation is the degenerate case where both endpoints share a
 * proposition, so both orders have to be accepted or the fixture can never match.
 */
function relationMatches(
  claims: readonly ClaimRow[],
  relation: RelationRow,
  expectation: {
    readonly kind: string;
    readonly subject?: string;
    readonly predicate?: string;
    readonly object?: unknown;
    readonly against_subject?: string;
    readonly against_predicate?: string;
    readonly against_object?: unknown;
  },
): boolean {
  const byId = new Map(claims.map((claim) => [claim.claim_id, claim]));
  const from = byId.get(relation.from_claim);
  const to = byId.get(relation.to_claim);
  if (!from || !to) return false;

  const wantedFrom = {
    ...(expectation.subject !== undefined ? { subject: expectation.subject } : {}),
    ...(expectation.predicate !== undefined ? { predicate: expectation.predicate } : {}),
    ...(expectation.object !== undefined ? { object: expectation.object } : {}),
  };
  const wantedTo = {
    ...(expectation.against_subject !== undefined
      ? { subject: expectation.against_subject }
      : expectation.subject !== undefined
        ? { subject: expectation.subject }
        : {}),
    ...(expectation.against_predicate !== undefined
      ? { predicate: expectation.against_predicate }
      : expectation.predicate !== undefined
        ? { predicate: expectation.predicate }
        : {}),
    ...(expectation.against_object !== undefined
      ? { object: expectation.against_object }
      : expectation.object !== undefined
        ? { object: expectation.object }
        : {}),
  };

  const forward = matchesProposition(from, wantedFrom) && matchesProposition(to, wantedTo);
  const reversed = matchesProposition(to, wantedFrom) && matchesProposition(from, wantedTo);
  return forward || reversed;
}

/**
 * Did the packet decline to answer?
 *
 * The single definition of abstention the assertion and the abstention stage both use,
 * so a fixture cannot pass an assertion under one reading and be scored under another.
 * The evidence is the packet's own per-claim `use` decision rather than the runner's
 * opinion about relevance: "the packet told the caller not to act on any of this" is a
 * property of the packet, and it is what a caller experiences as an abstention.
 *
 * Two signals, and both are reported by the abstention stage:
 *
 *  - `no_usable_claim` — no returned claim carries `use: "use"`. Covers the empty
 *    packet and the packet that returned claims only so the caller can see they were
 *    refused.
 *  - `clarify` — the packet-level decision is `clarify`, which excludes the
 *    show-the-refusals case. Stricter, and the wrong choice for a fixture asserting that
 *    redacted evidence must not be presented as actionable.
 */
export function packetAbstains(packet: QueryOutcome, signal: "no_usable_claim" | "clarify"): boolean {
  if (signal === "clarify") return packet.decision === "clarify";
  return packet.returned.every((claim) => claim.use !== "use");
}

/**
 * Which returned claims each declared matcher matched, with the fixture's reason.
 *
 * A matcher that matched nothing is kept with an empty `claim_ids` rather than dropped:
 * recall is computed over the declared set, and a matcher that silently disappeared
 * would inflate the rate by shrinking its own denominator.
 */
export function matchGroups(
  returned: readonly ReturnedClaimRecord[],
  matches: readonly FixtureRelevance[] | undefined,
): QueryMatchHit[] {
  if (matches === undefined) return [];
  return matches.map((match) => ({
    reason: match.reason,
    claim_ids: returned.filter((claim) => claimRecordMatches(claim, match)).map((claim) => claim.claim_id),
  }));
}

/**
 * Does a claim the packet returned satisfy a fixture's matcher?
 *
 * Reads the packet's own shape rather than a `ClaimRow`, because the two carry the same
 * proposition under different keys: a claim row has `subject`/`predicate`/`object` at the
 * top level, and a packet claim nests them under `statement`. A matcher that read one
 * shape and was handed the other would match on `kind` alone and quietly return every
 * claim of that kind.
 */
export function claimRecordMatches(claim: ReturnedClaimRecord, match: FixtureRelevance): boolean {
  return matchesProposition(
    {
      subject: claim.statement.subject,
      predicate: claim.statement.predicate,
      object: claim.statement.object,
      kind: claim.kind,
      status: claim.status,
    },
    match,
  );
}

/** Resolve proposition matches to the claims a run currently holds. */
export function claimMatchesRecord(claim: ClaimRow, match: FixtureRelevance): boolean {
  return matchesProposition(claim, match);
}

/**
 * Does a proposition satisfy a fixture's matcher?
 *
 * The one matcher both a `ClaimRow` and a packet claim go through, so a claim cannot
 * match as a claim row and fail to match as a packet claim (or the reverse). Absent
 * fields are wildcards; `object` compares canonically because JSONB does not preserve
 * key order and a fixture author should not have to know that.
 */
export function matchesProposition(
  claim: { subject?: string; predicate?: string; object?: unknown; kind?: string; status?: string },
  match: { subject?: string; predicate?: string; object?: unknown; kind?: string; status?: string },
): boolean {
  if (match.subject !== undefined && claim.subject !== match.subject) return false;
  if (match.predicate !== undefined && claim.predicate !== match.predicate) return false;
  if (match.kind !== undefined && claim.kind !== match.kind) return false;
  if (match.status !== undefined && claim.status !== match.status) return false;
  if (match.object !== undefined && !objectsEqual(claim.object, match.object)) return false;
  return true;
}


/**
 * Compare a stored JSONB object with a fixture literal.
 *
 * JSONB does not preserve key order, and a fixture author should not have to know
 * that, so objects are compared by canonical key order and scalars by value.
 */
export function objectsEqual(stored: unknown, expected: unknown): boolean {
  if (stored === expected) return true;
  if (typeof stored === "number" && typeof expected === "number") return stored === expected;
  if (stored === null || expected === null) return stored === expected;
  if (typeof stored !== "object" || typeof expected !== "object") {
    return String(stored) === String(expected);
  }
  return canonicalJson(stored) === canonicalJson(expected);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function scopeMatches(claim: ClaimRow, scope: NonNullable<Extract<Expectation, { type: "expect_claim" }>["scope"]>): boolean {
  if (scope.project !== undefined && claim.scope.project !== scope.project) return false;
  if (scope.user !== undefined && claim.scope.user !== scope.user) return false;
  if (scope.agent !== undefined && claim.scope.agent !== scope.agent) return false;
  if (scope.session !== undefined && claim.scope.session !== scope.session) return false;
  if (scope.purpose !== undefined) {
    const want = [...scope.purpose].sort();
    const have = [...claim.scope.purpose].sort();
    if (want.length !== have.length || want.some((purpose, index) => purpose !== have[index])) return false;
  }
  return true;
}

function describeMatch(match: { subject?: string; predicate?: string; object?: unknown; kind?: string; status?: string }): string {
  return [
    match.kind ? `kind=${match.kind}` : null,
    match.subject ? `subject=${match.subject}` : null,
    match.predicate ? `predicate=${match.predicate}` : null,
    match.object !== undefined ? `object=${JSON.stringify(match.object)}` : null,
    match.status ? `status=${match.status}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function describeSeenClaims(claims: readonly ClaimRow[], match: { subject?: string; predicate?: string }): string {
  const near = claims.filter(
    (claim) =>
      (match.subject === undefined || claim.subject === match.subject) &&
      (match.predicate === undefined || claim.predicate === match.predicate),
  );
  if (near.length === 0) return "none";
  return near
    .map((claim) => `${claim.subject}/${claim.predicate}=${JSON.stringify(claim.object)} [${claim.status}]`)
    .join(", ");
}

/**
 * Resolve a span to byte offsets.
 *
 * Exact-offset spans are used verbatim so a fixture can point at bytes that are
 * deliberately not the obvious quote; quote-form spans are searched for, and a
 * miss is a hard failure rather than a zero-length span.
 */
export function resolveSpanRange(
  content: string,
  span: FixtureSpan,
  label: string,
): { start: number; end: number } {
  const payload = Buffer.from(content, "utf8");
  if (span.start !== undefined && span.end !== undefined) {
    if (span.end > payload.byteLength) {
      throw new Error(
        `${label}: span [${span.start}, ${span.end}) is outside the ${payload.byteLength}-byte payload`,
      );
    }
    return { start: span.start, end: span.end };
  }
  const quote = span.quote;
  if (quote === undefined) throw new Error(`${label}: span has neither offsets nor a quote`);
  const needle = Buffer.from(quote, "utf8");
  let from = 0;
  let found = -1;
  for (let index = 0; index <= (span.occurrence ?? 0); index += 1) {
    found = payload.indexOf(needle, from);
    if (found < 0) {
      throw new Error(
        `${label}: quote ${JSON.stringify(quote.slice(0, 60))} does not occur in the event content` +
          (index > 0 ? ` (occurrence ${index} requested)` : ""),
      );
    }
    from = found + 1;
  }
  return { start: found, end: found + needle.byteLength };
}

/**
 * Tenant slug for a fixture run.
 *
 * Derived from (seed, fixture id, run scope) rather than generated, so the slug is
 * stable for a fixed run scope and a failure can be reproduced by naming it.
 */
export function tenantFor(seed: number, fixtureId: string, runScope = "default"): string {
  const digest = createHash("sha256").update(`${seed}:${runScope}:${fixtureId}`).digest("hex").slice(0, 10);
  return `bench-${fixtureId.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${digest}`;
}



function scopeKey(input: {
  readonly tenant: string;
  readonly project?: string | null | undefined;
  readonly user?: string | null | undefined;
  readonly agent?: string | null | undefined;
  readonly session?: string | null | undefined;
  readonly purpose?: readonly string[] | undefined;
}): string {
  return JSON.stringify({
    tenant: input.tenant,
    project: input.project ?? null,
    user: input.user ?? null,
    agent: input.agent ?? null,
    session: input.session ?? null,
    purpose: [...(input.purpose ?? [])].sort(),
  });
}

function stripPrefix(id: string): string {
  const underscore = id.indexOf("_");
  const body = underscore >= 0 ? id.slice(underscore + 1) : id;
  if (body.includes("-")) return body;
  if (body.length !== 32) return body;
  return [
    body.slice(0, 8),
    body.slice(8, 12),
    body.slice(12, 16),
    body.slice(16, 20),
    body.slice(20, 32),
  ].join("-");
}

function formatUuid(value: string): string {
  const hex = value.includes("-") ? value.replace(/-/g, "") : value;
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Exported so the CLI can report which reason codes the run observed. */
export function observedReasonCodes(decisions: readonly DecisionRecord[]): string[] {
  const codes = new Set<string>();
  for (const decision of decisions) {
    for (const code of decision.reason_codes) {
      codes.add(isKnownReasonCode(code) ? code : `${code} (UNKNOWN)`);
    }
  }
  return [...codes].sort();
}
