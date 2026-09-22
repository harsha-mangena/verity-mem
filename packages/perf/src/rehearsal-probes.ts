/**
 * The application operations the rehearsal keeps running while migrations are applied.
 *
 * ## What makes these probes evidence rather than load
 *
 * Every operation goes through the code path a real request uses, as the role a real request
 * uses, inside a transaction bound to a real request context:
 *
 *   | operation          | path                                                       |
 *   |--------------------|------------------------------------------------------------|
 *   | `lexical_retrieval`| `lexicalChannel` — the production lexical channel           |
 *   | `entity_retrieval` | `entityChannel` — the production entity channel             |
 *   | `claim_hydration`  | `readClaims` — the hydration read the packet builder uses   |
 *   | `append_event`     | `Ledger.append` — the write boundary, chain and outbox      |
 *   | `project_claim`    | ingest pipeline + `projectClaim` — claim and projection     |
 *
 * None of them restates a query. The retrieval probes are why a lock taken by 0014 or 0015
 * shows up as an application-visible outage instead of as a number in `pg_locks` that
 * nobody can connect to a user.
 *
 * ## Two things the probes deliberately do not do
 *
 * **They never time a migration statement.** The migration runs on its own connection and
 * its timings are recorded in the migration's own telemetry. Mixing a DDL duration into an
 * application percentile would make the outage look like latency and the latency look like
 * an outage; the report asserts that every workload sample is tagged `probe`.
 *
 * **They do not swallow errors.** A probe that fails records the SQLSTATE, the message and
 * whether the failure was a timeout, and the operation's `attempts` still count it. A
 * workload that counted only successes would report a perfect p99 through a total outage.
 */
import type { Db, Ledger, QueryExecutor } from "@veritymem/ledger";
import { readClaims } from "@veritymem/claims";
import {
  entityChannel,
  lexicalChannel,
  projectClaim,
  type ChannelQuery,
  type ProjectionDependencies,
} from "@veritymem/retrieval";
import type { IngestPipeline } from "@veritymem/model-adapters";
import {
  PROBE_OPERATIONS,
  type AttemptSample,
  type ProbeOperation,
  type WorkloadPhase,
  type WorkloadRecorder,
} from "./rehearsal-metrics.ts";

/**
 * A request binding, restated structurally.
 *
 * `RequestBinding` is not exported from `@veritymem/ledger`, and it does not need to be:
 * this is the same shape, and a rename in the package would surface as a type error here
 * rather than as a silently unbound context.
 */
export interface ProbeBinding {
  readonly tenant: string;
  readonly principal: string;
  readonly scopeIds: readonly string[];
  readonly purposes: readonly string[];
  readonly action: string;
}

/** One scope the workload may act within, with the dimensions RLS containment reads. */
export interface ProbeScope {
  readonly scope_id: string;
  readonly project: string | null;
  readonly user_id: string | null;
  readonly agent_id: string | null;
  readonly session_id: string | null;
}

export interface ProbeTenant {
  readonly tenantSlug: string;
  readonly tenantId: string;
  readonly principal: string;
  readonly scopes: readonly ProbeScope[];
  readonly purposes: readonly string[];
  /** A query the lexical channel returns rows for; verified before the run starts. */
  readonly queryText: string;
  /** Entity terms the entity channel resolves through `entity_aliases`. */
  readonly entityTerms: readonly string[];
  /** Claim ids to hydrate, in the public `clm_<hex>` form. */
  readonly claimIds: readonly string[];
}

export interface ProbeDependencies {
  readonly db: Db;
  readonly ledger: Ledger;
  readonly pipeline: IngestPipeline;
  readonly projections: ProjectionDependencies;
}

export interface ProbeOptions {
  /** Client-side bound for a single probe call, so a hung operation is still recorded. */
  readonly probe_timeout_ms: number;
}

/** A failure the probes classify rather than rethrow. */
export interface ProbeFailure {
  readonly code: string;
  readonly message: string;
  readonly timed_out: boolean;
}

