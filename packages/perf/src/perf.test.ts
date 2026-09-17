/**
 * Tests for the benchmark instrument.
 *
 * The point of these is narrow and worth stating: a benchmark whose *instrument* is
 * wrong produces confident numbers that nobody can falsify, so the parts that must not
 * drift are pinned here — corpus determinism, the status mix the target size is derived
 * from, the percentile method, the largest-remainder allocation of the query mix, and
 * the fact that the verdict never claims a laptop is a reference machine.
 *
 * The database-backed test loads 400 claims, not a million. It is checking that the
 * loader writes rows the real read path can retrieve, which is a shape property and not
 * a size property; the size is what the reported run measures.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, loadEnv, resolveTenantId, systemClock, systemIds, FilesystemBlobStore, Ledger } from "@veritymem/ledger";
import { HashEmbeddingBackend, compose } from "@veritymem/retrieval";
import {
  BENCH_USER_COUNT,
  claimIdAt,
  contradictionPartner,
  corpusUuid,
  generateClaim,
  scopeIndexFor,
} from "./corpus.ts";
import { percentile, round3, summarise, summariseContent, type Sample } from "./metrics.ts";
import { buildReport, OPEN_CLAIM_FRACTION, renderSummary, TARGET_CLAIMS, type DatasetFact } from "./report.ts";
import { buildWorkload, DEFAULT_MIX } from "./workload.ts";
import { loadCorpus } from "./load.ts";

const ANCHOR = new Date("2026-09-17T12:00:00.000Z");
const SEED = "unit-test-seed";
/**
 * The tenant these unit tests materialise a corpus for.
 *
 * Required rather than optional, because every primary key in the corpus is derived
 * from `(tenant, label, index)`. The first version keyed them on the *seed*, which made
 * two tenants' corpora share `event_id`s and let `ON CONFLICT DO NOTHING` discard the
 * second tenant's rows while the loader reported success.
 */
const TENANT = "11111111-1111-4111-8111-111111111111";

