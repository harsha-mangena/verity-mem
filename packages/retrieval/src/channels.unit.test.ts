import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QueryExecutor } from "@veritymem/ledger";
import { denseChannel, entityChannel, type ChannelQuery } from "./channels.ts";
import type { EmbeddingBackend } from "./embeddings.ts";

const QUERY: ChannelQuery = {
  tenant_id: "11111111-1111-4111-8111-111111111111",
  text: "what did alice approve",
  authorized_scopes: [
    {
      scope_id: "22222222-2222-4222-8222-222222222222",
      project: "payments",
      user_id: "alice",
      agent_id: null,
      session_id: null,
    },
  ],
  purposes: ["release_planning"],
  time: { mode: "current" },
  kinds: null,
  subjects: null,
  entity_terms: ["alice"],
  limit: 12,
  now: "2026-09-21T00:00:00.000Z",
};

describe("latency-safe retrieval query shapes", () => {
  it("uses the canonical-to-claim index instead of joining an alias to every claim", async () => {
    let sql = "";
    let params: readonly unknown[] = [];
    const executor: QueryExecutor = {
      async query<R>(text: string, values: readonly unknown[] = []) {
        sql = text;
        params = values;
        return { rows: [{ claim_id: "claim-1", score: 1 }] as R[], rowCount: 1 };
      },
    };

    const result = await entityChannel(executor, QUERY);

    assert.equal(result.ran, true);
    assert.match(sql, /FROM entity_aliases a\s+JOIN claim_entities ce/);
    assert.match(sql, /c\.scope_id = ANY\(veritymem\.current_reachable_scope_ids\(\)\)/);
    assert.doesNotMatch(sql, /lower\(c\.object::text\)/);
    assert.doesNotMatch(sql, /OR a\.canonical/);
    assert.deepEqual(params, [QUERY.tenant_id, ["release_planning"], ["alice"], 12]);
  });

  it("accepts a prepared vector so hosted embedding latency holds no database transaction", async () => {
    const statements: string[] = [];
    const values: (readonly unknown[])[] = [];
    const executor: QueryExecutor = {
      async query<R>(text: string, params: readonly unknown[] = []) {
        statements.push(text);
        values.push(params);
        if (statements.length === 1) {
          return {
            rows: [{ model_version: "test-model", ledger_watermark: 7 }] as R[],
            rowCount: 1,
          };
        }
        return { rows: [{ claim_id: "claim-1", score: 0.75 }] as R[], rowCount: 1 };
      },
    };
    let embedCalls = 0;
    const embeddings: EmbeddingBackend = {
      model_id: "test-model",
      dimensions: 2,
      isModelCall: true,
      async embed() {
        embedCalls += 1;
        return [[9, 9]];
      },
    };

    const result = await denseChannel(executor, QUERY, embeddings, [0.25, 0.5]);

    assert.equal(result.ran, true);
    assert.equal(embedCalls, 0);
    assert.equal(statements.length, 2);
    assert.deepEqual(values[0], [QUERY.tenant_id]);
    assert.match(statements[1]!, /e\.tenant_id = \$1::uuid/);
    assert.match(
      statements[1]!,
      /ORDER BY \(e\.embedding <=> \$3::vector\) \+ 0 ASC/,
      "dense retrieval must remain an exact sort over the tenant-filtered candidate set, not use the global HNSW graph",
    );
    assert.deepEqual(values[1], [QUERY.tenant_id, ["release_planning"], "[0.25000000,0.50000000]", "test-model", 12]);
  });
});