/** PostgreSQL's statement-timeout and lock-timeout SQLSTATEs. */
const TIMEOUT_CODES = new Set(["57014", "55P03"]);
/** The client-side bound, reported with a code that is not a SQLSTATE so it is visible. */
export const PROBE_TIMEOUT_CODE = "probe_timeout";

function isTimeout(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && TIMEOUT_CODES.has(code);
}

/** The SQLSTATE, or a recognisable stand-in when the failure was not from the server. */
export function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.length > 0) return code;
  if (error instanceof Error && error.name === "AbortError") return PROBE_TIMEOUT_CODE;
  return "client_error";
}

/**
 * Run one probe call and turn it into a sample.
 *
 * The clock starts before the call and stops when it settles, successfully or not, so a
 * failure's duration is the time the application actually waited — which is the number an
 * availability report is about. A client-side bound is applied on top of the server's
 * `statement_timeout` so that an operation the server never gets to cancel (a connection
 * that never answers) still produces a sample instead of hanging the probe loop.
 */
export async function runProbe(
  recorder: WorkloadRecorder,
  input: {
    readonly operation: ProbeOperation;
    readonly phase: () => WorkloadPhase;
    readonly options: ProbeOptions;
    readonly call: () => Promise<number | null>;
  },
): Promise<void> {
  const started = Date.now();
  const phase = input.phase();
  try {
    const resultCount = await withClientTimeout(input.call(), input.options.probe_timeout_ms);
    recorder.record({
      operation: input.operation,
      phase,
      started_at_ms: started,
      finished_at_ms: Date.now(),
      duration_ms: Date.now() - started,
      ok: true,
      error_code: null,
      error_message: null,
      timed_out: false,
      result_count: resultCount,
      source: "probe",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const clientTimedOut = message === PROBE_TIMEOUT_CODE;
    recorder.record({
      operation: input.operation,
      phase,
      started_at_ms: started,
      finished_at_ms: Date.now(),
      duration_ms: Date.now() - started,
      ok: false,
      error_code: clientTimedOut ? PROBE_TIMEOUT_CODE : errorCodeOf(error),
      error_message: message,
      timed_out: clientTimedOut || isTimeout(error),
      result_count: null,
      source: "probe",
    });
  }
}

/** Race a promise against a client-side bound that rejects with the probe's own code. */
async function withClientTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(PROBE_TIMEOUT_CODE)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------

/** The `ChannelQuery` the production planner would build for this caller and text. */
export function channelQueryFor(
  tenant: ProbeTenant,
  text: string,
  limit: number,
  now: string,
): ChannelQuery {
  return {
    tenant_id: tenant.tenantId,
    text,
    authorized_scopes: tenant.scopes.map((scope) => ({
      scope_id: scope.scope_id,
      project: scope.project,
      user_id: scope.user_id,
      agent_id: scope.agent_id,
      session_id: scope.session_id,
    })),
    purposes: [...tenant.purposes],
    time: { mode: "current" },
    kinds: null,
    subjects: null,
    entity_terms: tenant.entityTerms.map((term) => term.toLowerCase()),
    limit,
    now,
  };
}

function bindingFor(tenant: ProbeTenant, action: string): ProbeBinding {
  const scope = tenant.scopes[0];
  if (scope === undefined) {
    throw new Error(`tenant ${tenant.tenantSlug} has no scope to probe with`);
  }
  return {
    tenant: tenant.tenantId,
    principal: tenant.principal,
    scopeIds: [scope.scope_id],
    purposes: [...tenant.purposes],
    action,
  };
}

/** Lexical retrieval, through the production channel, inside a bound request transaction. */
export async function probeLexical(
  dependencies: ProbeDependencies,
  tenant: ProbeTenant,
  options: { readonly limit: number; readonly now: string },
): Promise<number> {
  return dependencies.db.withRequest(
    bindingFor(tenant, "probe:lexical"),
    async (executor) => {
      const result = await lexicalChannel(
        executor,
        channelQueryFor(tenant, tenant.queryText, options.limit, options.now),
      );
      if (!result.ran) {
        throw new Error(`the lexical channel did not run: ${result.note ?? "no note"}`);
      }
      return result.hits.length;
    },
    { readOnly: true },
  );
}

/** Entity retrieval, through the production channel. */
export async function probeEntity(
  dependencies: ProbeDependencies,
  tenant: ProbeTenant,
  options: { readonly limit: number; readonly now: string },
): Promise<number> {
  return dependencies.db.withRequest(
    bindingFor(tenant, "probe:entity"),
    async (executor) => {
      const result = await entityChannel(
        executor,
        channelQueryFor(tenant, tenant.queryText, options.limit, options.now),
      );
      if (!result.ran) {
        throw new Error(`the entity channel did not run: ${result.note ?? "no note"}`);
      }
      return result.hits.length;
    },
    { readOnly: true },
  );
}

/** Claim hydration: the batched read the packet builder performs for its candidates. */
export async function probeHydration(
  dependencies: ProbeDependencies,
  tenant: ProbeTenant,
  options: { readonly batch: number },
): Promise<number> {
  if (tenant.claimIds.length === 0) {
    throw new Error(`tenant ${tenant.tenantSlug} has no claim ids to hydrate`);
  }
  return dependencies.db.withRequest(
    bindingFor(tenant, "probe:hydrate"),
    async (executor) => {
      const ids = tenant.claimIds.slice(0, Math.max(1, options.batch));
      const claims = await readClaims(executor, ids);
      return claims.size;
    },
    { readOnly: true },
  );
}

/**
 * Append one event through the ledger's write boundary.
 *
 * Returns `null`: an append has no row count, and reporting one would invent a number.
 */
export async function probeAppend(
  dependencies: ProbeDependencies,
  tenant: ProbeTenant,
  options: {
    readonly stream: string;
    readonly content: string;
    readonly occurred_at: string;
    /** Overrides the acting identity, which also determines the claim's subject. */
    readonly actor?: string;
  },
): Promise<{ readonly event_id: string; readonly scope_id: string; readonly rows: null }> {
  const receipt = await dependencies.ledger.append({
    stream_id: options.stream,
    origin: "user",
    actor_id: options.actor ?? `user:${tenant.principal}`,
    scope: {
      tenant: tenant.tenantSlug,
      ...(tenant.scopes[0]?.project != null ? { project: tenant.scopes[0].project } : {}),
      ...(tenant.scopes[0]?.user_id != null ? { user: tenant.scopes[0].user_id } : {}),
      purpose: [...tenant.purposes],
    },
    occurred_at: options.occurred_at,
    content: options.content,
  });
  return { event_id: receipt.event_id, scope_id: receipt.scope.scope_id, rows: null };
}

/**
 * Ingest a newly appended event into a claim and project it.
 *
 * This is the composite the worker performs: `pipeline.ingest` runs the commit gate (which
 * inserts the claim with the status the gate decided) and `projectClaim` writes the dense
 * and entity projections. Both run inside one request transaction bound to the event's own
 * scope, exactly as `apps/worker` binds them, so 0015's `ALTER TABLE ... ADD CONSTRAINT`
 * blocks this operation if it is going to block the real worker.
 */
export async function probeProject(
  dependencies: ProbeDependencies,
  tenant: ProbeTenant,
  event: { readonly event_id: string; readonly scope_id: string },
): Promise<number> {
  return dependencies.db.withRequest(
    {
      tenant: tenant.tenantId,
      principal: tenant.principal,
      scopeIds: [event.scope_id],
      purposes: [...tenant.purposes],
      action: "probe:project",
    },
    async (executor: QueryExecutor) => {
      const record = await dependencies.ledger.readEvent(executor, event.event_id);
      if (record === null) {
        throw new Error(`the appended event ${event.event_id} is not readable in its own scope`);
      }
      const result = await dependencies.pipeline.ingest(executor, record);
      if (result.decisions.length === 0) {
        // The probe's content is a fixed sentence the deterministic extractor is expected to
        // recognise. Zero decisions means it no longer is, and a probe that "succeeded" by
        // doing nothing is the failure mode this guard exists to make visible.
        throw Object.assign(
          new Error(
            `the ingest pipeline produced no decision for the appended event ${event.event_id}, ` +
              `so the write path was exercised but the claim and projection path was not`,
          ),
          { code: "probe_no_decision" },
        );
      }
      let projected = 0;
      for (const decision of result.decisions) {
        if (decision.claim_id === null || decision.claim_id === undefined) continue;
        try {
          const outcome = await projectClaim(executor, dependencies.projections, decision.claim_id);
          if (outcome.projected) projected += 1;
        } catch (error) {
          /**
           * A row-level-security refusal during the projection write is a fact about the
           * *binding*, not about the claim, so the binding is captured while it is still
           * available. Without this the report said only
           * `new row violates row-level security policy for table "claim_embeddings"` — one
           * occurrence in 14 000 operations during the 0014 window, with nothing to explain
           * it. Diagnosing it is cheap here and impossible afterwards.
           */
          if ((error as { code?: unknown }).code !== "42501") throw error;
          const diagnostic = await executor.query<{ bound: string | null; claim: string | null }>(
            `SELECT NULLIF(current_setting('veritymem.tenant_id', true), '') AS bound,
                    (SELECT tenant_id::text FROM claims WHERE claim_id = $1::uuid) AS claim`,
            [decision.claim_id.replace(/^clm_/, "")],
          );
          const row = diagnostic.rows[0];
          throw Object.assign(
            new Error(
              `${(error as Error).message} [rls diagnostic: bound tenant ` +
                `${row?.bound ?? "(unset)"}, claim tenant ${row?.claim ?? "(not visible)"}, ` +
                `event scope ${event.scope_id}, bound scopes ${JSON.stringify([event.scope_id])}]`,
            ),
            { code: "42501" },
          );
        }
      }
      return projected;
    },
  );
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface WorkloadHandle {
  /** Stop accepting new attempts; returns when the in-flight ones have settled. */
  stop(): Promise<void>;
  /**
   * Suspend the probe loops.
   *
   * `pause(true)` resolves once every in-flight attempt has settled, so no sample can be
   * recorded into the phase that follows. The rehearsal pauses for the two deliberately
   * failing migration attempts: their conflicting locks block *every* read, so an outage
   * measured there would be an outage caused by the fault injector and reported as though it
   * were caused by the migration.
   */
  pause(paused: boolean): Promise<void>;
  /** Attempts recorded so far, for a progress line. */
  readonly recorded: () => number;
}

/**
 * A ceiling on recorded attempts.
 *
 * A probe that fails without touching the database fails in microseconds, and a loop that
 * records every one of those will exhaust memory and starve the event loop of the very
 * timers and socket callbacks that would let the database recover. The pause between
 * attempts makes that unlikely; this cap makes it impossible.
 */
export const MAX_WORKLOAD_SAMPLES = 200_000;

/** Minimum time a worker waits between attempts, so a failing probe cannot hot-loop. */
export const MIN_ATTEMPT_INTERVAL_MS = 10;

/**
 * The sentence every append probe records.
 *
 * It is the shape the reference workload turns on — "I approved the Sunday 02:00 UTC deploy
 * window." — which the deterministic decision extractor recognises and the lexical
 * entailment backend accepts. A probe whose content produced no candidate would exercise the
 * event chain and nothing else, while reporting success.
 */
export const PROBE_APPROVAL = "I approved the Sunday 02:00 UTC deploy window.";

export interface WorkloadOptions {
  readonly read_concurrency: number;
  readonly write_concurrency: number;
  readonly probe_timeout_ms: number;
  readonly limit: number;
  readonly hydration_batch: number;
  readonly now: () => string;
  readonly phase: () => WorkloadPhase;
  readonly log: (message: string) => void;
}

/**
 * Start the workload.
 *
 * Reads and writes get separate worker counts because they stress different things: a read
 * worker holds a `READ ONLY` transaction and an `ACCESS SHARE`-class snapshot, a write
 * worker takes row locks on `streams` and inserts into `events`. One pool serves both, so
 * the pool's `max` is set to the sum and the caller is responsible for that.
 *
 * Events appended by the write workers feed the projection workers through a bounded queue.
 * A projection worker that finds the queue empty waits briefly and then records a
 * `probe_starved` failure naming the append operation — because an empty queue means the
 * appends are failing, and a projection probe that quietly skipped would hide that.
 */
export function startWorkload(
  dependencies: ProbeDependencies,
  tenants: readonly ProbeTenant[],
  recorder: WorkloadRecorder,
  options: WorkloadOptions,
): WorkloadHandle {
  // Each queued event carries the tenant it belongs to. Without that, a projection worker
  // that picked a different tenant than the appender bound a scope the event was not in,
  // and `readEvent` returned null — which looked like a projection failure and was a
  // bookkeeping bug in the load generator.
  const pending: { event_id: string; scope_id: string; tenant_index: number }[] = [];
  const streams = ["probe:thread-1", "probe:thread-2", "probe:thread-3", "probe:thread-4"];
  let running = true;
  let paused = false;
  let inFlight = 0;
  let counter = 0;
  const workers: Promise<void>[] = [];

  let stoppedForCap = false;
  const idle = async (): Promise<void> => {
    while (paused && running) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  /** Yield to the macrotask queue and enforce the sample ceiling. */
  const pace = async (): Promise<boolean> => {
    if (recorder.size() >= MAX_WORKLOAD_SAMPLES) {
      if (!stoppedForCap) {
        stoppedForCap = true;
        options.log(
          `workload stopped at the ${MAX_WORKLOAD_SAMPLES.toLocaleString("en-US")}-sample ceiling; ` +
            `the report records what was measured up to that point`,
        );
      }
      running = false;
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, MIN_ATTEMPT_INTERVAL_MS));
    return true;
  };

  const nextIndex = (): number => (counter += 1);

  const waitForInput = async (): Promise<{ event_id: string; scope_id: string; tenant_index: number } | null> => {
    // Long enough that an empty queue means the appenders are failing rather than that the
    // projection worker started first. A short wait turned ordinary startup ordering into a
    // recorded failure, which is noise dressed as a finding.
    const deadline = Date.now() + 2_000;
    while (running && Date.now() < deadline) {
      const item = pending.shift();
      if (item !== undefined) return item;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return pending.shift() ?? null;
  };

  for (let worker = 0; worker < options.read_concurrency; worker += 1) {
    workers.push(
      (async () => {
        // Round-robin *per attempt*, not per worker. Assigning an operation to a worker once
        // meant a single-worker rehearsal only ever exercised whatever that worker was given.
        let attempt = worker;
        while (running) {
          await idle();
          if (!(await pace())) break;
          const tenant = tenants[nextIndex() % tenants.length];
          if (tenant === undefined) break;
          const operation: ProbeOperation =
            attempt % 3 === 0 ? "lexical_retrieval" : attempt % 3 === 1 ? "entity_retrieval" : "claim_hydration";
          attempt += 1;
          inFlight += 1;
          await runProbe(recorder, {
            operation,
            phase: options.phase,
            options: { probe_timeout_ms: options.probe_timeout_ms },
            call: async () => {
              switch (operation) {
                case "lexical_retrieval":
                  return probeLexical(dependencies, tenant, { limit: options.limit, now: options.now() });
                case "entity_retrieval":
                  return probeEntity(dependencies, tenant, { limit: options.limit, now: options.now() });
                default:
                  return probeHydration(dependencies, tenant, { batch: options.hydration_batch });
              }
            },
          }).finally(() => {
            inFlight -= 1;
          });
        }
      })(),
    );
  }

  for (let worker = 0; worker < options.write_concurrency; worker += 1) {
    workers.push(
      (async () => {
        while (running) {
          await idle();
          if (!(await pace())) break;
          const tenantIndex = nextIndex() % tenants.length;
          const tenant = tenants[tenantIndex];
          if (tenant === undefined) break;
          const stream = streams[nextIndex() % streams.length] ?? "probe:thread-1";
          inFlight += 1;
          await runProbe(recorder, {
            operation: "append_event",
            phase: options.phase,
            options: { probe_timeout_ms: options.probe_timeout_ms },
            call: async () => {
              const appended = await probeAppend(dependencies, tenant, {
                stream: `${stream}:${tenant.tenantSlug}`,
                // A sentence the deterministic extractor recognises and the commit gate
                // accepts. The first version of this probe wrote "rehearsal probe event N",
                // which matches no extractor at all: the gate produced no candidate, the
                // projection step had nothing to project, and the operation recorded hundreds
                // of *successes* that had exercised nothing. The object is deliberately the
                // same every time so each append produces a `duplicates` relation and a new
                // accepted claim, which is what keeps the projection write path busy for the
                // whole migration.
                content: PROBE_APPROVAL,
                occurred_at: options.now(),
              });
              if (pending.length < 64) {
                pending.push({
                  event_id: appended.event_id,
                  scope_id: appended.scope_id,
                  tenant_index: tenantIndex,
                });
              }
              return appended.rows;
            },
          }).finally(() => {
            inFlight -= 1;
          });
        }
      })(),
    );
  }

  for (let worker = 0; worker < options.write_concurrency; worker += 1) {
    workers.push(
      (async () => {
        while (running) {
          await idle();
          if (!(await pace())) break;
          inFlight += 1;
          await runProbe(recorder, {
            operation: "project_claim",
            phase: options.phase,
            options: { probe_timeout_ms: options.probe_timeout_ms },
            call: async () => {
              const item = await waitForInput();
              if (item === null) {
                throw Object.assign(
                  new Error(
                    "no newly appended event was available to project within 250 ms, which means " +
                      "the append_event operation is not producing input",
                  ),
                  { code: "probe_starved" },
                );
              }
              const owner = tenants[item.tenant_index];
              if (owner === undefined) {
                throw Object.assign(
                  new Error(
                    `the queued event ${item.event_id} names tenant index ${item.tenant_index}, ` +
                      `which no longer exists`,
                  ),
                  { code: "probe_starved" },
                );
              }
              return probeProject(dependencies, owner, {
                event_id: item.event_id,
                scope_id: item.scope_id,
              });
            },
          }).finally(() => {
            inFlight -= 1;
          });
        }
      })(),
    );
  }

  options.log(
    `workload started: ${options.read_concurrency} read worker(s), ` +
      `${options.write_concurrency} append worker(s), ${options.write_concurrency} projection worker(s) ` +
      `across ${tenants.length} tenant(s)`,
  );

  return {
    recorded: () => recorder.size(),
    async pause(next: boolean) {
      paused = next;
      if (!next) return;
      const deadline = Date.now() + options.probe_timeout_ms + 1_000;
      // Two consecutive idle observations, not one. A worker can be between `idle()` returning
      // and `inFlight += 1`; waiting for a single zero let one attempt per operation start in
      // the paused phase, which contradicted the report's own claim that the probes are paused
      // there.
      let consecutiveIdle = 0;
      while (consecutiveIdle < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        consecutiveIdle = inFlight === 0 ? consecutiveIdle + 1 : 0;
      }
    },
    async stop() {
      paused = false;
      running = false;
      await Promise.all(workers);
      options.log("workload stopped");
    },
  };
}

/** The operations the report requires, re-exported so the CLI and tests name one list. */
export { PROBE_OPERATIONS };