describe("corpus", () => {
  it("is a pure function of (seed, index), so a resumed load produces the same rows", () => {
    const first = generateClaim(4_242, { seed: SEED, tenantId: TENANT, anchor: ANCHOR });
    const second = generateClaim(4_242, { seed: SEED, tenantId: TENANT, anchor: ANCHOR });
    assert.deepEqual(first, second);
    const other = generateClaim(4_243, { seed: SEED, tenantId: TENANT, anchor: ANCHOR });
    assert.notEqual(first.payload, other.payload);
    const otherSeed = generateClaim(4_242, { seed: "different", tenantId: TENANT, anchor: ANCHOR });
    assert.notEqual(first.payload, otherSeed.payload);
  });

  it("produces ids that are stable and derived from the tenant, not from a counter", () => {
    const tenant = resolveTenantId("perf-unit");
    assert.equal(corpusUuid(tenant, "clm", 7), corpusUuid(tenant, "clm", 7));
    assert.match(corpusUuid(tenant, "clm", 7), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(corpusUuid(tenant, "clm", 7), corpusUuid(resolveTenantId("other"), "clm", 7));
  });

  it("gives two tenants the same corpus with different ids", () => {
    // The defect this pins, which was silent and cost a working benchmark:
    // `generateClaim` derived every primary key from the corpus *seed* rather than the
    // tenant. Since `events.event_id` is a global primary key and every corpus insert
    // ends in `ON CONFLICT ... DO NOTHING`, the second tenant to load a seed had every
    // row discarded while the loader printed seven completed phases and a throughput
    // figure for each. The benchmark then failed with "tenant holds no claims", which
    // reads as a corpus problem and is a loader defect.
    const one = resolveTenantId("perf-tenant-one");
    const two = resolveTenantId("perf-tenant-two");
    const inOne = generateClaim(7, { seed: SEED, tenantId: one, anchor: ANCHOR });
    const inTwo = generateClaim(7, { seed: SEED, tenantId: two, anchor: ANCHOR });

    // Identity differs, so the two rows can coexist under a global primary key...
    assert.notEqual(inOne.eventId, inTwo.eventId);
    assert.notEqual(inOne.claimId, inTwo.claimId);
    assert.notEqual(inOne.spanId, inTwo.spanId);
    // ...while content is identical, so one seed still describes one corpus and a
    // benchmark result names the dataset it measured.
    assert.equal(inOne.payload, inTwo.payload);
    assert.equal(inOne.subject, inTwo.subject);
    assert.equal(inOne.objectText, inTwo.objectText);
    assert.equal(inOne.contradictsIndex, inTwo.contradictsIndex);
  });

  it("derives relation targets from the tenant, so an edge points at a row that exists", () => {
    // The relation edge named its target with `corpusUuid(ctx.corpusSeed, ...)`, which
    // after the identity fix pointed at a claim in no tenant at all -- caught by
    // `claim_relations_to_claim_fkey` rather than by any assertion.
    const tenant = resolveTenantId("perf-relations");
    const source = generateClaim(7, { seed: SEED, tenantId: tenant, anchor: ANCHOR });
    assert.equal(source.contradictsIndex, 6);
    assert.equal(claimIdAt(source.contradictsIndex, tenant), generateClaim(6, { seed: SEED, tenantId: tenant, anchor: ANCHOR }).claimId);
    assert.notEqual(claimIdAt(source.contradictsIndex, tenant), claimIdAt(source.contradictsIndex, resolveTenantId("someone-else")));
  });

  it("puts the quote inside the payload at the recorded offsets", () => {
    for (const index of [0, 1, 17, 999, 25_000]) {
      const claim = generateClaim(index, { seed: SEED, tenantId: TENANT, anchor: ANCHOR });
      const bytes = Buffer.from(claim.payload, "utf8");
      const slice = bytes.subarray(claim.startOffset, claim.endOffset).toString("utf8");
      assert.ok(claim.startOffset > 0, `index ${index} should not start at offset 0`);
      assert.ok(slice.length > 0);
      // The digest the loader writes must be the digest of that slice, or every
      // returned packet would report `digest_ok: false` and hydration would be measured
      // on the redacted path.
      assert.match(slice, /[a-z]/i);
      assert.ok(claim.embeddingText.length > 0);
    }
  });

  it("spreads claims round-robin across user scopes so a small corpus still populates every one", () => {
    for (let index = 0; index < BENCH_USER_COUNT * 3; index += 1) {
      assert.equal(scopeIndexFor(index), index % BENCH_USER_COUNT);
    }
  });

  it("marks exactly the claims that carry a contradiction, and only forward", () => {
    const withPartner = generateClaim(57, { seed: SEED, tenantId: TENANT, anchor: ANCHOR });
    assert.equal(withPartner.contradictsIndex, 56);
    assert.equal(contradictionPartner(56), null);
    const without = generateClaim(57 + 1, { seed: SEED, tenantId: TENANT, anchor: ANCHOR });
    assert.equal(without.contradictsIndex, null);
  });

  it("keeps at least 80% of claims open, which is what the accepted-claim target is sized from", () => {
    let open = 0;
    const total = 2_000;
    for (let index = 0; index < total; index += 1) {
      if (generateClaim(index, { seed: SEED, tenantId: TENANT, anchor: ANCHOR }).status === "accepted") open += 1;
    }
    // The report sizes "is this the target?" from a database count, but the default
    // `--claims` value assumes this fraction, so a drift here silently changes what a
    // default run measures.
    assert.ok(Math.abs(open / total - OPEN_CLAIM_FRACTION) < 0.01, `open fraction ${open / total}`);
  });

  it("gives every claim a valid interval: closed intervals are strictly positive", () => {
    for (let index = 0; index < 500; index += 1) {
      const claim = generateClaim(index, { seed: SEED, tenantId: TENANT, anchor: ANCHOR });
      if (claim.validTo !== null) {
        assert.ok(claim.validTo.getTime() > claim.validFrom.getTime(), `index ${index}`);
        assert.ok(claim.recordedAt.getTime() >= claim.validFrom.getTime());
      }
    }
  });
});

describe("workload", () => {
  it("allocates the mix exactly, with a sample count large enough for a p99 per mode", () => {
    const plan = buildWorkload({
      total: 4_000,
      limit: 12,
      corpusSeed: "slug",
      tenantId: resolveTenantId("slug"),
      anchor: ANCHOR,
    });
    assert.equal(plan.requests.length, 4_000);
    const counted = plan.mix.map(
      (shape) => plan.requests.filter((entry) => entry.shape === shape.shape).length,
    );
    const sum = counted.reduce((total, value) => total + value, 0);
    assert.equal(sum, 4_000);
    for (const mode of ["current", "as_of", "during"] as const) {
      assert.ok(plan.per_mode[mode] >= 200, `${mode} has only ${plan.per_mode[mode]} samples`);
    }
    assert.equal(
      plan.per_mode.current + plan.per_mode.as_of + plan.per_mode.during,
      4_000,
    );
  });

  it("issues distinct query text per request and a different set per corpus", () => {
    const a = buildWorkload({ total: 200, limit: 12, corpusSeed: "slug-a", tenantId: resolveTenantId("slug-a"), anchor: ANCHOR });
    const b = buildWorkload({ total: 200, limit: 12, corpusSeed: "slug-b", tenantId: resolveTenantId("slug-b"), anchor: ANCHOR });
    const texts = new Set(a.requests.map((entry) => entry.request.query));
    assert.ok(texts.size > 150, `only ${texts.size} distinct query strings out of 200`);
    assert.notDeepEqual(
      a.requests.map((entry) => entry.request.query),
      b.requests.map((entry) => entry.request.query),
    );
  });

  it("keeps the declared limit and tenant on every request", () => {
    const tenantId = resolveTenantId("slug");
    const plan = buildWorkload({ total: 120, limit: 25, corpusSeed: "slug", tenantId, anchor: ANCHOR });
    for (const entry of plan.requests) {
      assert.equal(entry.request.limit, 25);
      assert.equal(entry.request.tenant_id, tenantId);
      assert.equal(entry.request.purpose, "release_planning");
    }
  });

  it("only declares subjects in the shape that is documented as doing so", () => {
    const plan = buildWorkload({
      total: 400,
      limit: 12,
      corpusSeed: "slug",
      tenantId: resolveTenantId("slug"),
      anchor: ANCHOR,
    });
    for (const entry of plan.requests) {
      if (entry.shape === "current/subject+relation") assert.ok(entry.request.subjects);
      else assert.equal(entry.request.subjects, undefined);
    }
    assert.equal(DEFAULT_MIX.reduce((total, shape) => total + shape.proportion, 0).toFixed(6), "1.000000");
  });
});

describe("percentiles", () => {
  it("uses the nearest-rank definition, so p95 is an observed value", () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    assert.equal(percentile(values, 50), 50);
    assert.equal(percentile(values, 95), 95);
    assert.equal(percentile(values, 99), 99);
    assert.equal(percentile(values, 100), 100);
    assert.ok(Number.isNaN(percentile([], 95)));
  });

  /** 200 samples whose last `slowCount` are 9 s and whose remainder are 1 ms. */
  function tail(slowCount: number): Sample[] {
    return Array.from({ length: 200 }, (_, index) => ({
      position: index,
      mode: "current",
      shape: "s",
      latency_us: index < 200 - slowCount ? 1_000 : 9_000_000,
      returned: 3,
      candidates_considered: 10,
      decision: "use",
      empty: false,
      at_s: index / 100,
    }));
  }

  it("reports the tail once more than 5% of requests are slow", () => {
    // 20 of 200 slow is 10%, so nearest-rank p95 is `ceil(0.95 x 200)` = the 190th
    // smallest = the first slow sample. p50 stays on the fast population, which is what
    // makes the pair useful: the median did not move and the tail did.
    const summary = summarise(tail(20));
    assert.equal(summary.n, 200);
    assert.equal(summary.p50_ms, 1);
    assert.equal(summary.p95_ms, 9_000);
    assert.equal(summary.max_ms, 9_000);
    // The mean is derived from the samples, not asserted as a literal: `round3` of
    // (180 x 1 ms + 20 x 9000 ms) / 200 is 900.9, and pinning the exact digit here would
    // make the test fail on a rounding change that is not a bug.
    assert.ok(Math.abs(summary.mean_ms - 900.9) < 0.01, `mean was ${summary.mean_ms}`);
  });

  it("does not report a tail that is exactly 5% of requests", () => {
    // The consequence of nearest-rank, asserted rather than left to be rediscovered.
    // With 10 of 200 slow, rank 190 is the *last fast* sample, so p95 is 1 ms while max
    // is 9 s. An interpolating percentile would report something between the two -- a
    // latency no request experienced -- which is why this module does not interpolate.
    // A reader who wants "the 95th percentile" of a 5% tail wants max, and both numbers
    // are published side by side so that is visible rather than inferred.
    const summary = summarise(tail(10));
    assert.equal(summary.p95_ms, 1);
    assert.equal(summary.max_ms, 9_000);
  });

  it("reports emptiness, so an all-empty workload cannot pass as a fast one", () => {
    const content = summariseContent([
      { position: 0, mode: "current", shape: "s", latency_us: 500, returned: 0, candidates_considered: 0, decision: "clarify", empty: true, at_s: 0 },
      { position: 1, mode: "current", shape: "s", latency_us: 500, returned: 4, candidates_considered: 40, decision: "use", empty: false, at_s: 0 },
    ]);
    assert.equal(content.empty_packets, 1);
    assert.equal(content.empty_fraction, 0.5);
    assert.equal(content.returned_mean, 2);
  });
});

