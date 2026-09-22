/**
 * The read-path observation hook, and the executor that implements capture.
 *
 * ## The shape of the problem
 *
 * VM-A3 needs the real PostgreSQL plan for every retrieval stage. The statements must be
 * the ones the production channels run, so the capture cannot live in the profiler: a
 * second copy of the channel SQL measures the copy. The hook therefore sits at the
 * lowest shared point — `QueryExecutor` — and the profiler supplies an implementation.
 *
 * `ComposeOptions.observer` is the whole of `compose`'s knowledge of this: it wraps the
 * executor it was already going to build and does nothing else. `packages/retrieval`
 * gains a seam, not a dependency on the profiler.
 *
 * ## Execution order, and why it matters
 *
 * The observer executes the statement it was handed **first**, returns those rows
 * untouched, and only then runs `EXPLAIN (ANALYZE, …)` on the same statement with the
 * same parameters.
 *
 * The obvious alternative — `EXPLAIN ANALYZE` first, and let the channel read the
 * explain's rows — is wrong for a subtle reason. `EXPLAIN ANALYZE` returns a plan, not a
 * result set. A channel handed a plan-shaped result would see "no rows" and take its
 * empty path: `denseChannel`'s model-mismatch branch, the empty-packet branch, the
 * abstention decision. Whatever it then reported would describe the observability
 * harness rather than the read path, which is precisely the failure this task exists to
 * avoid.
 *
 * So the channel sees exactly what it would see without the observer, and the plan is a
 * second execution of the same statement. The cost is stated rather than hidden: the
 * captured `actual time` and buffer counters describe the **second** run of a statement
 * whose pages are now warm, so they are not the numbers the channel experienced. They
 * are still the right numbers for a plan-shape question, which is what this artifact is
 * for, and the artifact says so.
 *
 * ## Why the stage name is handed in rather than inferred
 *
 * The profiler could guess a stage from the SQL text. That guess would be a second
 * implementation of "which query is this", and it would silently mislabel the day a
 * channel changes its `FROM` clause. Instead `compose` says what it is about to run —
 * `observer.aboutToRun("lexical")` — and the executor pairs the next statement with that
 * name in order. Statements that arrive with no tag queued are captured as `unlabeled`
 * rather than dropped, so a new query in a channel shows up in the artifact instead of
 * disappearing from it.
 */
import type { QueryExecutor, QueryResultRow } from "@veritymem/ledger";

/** The retrieval stages this package knows how to name. */
export const RETRIEVAL_STAGES = [
  "scope_binding",
  "lexical_channel",
  "entity_channel",
  "temporal_channel",
  "relation_channel",
  "dense_model_version",
  "dense_vector_search",
  "claim_hydration",
  "claim_relations_read",
  "claim_evidence_read",
  "span_verification",
  "projection_watermark",
] as const;

export type RetrievalStage = (typeof RETRIEVAL_STAGES)[number] | "unlabeled";

export interface ObservedQuery {
  readonly stage: RetrievalStage;
  readonly sql: string;
  readonly params: readonly unknown[];
  /** Raw explain output, or null when the capture itself failed. */
  readonly plan: readonly unknown[] | null;
  /** A sanitized message when the capture failed; null on success. */
  readonly error: string | null;
}

export interface QueryObserver {
  /** Record a captured statement. Called after the statement has already executed. */
  observed(entry: ObservedQuery): void;
}

