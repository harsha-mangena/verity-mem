/**
 * The isolation corpus: one case per boundary the specification claims to enforce.
 *
 * This is the *executable* half of the independent assessment described in
 * `docs/isolation-assessment.md`. An external team running this file gets a machine-checkable
 * pass or fail per boundary rather than a prose claim, and every case names the surface it
 * exercises so a failure localises.
 *
 * What this file is not: it is not the assessment. The specification is explicit that
 * "zero cross-tenant retrievals" means nothing against fixtures we wrote, and it is right. A
 * boundary the authors enumerate is the set of boundaries the authors thought of. The
 * assessment's value comes from cases this file does not contain, which is why the plan
 * document specifies the attack classes and the required environment rather than only
 * shipping these tests.
 *
 * Each case is written as the *positive* control too, where one is possible: a boundary that
 * blocks everything and a boundary that blocks nothing both "pass" an isolation test that only
 * checks for absence. `assertReaches` exists for that reason.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";
import { CommitGate, LexicalEntailmentBackend } from "@veritymem/gate";
import { DETERMINISTIC_EXTRACTORS, IngestPipeline } from "@veritymem/model-adapters";
import { resolveTenantId } from "@veritymem/ledger";
import { createTestContext, type TestContext } from "@veritymem/testkit";
import { HashEmbeddingBackend, compose, projectClaim, type RetrievalDependencies } from "./index.ts";

/**
 * A unique approval per case.
 *
 * The gate correctly refuses a duplicate of an accepted claim and escalates a contradiction,
 * so two cases sharing a statement would fail for a reason unrelated to isolation — and a
 * failure that could mean either "the boundary leaked" or "the gate refused a duplicate" is
 * not a usable test. `tag` is folded into the approved object, which the deterministic
 * extractor picks up as the claim's object.
 */
function approval(tag: string): string {
  return `I approved the ${tag} deploy window.`;
}

interface Harness {
  readonly ctx: TestContext;
  readonly deps: RetrievalDependencies;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly embeddings: HashEmbeddingBackend;
  readonly pipeline: IngestPipeline;
  close(): Promise<void>;
}

async function harness(label: string): Promise<Harness> {
  const ctx = await createTestContext(label);
  const gate = new CommitGate({
    db: ctx.db,
    ledger: ctx.ledger,
    ids: ctx.ids,
    clock: ctx.clock,
    entailment: new LexicalEntailmentBackend({ floor: DEFAULT_COMMIT_POLICY.thresholds.lexicalEntailmentFloor }),
    policy: DEFAULT_COMMIT_POLICY,
  });
  const embeddings = new HashEmbeddingBackend({ dimensions: 1024 });
  return {
    ctx,
    embeddings,
    pipeline: new IngestPipeline({
      db: ctx.db,
      ledger: ctx.ledger,
      gate,
      ids: ctx.ids,
      clock: ctx.clock,
      deterministicExtractors: DETERMINISTIC_EXTRACTORS,
      modelExtractor: null,
    }),
    deps: { db: ctx.db, ledger: ctx.ledger, embeddings, ids: ctx.ids, clock: ctx.clock, gateBackend: "lexical-overlap@1" },
    tenantId: resolveTenantId(ctx.tenantSlug),
    tenantSlug: ctx.tenantSlug,
    close: () => ctx.close(),
  };
}

interface WriteScope {
  readonly tenant?: string;
  readonly project?: string;
  readonly user?: string;
  readonly agent?: string;
  readonly session?: string;
  readonly purpose?: readonly string[];
}

/** Write an event under an explicit five-dimension scope and return the accepted claim id. */
async function write(
  h: Harness,
  scope: WriteScope,
  content = approval("default"),
  origin: "user" | "tool" = "user",
  /**
   * The principal to record as writing.
   *
   * Reach is participation plus grants, and participation is recorded on write. A principal
   * that has never written anywhere therefore reaches nothing — even a scope that names it.
   * That is fail-closed and intended (ADR 0011), and it means a positive control has to
   * establish membership before it can ask whether a boundary holds. Defaults to the scope's
   * own principal so most cases need not think about it.
   */
  principal?: string,
): Promise<string> {
  const author =
    principal ?? (origin === "tool" ? "tool:ci" : `user:${scope.user ?? scope.agent ?? scope.session ?? "service"}`);
  const receipt = await h.ctx.ledger.append({
    stream_id: `s-${Math.random().toString(36).slice(2, 8)}`,
    origin,
    actor_id: author,
    scope: {
      tenant: scope.tenant ?? h.tenantSlug,
      ...(scope.project !== undefined ? { project: scope.project } : {}),
      ...(scope.user !== undefined ? { user: scope.user } : {}),
      ...(scope.agent !== undefined ? { agent: scope.agent } : {}),
      ...(scope.session !== undefined ? { session: scope.session } : {}),
      purpose: [...(scope.purpose ?? ["release_planning"])],
    },
    occurred_at: "2026-09-10T09:14:00Z",
    content,
  });
  let claimId: string | null = null;
  await h.ctx.db.withRequest(
    {
      tenant: receipt.scope.tenant_id,
      principal: author,
      scopeIds: [receipt.scope.scope_id],
      purposes: [...(scope.purpose ?? ["release_planning"])],
      action: "worker:process",
    },
    async (executor) => {
      const event = await h.ctx.ledger.readEvent(executor, receipt.event_id);
      assert.ok(event);
      const result = await h.pipeline.ingest(executor, event);
      for (const decision of result.decisions) {
        if (decision.claim_id) {
          claimId = decision.claim_id;
          await projectClaim(executor, { db: h.ctx.db, embeddings: h.embeddings }, decision.claim_id);
        }
      }
    },
  );
  assert.ok(claimId, `expected an accepted claim for ${JSON.stringify(scope)}`);
  return claimId;
}