describe("verdict", () => {
  const dataset: DatasetFact = {
    tenant_slug: "s",
    tenant_id: "00000000-0000-0000-0000-000000000000",
    corpus_seed: "s",
    claims_requested: 10,
    claims_measured: 10,
    accepted_claims: 8,
    accepted_claims_target: TARGET_CLAIMS,
    is_target_size: false,
    generator: "corpus.ts",
    generator_bypassed_write_path: true,
    write_path_statement: "bypassed",
    anchor: ANCHOR.toISOString(),
    load_elapsed_ms: 1,
    resumed_from: null,
    counts: [],
    embedding: { backend: "hash", model_id: "hash-ngram-v1", dimensions: 1024, is_model_call: false },
    scope_shape: {
      project: "p",
      user_scopes: 1,
      purposes: ["release_planning"],
      principal: "agent:x",
      authorized_scope_ids: 2,
      reach_description: "d",
    },
    status_mix: { accepted: 8, superseded: 2 },
    temporal_mix: { distinct: [] },
    historical_probe: null,
    sample_digest: null,
  };

  const scenario = (p95: number) => ({
    cache_state: "warm" as const,
    label: "l",
    trace_writes: true,
    started_at: ANCHOR.toISOString(),
    duration_ms: 1,
    by_mode: {
      current: { n: 10, min_ms: 1, p50_ms: 1, p90_ms: 1, p95_ms: p95, p99_ms: p95, max_ms: p95, mean_ms: 1, method: "m" },
      as_of: { n: 10, min_ms: 1, p50_ms: 1, p90_ms: 1, p95_ms: 1, p99_ms: 1, max_ms: 1, mean_ms: 1, method: "m" },
      during: { n: 10, min_ms: 1, p50_ms: 1, p90_ms: 1, p95_ms: 1, p99_ms: 1, max_ms: 1, mean_ms: 1, method: "m" },
    },
    all: { n: 30, min_ms: 1, p50_ms: 1, p90_ms: 1, p95_ms: 1, p99_ms: 1, max_ms: 1, mean_ms: 1, method: "m" },
    content: {
      current: summariseContent([]),
      as_of: summariseContent([]),
      during: summariseContent([]),
    },
    by_shape: [],
    buffers: {
      before: { heap_blks_read: 0, heap_blks_hit: 0, idx_blks_read: 0, idx_blks_hit: 0, hit_ratio: null },
      after: { heap_blks_read: 0, heap_blks_hit: 0, idx_blks_read: 0, idx_blks_hit: 0, hit_ratio: null },
      delta: { heap_blks_read: 0, heap_blks_hit: 0, idx_blks_read: 0, idx_blks_hit: 0, hit_ratio: null },
    },
    // Required by `ScenarioResult`: a run whose connection pool errored is not a
    // measurement, and this field is how a report says so rather than quietly publishing
    // a latency distribution from a run that lost connections.
    pool_errors: [],
  });

  it("never lets a laptop run count as the reference machine, even when the target is met", () => {
    const report = buildReport({
      generatedAt: ANCHOR.toISOString(),
      commit: { sha: "a".repeat(40), short: "aaaaaaa", branch: "main", dirty: false, dirty_files: [], note: "n" },
      pgLibrary: "8.16.3",
      host: {
        cpu_model: "Apple M1 Pro",
        cpu_cores_logical: 8,
        cpu_cores_physical: 8,
        cpu_performance_cores: 6,
        cpu_efficiency_cores: 2,
        ram_bytes: 16 * 1024 ** 3,
        ram_gb: 16,
        os: "darwin",
        os_version: "26.7",
        kernel: "25.6.0",
        arch: "arm64",
        node_version: "v24",
        is_laptop: true,
        source: "sysctl",
      },
      postgres: {
        version: "PostgreSQL 17.11",
        version_num: 170011,
        pgvector_version: "0.8.6",
        database_size_bytes: 1,
        settings: {},
        hnsw: [],
        indexes: [],
        table_sizes: [],
      },
      dataset,
      workload: {
        mix: DEFAULT_MIX,
        per_mode_issued: { current: 1, as_of: 1, during: 1 },
        concurrency: 4,
        result_limit: 12,
        channel_fetch_limit: 48,
        fusion_limit: 36,
        requests_total: 3,
        requests_per_mode_per_pass: { current: 1, as_of: 1, during: 1 },
        warmup_requests: 0,
        query_text: "q",
        read_path: "compose()",
        model_calls_per_query: 0,
        cache_states: "c",
      },
      measurements: [scenario(10)],
      referenceMachineDeclared: false,
    });
    assert.equal(report.verdict.target_met_on_this_machine, true);
    assert.equal(report.verdict.block_b7_closed, false);
    assert.equal(report.target.reference_machine_published, false);
    assert.equal(report.verdict.block_status, "evidence, not closure");
    assert.ok(report.verdict.why_not_closed.length >= 3);
    assert.ok(renderSummary(report).includes("NOT A PUBLISHED REFERENCE MACHINE"));
  });

  it("reports a missed target as missed, and still refuses to close the block", () => {
    const report = buildReport({
      generatedAt: ANCHOR.toISOString(),
      commit: { sha: "a".repeat(40), short: "aaaaaaa", branch: "main", dirty: true, dirty_files: ["x"], note: "n" },
      pgLibrary: "8.16.3",
      host: {
        cpu_model: "c", cpu_cores_logical: 1, cpu_cores_physical: null, cpu_performance_cores: null,
        cpu_efficiency_cores: null, ram_bytes: 1, ram_gb: 0, os: "linux", os_version: "x", kernel: "y",
        arch: "x64", node_version: "v24", is_laptop: null, source: "s",
      },
      postgres: {
        version: "PostgreSQL 17.11", version_num: 170011, pgvector_version: "0.8.6",
        database_size_bytes: 1, settings: {}, hnsw: [], indexes: [], table_sizes: [],
      },
      dataset,
      workload: {
        mix: DEFAULT_MIX, per_mode_issued: { current: 1, as_of: 1, during: 1 }, concurrency: 1,
        result_limit: 12, channel_fetch_limit: 48, fusion_limit: 36, requests_total: 3,
        requests_per_mode_per_pass: { current: 1, as_of: 1, during: 1 }, warmup_requests: 0,
        query_text: "q", read_path: "compose()", model_calls_per_query: 0, cache_states: "c",
      },
      measurements: [scenario(900)],
      referenceMachineDeclared: false,
    });
    assert.equal(report.verdict.target_met_on_this_machine, false);
    assert.equal(report.verdict.slowest_mode, "current");
    assert.ok(report.verdict.why_not_closed.some((line) => line.includes("not the 1,000,000")));
  });
});