/** Options for the explaining executor. */
export interface ExplainingExecutorOptions {
  readonly observer: QueryObserver;
  /**
   * The stage every statement through this executor belongs to.
   *
   * **Bound to the executor rather than queued.** Two earlier versions tried a queue of
   * pending stage names — first global, then per lane — and both mislabelled statements,
   * because `runChannels` executes the ordinary channels and the dense channel on two
   * concurrent transactions. Whatever the queue's granularity, a statement's stage is
   * decided by *when it happens to run* relative to another lane's statements, and the
   * lanes interleave differently on every run. A trace of the per-lane version showed
   * `entity_channel` popping `dense_vector_search`.
   *
   * Binding the name to the executor removes the ordering assumption entirely: the executor
   * a channel was handed knows which stage it is serving, so concurrency cannot change the
   * answer. A stage that issues more than one statement gets one executor per stage, which
   * is why `denseChannel` takes a hook to create them.
   */
  readonly stageName: RetrievalStage;
  /**
   * Runs `EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON) <sql>` with `params`
   * inside the same transaction as the observed statement.
   *
   * Injected rather than implemented here so this module stays testable without a
   * database, and so the single place that knows how to reach PostgreSQL is the profiler.
   * It must resolve to the parsed explain rows, or throw.
   */
  readonly explain: (sql: string, params: readonly unknown[]) => Promise<readonly unknown[]>;
  /**
   * Whether the plan for this statement is worth capturing.
   *
   * The trace insert at the end of `compose` is a write whose plan nobody needs, and
   * `EXPLAIN ANALYZE` on it would execute the insert a second time — which for an
   * append-only ledger is not a harmless mistake. Defaults to refusing anything that is
   * not a read.
   */
  readonly shouldCapture?: (sql: string) => boolean;
}

/**
 * A conservative read-only test.
 *
 * Deliberately a deny-list of write verbs rather than an allow-list of `SELECT`: the
 * cost of capturing one query too many is a slightly larger artifact, and the cost of
 * capturing a write is a duplicated append to an append-only ledger. `WITH … INSERT`
 * and `EXPLAIN`-shaped input are both refused.
 */
export function looksReadOnly(sql: string): boolean {
  const normalized = sql.trimStart().toLowerCase();
  if (normalized.startsWith("select") || normalized.startsWith("with")) {
    // A CTE can carry a write. Refuse the whole statement if any write verb appears as a
    // word anywhere in it; this over-refuses `select 'insert'`-style literals, which is
    // the safe direction.
    return !/\b(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke)\b/.test(normalized);
  }
  return false;
}

/**
 * Wrap an executor so every statement it runs is observed.
 *
 * The returned executor is behaviourally identical to the one passed in: the same rows,
 * the same `rowCount`, the same errors, in the same order. The observation happens after
 * the caller's own query has completed, and an observation failure is recorded on the
 * entry rather than thrown, because a profiler must not change the behaviour of the thing
 * it is profiling.
 */
export function withObservation(
  executor: QueryExecutor,
  options: ExplainingExecutorOptions,
): QueryExecutor {
  const shouldCapture = options.shouldCapture ?? looksReadOnly;

  return {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<{ rows: R[]; rowCount: number | null }> {
      const result = await executor.query<R>(text, params);

      if (!shouldCapture(text)) return result;
      const stage = options.stageName;

      let plan: readonly unknown[] | null = null;
      let error: string | null = null;
      try {
        plan = await options.explain(text, params);
      } catch (cause) {
        // A statement that cannot be explained — a plan the database refuses, a timeout —
        // must not fail the capture run. It is recorded as a failed stage with a sanitized
        // message, which is what the artifact's `success: false` entry is for.
        error = (cause as Error).message;
      }
      options.observer.observed({ stage, sql: text, params, plan, error });
      return result;
    },
  };
}

/**
 * Build an executor whose statements are all attributed to one stage.
 *
 * The unit of attribution is the executor, so a channel is handed the executor for its own
 * stage and nothing it runs can be credited to another stage. When nobody is observing, the
 * executor is returned unchanged, so an ordinary read pays nothing for this seam.
 */
export function forStage(
  executor: QueryExecutor,
  observer: QueryObserver | undefined,
  make: ((executor: QueryExecutor, observer: QueryObserver, stageName: RetrievalStage) => QueryExecutor) | undefined,
  stageName: RetrievalStage,
): QueryExecutor {
  if (observer === undefined || make === undefined) return executor;
  return make(executor, observer, stageName);
}
