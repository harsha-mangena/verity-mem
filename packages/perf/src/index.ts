/**
 * `@veritymem/perf` — the one-million-claim performance benchmark.
 *
 * Exported as a library rather than only as a CLI so that the corpus, the workload and
 * the percentile maths can be unit-tested without a million-row database, which is the
 * only way the loader and the report get any regression protection at all.
 */
export * from "./corpus.ts";
export * from "./host.ts";
export * from "./load.ts";
export * from "./metrics.ts";
export * from "./report.ts";
export * from "./run.ts";
export * from "./workload.ts";