describe("loader and read path (requires PostgreSQL)", () => {
  const directory = mkdtempSync(join(tmpdir(), "veritymem-perf-test-"));
  const slug = `perf-test-${Date.now().toString(36)}`;
  const tenantId = resolveTenantId(slug);
  const env = loadEnv();
  let db: Db;

  before(() => {
    db = new Db({ connectionString: env.databaseUrl, max: 4, applicationName: "veritymem-perf-test" });
  });

  after(async () => {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const load = (claims: number) =>
    loadCorpus({
      migrationUrl: env.migrationDatabaseUrl ?? env.databaseUrl,
      tenantId,
      tenantSlug: slug,
      claims,
      corpusSeed: `${slug}-seed`,
      anchor: ANCHOR,
      embeddingModelId: "hash-ngram-v1",
      embeddingDimensions: 1024,
      statePath: join(directory, "load-state.json"),
    });

  it("loads a corpus that the real read path can retrieve, with verified evidence", async () => {
    const first = await load(400);
    const counts = Object.fromEntries(first.counts.map((entry) => [entry.table, entry.rows]));
    assert.equal(counts["claims"], 400);
    assert.equal(counts["events"], 400);
    assert.equal(counts["evidence_spans"], 400);
    assert.equal(counts["claim_evidence"], 400);
    assert.equal(counts["claim_embeddings"], 400);

    // A second call must be a no-op rather than a duplicate: the whole loader rests on
    // keys derived from the claim index.
    const second = await load(400);
    const after = Object.fromEntries(second.counts.map((entry) => [entry.table, entry.rows]));
    assert.deepEqual(after, counts);

    const ledger = new Ledger({
      db,
      blobs: new FilesystemBlobStore(join(directory, "blobs")),
      clock: systemClock,
      ids: systemIds,
    });
    const result = await compose(
      { db, ledger, embeddings: new HashEmbeddingBackend({ dimensions: 1024, modelId: "hash-ngram-v1" }), ids: systemIds, clock: systemClock },
      {
        tenant_id: tenantId,
        query: "user:eng-00 prefers which workflow",
        scope: { tenant: slug, project: "payments-api" },
        purpose: "release_planning",
        limit: 5,
      },
      { principal: "agent:perf-bench-runner" },
    );

    // A claim came back, so authorization resolved, the lexical and dense channels
    // both matched, fusion produced candidates, and hydration re-verified the span
    // digest. Any of those failing yields an empty packet, which is why this asserts
    // non-emptiness rather than a count.
    assert.ok(result.packet.claims.length > 0, "expected at least one retrieved claim");
    for (const claim of result.packet.claims) {
      assert.ok(claim.evidence.length > 0, "every returned claim must carry evidence");
      assert.ok(
        claim.evidence.every((entry) => entry.digest_ok),
        "every returned span digest must verify against the stored payload",
      );
    }
    assert.equal(result.packet.model_calls, 0, "the default read path must make zero model calls");
  });

  it("returns nothing for a caller with no membership in the tenant", async () => {
    const ledger = new Ledger({
      db,
      blobs: new FilesystemBlobStore(join(directory, "blobs")),
      clock: systemClock,
      ids: systemIds,
    });
    const result = await compose(
      { db, ledger, embeddings: new HashEmbeddingBackend({ dimensions: 1024, modelId: "hash-ngram-v1" }), ids: systemIds, clock: systemClock },
      {
        tenant_id: tenantId,
        query: "user:eng-00 prefers which workflow",
        scope: { tenant: slug, project: "payments-api" },
        purpose: "release_planning",
        limit: 5,
      },
      { principal: "agent:never-participated" },
    );
    assert.equal(result.packet.claims.length, 0);
    assert.equal(result.packet.decision, "clarify");
  });
});
