/**
 * Outbox processors the worker registers.
 *
 * Both processors here are factories around code that already exists — the ingest
 * pipeline in `@veritymem/model-adapters` and the projection processor in
 * `@veritymem/retrieval`. Nothing in this file implements extraction, gating or
 * projection; it only adapts a `LedgerEvent` lookup to the message shape the
 * outbox carries and chooses the dependencies each one runs with.
 *
 * Two facts about the message envelopes matter and are easy to get wrong:
 *
 *   1. `extract.event` is enqueued by `Ledger.append`, and its payload names the
 *      event id, the tenant, the scope and the purposes. `OutboxWorker` binds all
 *      of them into the request transaction before the handler runs, and it throws
 *      if `scope_ids` or `purposes` is absent. That throw is the fix for a worker
 *      that used to bind an empty context, read nothing, and report success — so
 *      the payload is read as-is and never defaulted here.
 *   2. `project.claim` is enqueued by the ingest pipeline itself, once per accepted
 *      claim, inside the same transaction that accepted it. The `extract.event`
 *      handler therefore must not enqueue projections: doing so would project each
 *      claim twice and, worse, would project claims the gate did not accept.
 */
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";
import { LedgerError, type Clock, type Db, type IdGenerator, type Ledger, type OutboxProcessor } from "@veritymem/ledger";
import { CommitGate, LexicalEntailmentBackend, OnnxEntailmentBackend, type EntailmentBackend } from "@veritymem/gate";
import {
  DETERMINISTIC_EXTRACTORS,
  type Extractor,
  IngestPipeline,
  ModelExtractor,
  OpenAiCompatibleAdapter,
} from "@veritymem/model-adapters";

export const EXTRACT_KIND = "extract.event";

export interface IngestProcessorDependencies {
  readonly db: Db;
  readonly ledger: Ledger;
  readonly gate: CommitGate;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** Model extractor, or null when no endpoint is configured. */
  readonly modelExtractor: Extractor | null;
}

/**
 * The `extract.event` processor.
 *
 * Failure is returned to the caller rather than caught, because `OutboxWorker`
 * owns retry: it records the error on the row, applies exponential backoff, and
 * stops retrying a poison message after `max_attempts`. Swallowing an error here
 * would complete the message and silently lose the extraction, which is the same
 * class of bug as the old empty-context no-op.
 */
export function createIngestProcessor(dependencies: IngestProcessorDependencies): OutboxProcessor {
  const pipeline = new IngestPipeline({
    db: dependencies.db,
    ledger: dependencies.ledger,
    gate: dependencies.gate,
    ids: dependencies.ids,
    clock: dependencies.clock,
    // Deterministic extractors first is a pipeline guarantee, not an ordering
    // choice made here; the array is the shipped set in the shipped order.
    deterministicExtractors: DETERMINISTIC_EXTRACTORS,
    modelExtractor: dependencies.modelExtractor,
  });

  return {
    kind: EXTRACT_KIND,
    async handle(message): Promise<void> {
      const eventId = readEventId(message.payload, message.outbox_id);
      // The event is read inside the request transaction the worker opened from
      // the message's own binding, so row-level security sees exactly the scopes
      // the append declared and nothing else.
      const event = await dependencies.ledger.readEvent(dependencies.db, eventId);
      if (!event) {
        throw new LedgerError("not_found", `outbox message ${message.outbox_id} names event ${eventId}, which is not visible`, 404);
      }
      await pipeline.ingest(dependencies.db, event);
    },
  };
}

/**
 * Read `event_id` out of an `extract.event` payload.
 *
 * A missing id is thrown rather than defaulted: an `extract.event` message with no
 * event cannot be processed, and treating it as a no-op would delete the work by
 * completing the row.
 */
function readEventId(payload: Record<string, unknown>, outboxId: number): string {
  const value = payload["event_id"];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`extract.event message ${outboxId} carries no event_id`);
  }
  return value;
}

export interface GateFactoryOptions {
  readonly db: Db;
  readonly ledger: Ledger;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly backend: "lexical" | "onnx";
  readonly modelPath: string | null;
  readonly modelSha256: string | null;
  readonly lexicalFloor: number;
  /**
   * Required only when `backend` is `onnx`; a lexical deployment has no model. Optional
   * rather than nullable so a lexical configuration cannot accidentally carry a stale
   * path that a later switch to onnx would then trust.
   */
  readonly tokenizerPath?: string | null;
  /** Per-backend: a softmax probability, not the lexical token-overlap fraction. */
  readonly entailmentThreshold?: number;
  readonly contradictionThreshold?: number;
}

/**
 * Build the entailment backend the gate runs with.
 *
 * `onnx` with a missing or unpinned artefact **throws**, and the worker refuses to
 * start. Earlier this degraded to an `unavailable` backend that returned `unknown` and
 * sent everything to review; that was the right failure *direction* but the wrong
 * severity, because a worker that starts with a dead gate looks healthy while every
 * write it processes goes unreviewed in a queue nobody is watching. The escape hatch is
 * an explicit configuration change back to `lexical`, which the decision record then
 * shows.
 */
export async function createEntailmentBackend(options: GateFactoryOptions): Promise<EntailmentBackend> {
  if (options.backend === "onnx") {
    // Throws when the assets are missing or unpinned. An operator who asked for ONNX is
    // better served by "the gate is down" than by a silent downgrade to a stand-in that
    // computes something else under the same decision record.
    if (!options.modelPath || !options.tokenizerPath) {
      throw new Error(
        "GATE_ENTAILMENT_BACKEND=onnx requires GATE_MODEL_PATH and GATE_TOKENIZER_PATH. " +
          "Provision with 'node scripts/fetch-model.mjs', or use the lexical stand-in explicitly.",
      );
    }
    return OnnxEntailmentBackend.load({
      modelPath: options.modelPath,
      tokenizerPath: options.tokenizerPath,
      ...(options.modelSha256 != null ? { modelSha256: options.modelSha256 } : {}),
      entailmentThreshold: options.entailmentThreshold ?? 0.5,
      contradictionThreshold: options.contradictionThreshold ?? 0.5,
    });
  }
  return new LexicalEntailmentBackend({ floor: options.lexicalFloor });
}

/** The commit gate, with the versioned policy document rather than a local copy. */
export function createGate(dependencies: {
  readonly db: Db;
  readonly ledger: Ledger;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly entailment: EntailmentBackend;
}): CommitGate {
  return new CommitGate({
    db: dependencies.db,
    ledger: dependencies.ledger,
    ids: dependencies.ids,
    clock: dependencies.clock,
    entailment: dependencies.entailment,
    policy: DEFAULT_COMMIT_POLICY,
  });
}

export interface ModelExtractorOptions {
  readonly baseUrl: string | null;
  readonly apiKey: string | null;
  readonly model: string | null;
}

/**
 * Build the model extractor, or return null.
 *
 * Null is a legitimate, recorded configuration: the pipeline notes "no model
 * extractor configured; deterministic extraction only" on every event, which is
 * how an operator can tell a cheap deployment from a broken one. Constructing a
 * `ModelExtractor` around an unavailable adapter instead would produce the same
 * empty result with no such note.
 */
export function createModelExtractor(options: ModelExtractorOptions): Extractor | null {
  if (options.baseUrl === null || options.model === null) return null;
  const adapter = new OpenAiCompatibleAdapter({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    model: options.model,
  });
  return new ModelExtractor({ adapter });
}
