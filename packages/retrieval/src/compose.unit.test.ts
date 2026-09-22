import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QueryRequest } from "@veritymem/contracts";
import type { Db, Ledger, QueryExecutor } from "@veritymem/ledger";
import { compose } from "./compose.ts";
import type { EmbeddingBackend } from "./embeddings.ts";

describe("compose latency topology", () => {
  it("embeds before checkout, overlaps two bounded lanes, and reuses hydration for the trace", async () => {
    let activeTransactions = 0;
    let maxActiveTransactions = 0;
    let activeWhenEmbeddingStarted = -1;
    let releaseEmbedding!: (vectors: number[][]) => void;
    let markDenseStarted!: () => void;
    const embeddingReady = new Promise<number[][]>((resolve) => {
      releaseEmbedding = resolve;
    });
    const denseStarted = new Promise<void>((resolve) => {
      markDenseStarted = resolve;
    });

    const transactions: { action: string | undefined; queries: string[] }[] = [];
    let traceTransaction = -1;
    let traceQuery: Record<string, unknown> | null = null;

    const fakeDb = {
      async withRequest<T>(
        binding: { readonly action?: string },
        fn: (executor: QueryExecutor) => Promise<T>,
      ): Promise<T> {
        const transaction = transactions.length;
        const record = { action: binding.action, queries: [] as string[] };
        transactions.push(record);
        activeTransactions += 1;
        maxActiveTransactions = Math.max(maxActiveTransactions, activeTransactions);

        const executor: QueryExecutor = {
          async query<R>(sql: string, params: readonly unknown[] = []) {
            record.queries.push(sql);

            if (sql.includes("FROM principal_scopes")) {
              return {
                rows: [
                  {
                    scope_id: "22222222-2222-4222-8222-222222222222",
                    project: "payments",
                    user_id: "alice",
                    agent_id: null,
                    session_id: null,
                    purpose: ["release_planning"],
                  },
                ] as R[],
                rowCount: 1,
              };
            }
            if (sql.includes("FROM grants")) return { rows: [] as R[], rowCount: 0 };

            if (sql.includes("ts_rank")) {
              // Let dense start while this transaction is still open. This proves
              // the lanes overlap without depending on timer scheduling.
              releaseEmbedding([[0.25, 0.5]]);
              await denseStarted;
              return { rows: [] as R[], rowCount: 0 };
            }
            if (sql.includes("SELECT model_version, ledger_watermark")) {
              markDenseStarted();
              return {
                rows: [{ model_version: "test-model", ledger_watermark: 9 }] as R[],
                rowCount: 1,
              };
            }
            if (sql.includes("JOIN claim_embeddings")) return { rows: [] as R[], rowCount: 0 };
            if (sql.includes("FROM entity_aliases")) return { rows: [] as R[], rowCount: 0 };
            if (sql.includes("max(ledger_watermark)")) {
              return { rows: [{ watermark: 9 }] as R[], rowCount: 1 };
            }
            if (sql.includes("INSERT INTO query_traces")) {
              traceTransaction = transaction;
              traceQuery = JSON.parse(String(params[3])) as Record<string, unknown>;
              return { rows: [] as R[], rowCount: 1 };
            }
            throw new Error(`unexpected SQL in compose unit test: ${sql}`);
          },
        };

        try {
          return await fn(executor);
        } finally {
          activeTransactions -= 1;
        }
      },
    };

    const embeddings: EmbeddingBackend = {
      model_id: "test-model",
      dimensions: 2,
      isModelCall: true,
      async embed() {
        activeWhenEmbeddingStarted = activeTransactions;
        return embeddingReady;
      },
    };

    const request: { readonly tenant_id: string } & QueryRequest = {
      tenant_id: "11111111-1111-4111-8111-111111111111",
      query: "what did alice approve",
      scope: { tenant: "acme", project: "payments", user: "alice" },
      purpose: "release_planning",
      time: { mode: "current" },
      limit: 12,
    };

    const result = await compose(
      {
        db: fakeDb as unknown as Db,
        ledger: {} as Ledger,
        embeddings,
        ids: { next: () => "qry_33333333333343338333333333333333" },
        clock: { now: () => new Date("2026-09-21T00:00:00.000Z") },
        gateBackend: "unit-test",
      },
      request,
      { principal: "user:alice" },
    );

    assert.equal(activeWhenEmbeddingStarted, 0, "embedding must start before a database checkout");
    assert.equal(maxActiveTransactions, 2, "one query may use two lanes, never one connection per channel");
    assert.deepEqual(
      transactions.map(({ action }) => action),
      ["query:plan", "query:read", "query:read", "query:compose"],
    );
    assert.equal(transactions.length, 4, "hydration and trace must not open separate transactions");
    assert.equal(traceTransaction, 3, "the trace belongs to the hydration transaction");
    assert.equal(result.packet.projection_watermark, 9);
    assert.equal(result.packet.model_calls, 1);
    assert.deepEqual(result.channels.map(({ channel }) => channel), ["lexical", "dense", "entity", "temporal"]);

    const timings = traceQuery?.["phase_timings"] as Record<string, unknown> | undefined;
    assert.ok(timings, "the protected trace must attribute latency by phase");
    for (const key of ["planning_ms", "channel_wall_ms", "fusion_ms", "hydration_ms"]) {
      assert.equal(typeof timings[key], "number", `${key} must be numeric`);
    }
  });
});