async function query(
  h: Harness,
  principal: string,
  selector: WriteScope,
  purpose = "release_planning",
  text = "deploy window approved",
) {
  return compose(
    h.deps,
    {
      tenant_id: h.tenantId,
      query: text,
      scope: {
        tenant: selector.tenant ?? h.tenantSlug,
        ...(selector.project !== undefined ? { project: selector.project } : {}),
        ...(selector.user !== undefined ? { user: selector.user } : {}),
        ...(selector.agent !== undefined ? { agent: selector.agent } : {}),
        ...(selector.session !== undefined ? { session: selector.session } : {}),
      },
      purpose,
    },
    { principal },
  );
}

function claimIds(packet: { claims: readonly { claim_id: string }[] }): string[] {
  return packet.claims.map((claim) => claim.claim_id);
}

describe("isolation corpus", () => {
  let h: Harness;

  before(async () => {
    h = await harness("isolation-corpus");
  });
  after(async () => {
    await h.close();
  });

  describe("B1 tenant boundary", () => {
    it("B1.1 a principal in one tenant reaches nothing in another", async () => {
      const ours = await write(h, { project: "b1", user: "alice" }, approval("tenant-one"));
      const otherTenant = `${h.tenantSlug}-other`;
      const theirs = await write(h, { tenant: otherTenant, project: "b1", user: "alice" }, approval("tenant-two"));

      const result = await query(h, "user:alice", { project: "b1" });
      const visible = claimIds(result.packet);
      assert.ok(!visible.includes(theirs), "a claim in another tenant must not be reachable");
      // The positive control: our own claim is reachable, so this is a boundary and not a
      // principal that can see nothing at all.
      assert.ok(visible.includes(ours), "the caller must still reach its own tenant");
    });
  });

  describe("B2 project boundary", () => {
    it("B2.1 a project-scoped caller does not reach a sibling project", async () => {
      const payments = await write(h, { project: "b2-payments", user: "carol" }, approval("payments-project"));
      const hr = await write(h, { project: "b2-hr", user: "carol" }, approval("hr-project"));

      const result = await query(h, "user:carol", { project: "b2-payments" });
      const visible = claimIds(result.packet);
      assert.ok(visible.includes(payments), "own project must be reachable, or the boundary proves nothing");
      assert.ok(!visible.includes(hr), "a sibling project must not be reachable");
      for (const claim of result.packet.claims) {
        assert.notEqual(claim.scope.project, "b2-hr", "a sibling project must not appear");
      }
    });
  });

  describe("B3 user boundary", () => {
    it("B3.1 a user-named selector reaches nothing of another user", async () => {
      const alice = await write(h, { project: "b3", user: "alice" }, approval("b3-alice"));
      const bob = await write(h, { project: "b3", user: "bob" }, approval("b3-bob"));

      const asBob = await query(h, "user:bob", { project: "b3", user: "bob" });
      const bobSees = claimIds(asBob.packet);
      assert.ok(!bobSees.includes(alice), "a user-named selector must not reach another user");
      assert.ok(bobSees.includes(bob), "and must still reach its own, or the boundary proves nothing");
      const asAlice = await query(h, "user:alice", { project: "b3", user: "alice" });
      assert.ok(claimIds(asAlice.packet).includes(alice), "alice must still reach her own claim");
    });

    it("B3.2 naming yourself narrows rather than widens", async () => {
      const alice = await write(h, { project: "b3n", user: "alice" }, approval("b3-narrowing"));
      const wide = await query(h, "user:alice", { project: "b3n" });
      const narrow = await query(h, "user:alice", { project: "b3n", user: "alice" });
      assert.ok(narrow.packet.claims.length <= wide.packet.claims.length, "narrowing must not admit more");
      assert.ok(claimIds(narrow.packet).includes(alice));
    });
  });

  describe("B4 agent boundary", () => {
    it("B4.1 an agent-scoped caller does not reach a differently-scoped agent's memory", async () => {
      const scoped = await write(h, { project: "b4", agent: "agent:planner" }, approval("agent-planner"), "user", "agent:planner");
      const other = await query(h, "agent:planner", { project: "b4", agent: "agent:reviewer" });
      assert.ok(!claimIds(other.packet).includes(scoped), "a different agent scope must not be reached");
      // Positive control: the planner reaches its own agent scope.
      const own = await query(h, "agent:planner", { project: "b4", agent: "agent:planner" });
      assert.ok(claimIds(own.packet).includes(scoped), "an agent must reach its own scope");
    });
  });

  describe("B5 session boundary", () => {
    it("B5.1 a session-scoped caller does not reach another session's memory", async () => {
      const s1 = await write(h, { project: "b5", session: "session:1" }, approval("session-one"), "user", "session:1-owner");
      const other = await query(h, "session:1-owner", { project: "b5", session: "session:2" });
      assert.ok(!claimIds(other.packet).includes(s1), "a sibling session must not be reachable");
      const own = await query(h, "session:1-owner", { project: "b5", session: "session:1" });
      assert.ok(claimIds(own.packet).includes(s1), "a session must reach its own scope");
    });
  });

  describe("B6 purpose boundary", () => {
    it("B6.1 a claim admitted for one purpose is invisible to an unrelated purpose", async () => {
      const planning = await write(h, { project: "b6", user: "dana", purpose: ["release_planning"] }, approval("b6-planning"));
      const unrelated = `unrelated_${Math.random().toString(36).slice(2, 8)}`;
      const result = await query(h, "user:dana", { project: "b6", user: "dana" }, unrelated);
      assert.deepEqual(claimIds(result.packet), [], "an unrelated purpose must reach nothing");
      assert.ok(result.packet.missing.length > 0, "and the packet must say why rather than look empty");
      // Positive control.
      const same = await query(h, "user:dana", { project: "b6", user: "dana" }, "release_planning");
      assert.ok(claimIds(same.packet).includes(planning));
    });
  });

  describe("B7 count and coverage inference", () => {
    it("B7.1 an empty result does not disclose whether anything exists", async () => {
      // A purpose nothing was admitted for. The packet must be indistinguishable from a
      // purpose that has data the caller cannot reach: same empty claim list, same
      // candidate count, same channel coverage.
      const nonexistent = `absent_${Math.random().toString(36).slice(2, 8)}`;
      const empty = await query(h, "user:alice", { project: "b7" }, nonexistent);
      const emptyAgain = await query(h, "user:alice", { project: "b7" }, `${nonexistent}_2`);

      assert.deepEqual(claimIds(empty.packet), []);
      assert.deepEqual(claimIds(emptyAgain.packet), []);
      assert.equal(
        empty.packet.coverage.candidates_considered,
        emptyAgain.packet.coverage.candidates_considered,
        "the candidate count must not differ between two equally-empty purposes",
      );
      assert.equal(
        empty.packet.coverage.candidates_denied_by_authz,
        0,
        "a denied count above zero would itself disclose that something exists",
      );
    });
  });

  describe("B8 grant expiry and revocation", () => {
    it("B8.1 does not honour an expired grant", async () => {
      const subject = `user:grantee-${Math.random().toString(36).slice(2, 8)}`;
      const target = await write(h, { project: "b8", user: "erin" }, approval("b8-granted"));

      // A grant that expired before the query. Resolve-scopes filters on `expires_at > now()`.
      await h.ctx.db.withSystemContext({ tenant: h.tenantId, actor: "test" }, (executor) =>
        executor.query(
          `INSERT INTO grants (grant_id, tenant_id, subject, resource_pattern, actions, purpose, matrix, expires_at)
           VALUES (gen_random_uuid(), $1::uuid, $2, 'tenant:*', ARRAY['read'], ARRAY['release_planning'],
                   $3::jsonb, now() - interval '1 day')`,
          [h.tenantId, subject, JSON.stringify({ tenant: h.tenantSlug, project: "b8" })],
        ),
      );

      const withExpired = await query(h, subject, { project: "b8" });
      assert.ok(
        !claimIds(withExpired.packet).includes(target),
        "an expired grant must not confer reach",
      );

      // Positive control: a live grant does confer it, so the absence above is the expiry and
      // not a grant mechanism that never works.
      await h.ctx.db.withSystemContext({ tenant: h.tenantId, actor: "test" }, (executor) =>
        executor.query(
          `INSERT INTO grants (grant_id, tenant_id, subject, resource_pattern, actions, purpose, matrix, expires_at)
           VALUES (gen_random_uuid(), $1::uuid, $2, 'tenant:*', ARRAY['read'], ARRAY['release_planning'],
                   $3::jsonb, now() + interval '1 day')`,
          [h.tenantId, subject, JSON.stringify({ tenant: h.tenantSlug, project: "b8" })],
        ),
      );
      const withLive = await query(h, subject, { project: "b8" });
      assert.ok(
        claimIds(withLive.packet).includes(target),
        "a live grant must confer reach, or the expiry test above proves nothing",
      );
    });
  });
});
