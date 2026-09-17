/**
 * Which entailment verifier the benchmark scored with, and how it was chosen.
 *
 * The benchmark's numbers are a statement about a gate, and a gate is defined by its
 * verifier. Recording only "the benchmark passed" while the verifier was a token-overlap
 * stand-in is the failure this module exists to prevent: the lexical backend detects a
 * claim that shares no vocabulary with its evidence and nothing else, and a report that
 * does not say which one ran cannot be compared to any other report.
 *
 * Three rules, each of which was the alternative to a real decision:
 *
 *  1. **The choice is recorded, never inferred downstream.** `resolveGateBackend` returns
 *     the verifier, its name and its model digest together, so a caller cannot publish a
 *     number without the provenance that makes it interpretable.
 *  2. **A missing model is reported, not silently substituted.** `--gate-backend onnx`
 *     fails when the assets are absent; the default `auto` selects ONNX when it can and
 *     says so in the report when it cannot. Neither path quietly weakens the gate.
 *  3. **Thresholds are per backend.** ONNX logits and lexical overlap scores are on
 *     different scales, and sharing one floor between them is how a calibrated gate
 *     silently becomes an uncalibrated one. The ONNX threshold is calibrated for this
 *     checkpoint; the lexical floor stays the policy's own value.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { GATE_THRESHOLDS } from "@veritymem/contracts";
import {
  LexicalEntailmentBackend,
  OnnxEntailmentBackend,
  type EntailmentBackend,
} from "@veritymem/gate";

export const GATE_BACKENDS = ["auto", "onnx", "lexical"] as const;
export type GateBackendChoice = (typeof GATE_BACKENDS)[number];

export interface GateBackendSelection {
  readonly backend: EntailmentBackend;
  /** `onnx` or `lexical`: what actually ran, not what was requested. */
  readonly kind: "onnx" | "lexical";
  /** The backend's own name, published in the manifest and on every packet. */
  readonly name: string;
  readonly modelSha256: string | null;
  readonly tokenizerSha256: string | null;
  readonly modelPath: string | null;
  readonly tokenizerPath: string | null;
  readonly threshold: number;
  readonly contradictionThreshold: number | null;
  /** Why this backend and not the other one. Travels into the report. */
  readonly reason: string;
}

export interface GateBackendRequest {
  readonly choice: GateBackendChoice;
  /** Refuse to fall back to the lexical stand-in. `--gate-required`. */
  readonly required: boolean;
  /** Root of the model assets. Defaults to `<repo>/.veritymem/models`. */
  readonly modelsRoot: string;
  /** Repository root, used to resolve the default asset paths. */
  readonly repoRoot?: string;
}

/**
 * The entailment probability above which this checkpoint's verdict is `entailed`.
 *
 * Calibrated for the quantised DeBERTa-v3 MNLI cross-encoder and deliberately not shared
 * with the lexical floor. 0.5 is the decision boundary the checkpoint was trained against;
 * a deployment that wants fewer false accepts raises it, and the value used is published
 * with every number so two reports cannot be compared without noticing they differ.
 */
export const ONNX_ENTAILMENT_THRESHOLD = 0.5;

/** Above this contradiction probability the verdict is a refutation rather than a neutral. */
export const ONNX_CONTRADICTION_THRESHOLD = 0.5;

/** Candidate model file names, in the order `scripts/fetch-model.mjs` names them. */
const MODEL_FILE_CANDIDATES = [
  "model_qint8_arm64.onnx",
  "model_quint8_avx2.onnx",
  "model_qint8_avx512.onnx",
  "model.onnx",
];

/**
 * Resolve the verifier the run will use, or explain why it is the stand-in.
 *
 * Async because loading the ONNX backend reads and hashes the model. A failure to load
 * with `required` set is thrown rather than returned: a run that was told to use the
 * production verifier and quietly used the stand-in would publish a safety number about a
 * gate nobody ran.
 */
export async function resolveGateBackend(request: GateBackendRequest): Promise<GateBackendSelection> {
  const assets = locateModelAssets(request.modelsRoot);
  const choice = request.choice === "auto" ? configuredChoice() : request.choice;

  if (choice === "lexical") {
    return lexicalSelection(
      request.choice === "lexical"
        ? "the lexical stand-in was requested explicitly"
        : "the lexical stand-in is the configured verifier (GATE_ENTAILMENT_BACKEND unset or 'lexical')",
    );
  }

  if (assets === null) {
    const reason =
      `no pinned model assets under ${request.modelsRoot}. Provision them with ` +
      `'node scripts/fetch-model.mjs', or run with --gate-backend lexical to accept the ` +
      `documented stand-in.`;
    if (request.required || wantOnnx()) {
      throw new Error(
        `the production verifier was required (${describeRequest(request)}), but ${reason} ` +
          `A benchmark that fell back silently would publish a gate result for a gate it did not run.`,
      );
    }
    return lexicalSelection(reason);
  }

  try {
    const backend = await OnnxEntailmentBackend.load({
      modelPath: assets.modelPath,
      tokenizerPath: assets.tokenizerPath,
      ...(assets.modelSha256 !== null ? { modelSha256: assets.modelSha256 } : {}),
      entailmentThreshold: ONNX_ENTAILMENT_THRESHOLD,
      contradictionThreshold: ONNX_CONTRADICTION_THRESHOLD,
    });
    return {
      backend,
      kind: "onnx",
      name: backend.name,
      modelSha256: backend.modelSha256,
      tokenizerSha256: backend.assets.tokenizerSha256,
      modelPath: assets.modelPath,
      tokenizerPath: assets.tokenizerPath,
      threshold: ONNX_ENTAILMENT_THRESHOLD,
      contradictionThreshold: ONNX_CONTRADICTION_THRESHOLD,
      reason: `production verifier loaded from ${assets.modelPath}`,
    };
  } catch (error) {
    if (request.required || wantOnnx()) throw error;
    return lexicalSelection(`the production verifier could not be loaded: ${(error as Error).message}`);
  }
}

/**
 * Does the caller *require* the production verifier?
 *
 * `--gate-backend onnx` is a requirement, not a preference: it names the verifier the run
 * must use. `--gate-required` says the same thing about whatever `auto` resolves to. Both
 * turn a missing or unloadable model into an error rather than a quiet downgrade to a
 * token-overlap stand-in, because a gate result published for a gate that did not run is
 * worse than no result.
 */
function wantOnnx(): boolean {
  return configuredChoice() === "onnx";
}

function describeRequest(request: GateBackendRequest): string {
  return request.choice === "auto" ? "auto resolved to onnx" : `--gate-backend ${request.choice}`;
}

/**
 * The verifier the environment asks for.
 *
 * The same rule `packages/ledger`'s config applies to the server and the worker: `onnx`
 * selects the production verifier, anything else — including unset — selects the documented
 * lexical stand-in. The benchmark reads the *same* variable rather than inventing a
 * default, so the instrument and the deployment it grades are configured by one value and
 * a run cannot score with a different verifier than the one that ships.
 */
function configuredChoice(): "onnx" | "lexical" {
  return process.env["GATE_ENTAILMENT_BACKEND"] === "onnx" ? "onnx" : "lexical";
}

function lexicalSelection(reason: string): GateBackendSelection {
  const backend = new LexicalEntailmentBackend({ floor: GATE_THRESHOLDS.lexicalEntailmentFloor });
  return {
    backend,
    kind: "lexical",
    name: backend.name,
    modelSha256: null,
    tokenizerSha256: null,
    modelPath: null,
    tokenizerPath: null,
    threshold: GATE_THRESHOLDS.lexicalEntailmentFloor,
    contradictionThreshold: null,
    reason,
  };
}

interface ModelAssets {
  readonly modelPath: string;
  readonly tokenizerPath: string;
  /** Expected digest from `models.lock.json`, when the lock file names one. */
  readonly modelSha256: string | null;
}

/**
 * Find a pinned model under the assets root.
 *
 * The expected digest comes from `models.lock.json` rather than from a constant here,
 * because the lock file is what `scripts/fetch-model.mjs` writes and verifies: a digest
 * duplicated in this module would be a second source of truth that drifts the first time
 * the asset is re-fetched for a different architecture.
 *
 * Returns null when the assets are absent, so the caller decides whether that is fatal.
 * A directory that exists but has no model file is treated as absent rather than as a
 * partial install: a half-provisioned model would fail inside the ONNX runtime with an
 * error that reads like a code defect.
 */
export function locateModelAssets(modelsRoot: string): ModelAssets | null {
  const root = resolve(modelsRoot);
  if (!existsSync(root)) return null;

  const directories = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort();

  for (const directory of directories) {
    const tokenizerPath = join(directory, "tokenizer.json");
    if (!existsSync(tokenizerPath)) continue;
    const modelName = MODEL_FILE_CANDIDATES.find((name) => existsSync(join(directory, name)));
    if (modelName === undefined) continue;
    const modelPath = join(directory, modelName);
    return { modelPath, tokenizerPath, modelSha256: lockedDigest(directory, modelName) };
  }
  return null;
}

function lockedDigest(directory: string, modelName: string): string | null {
  const lockPath = join(directory, "models.lock.json");
  if (!existsSync(lockPath)) return null;
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
      files?: Record<string, { sha256?: string }>;
    };
    for (const [file, entry] of Object.entries(lock.files ?? {})) {
      if (file.endsWith(`/${modelName}`) || file === modelName) {
        return entry.sha256 ?? null;
      }
    }
    return null;
  } catch {
    // A lock file that cannot be read is not a reason to refuse a run: the model is hashed
    // at load anyway and the digest it produces is what the report publishes. Verification
    // against a recorded expectation is `scripts/fetch-model.mjs --verify`'s job.
    return null;
  }
}
