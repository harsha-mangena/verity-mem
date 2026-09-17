#!/usr/bin/env node
/**
 * Fetch the entailment model and its tokenizer, and pin them by digest.
 *
 * The weights are 233 MB and are not committed, so the production verifier needs an
 * explicit provisioning step. This script exists so that step is one documented command
 * with a verifiable result rather than an undocumented manual download, and so the digests
 * a deployment pins are the digests of the bytes it actually has.
 *
 * It writes `models.lock.json` next to the assets. `verify.sh` reports whether the
 * production verifier can run, and the lock file is what makes that answer checkable
 * rather than a matter of whether a directory happens to exist.
 *
 *   node scripts/fetch-model.mjs                       # arm64 quantised (default on Apple silicon)
 *   node scripts/fetch-model.mjs --variant avx2        # x86-64 quantised
 *   node scripts/fetch-model.mjs --verify              # check digests only, no download
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REPO = "cross-encoder/nli-deberta-v3-base";
const DIR = ".veritymem/models/nli-deberta-v3-base";

// One quantised export per architecture. The full-precision export is 738 MB and is not
// the default: the gate budget in the specification is 25-60 ms per candidate on CPU.
const VARIANTS = {
  arm64: "onnx/model_qint8_arm64.onnx",
  avx2: "onnx/model_quint8_avx2.onnx",
  avx512: "onnx/model_qint8_avx512.onnx",
};

const args = process.argv.slice(2);
const verifyOnly = args.includes("--verify");
const variantArg = args.indexOf("--variant");
const variant = variantArg >= 0 ? args[variantArg + 1] : "arm64";

if (!(variant in VARIANTS)) {
  console.error(`unknown variant ${variant}; choose one of ${Object.keys(VARIANTS).join(", ")}`);
  process.exit(2);
}

// The tokenizer assets are small and required for any variant.
const COMMON = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"];
const files = [VARIANTS[variant], ...COMMON];
const lockPath = join(DIR, "models.lock.json");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

await mkdir(DIR, { recursive: true });

const lock = existsSync(lockPath)
  ? JSON.parse(await readFile(lockPath, "utf8"))
  : { repo: REPO, variant, files: {} };

let failures = 0;

for (const file of files) {
  const target = join(DIR, file.split("/").pop());
  const present = existsSync(target);
  const recorded = lock.files[file]?.sha256 ?? null;

  if (verifyOnly) {
    if (!present) {
      console.error(`MISSING  ${file} (expected at ${target})`);
      failures += 1;
      continue;
    }
    const actual = sha256(await readFile(target));
    if (recorded && recorded !== actual) {
      console.error(`MISMATCH ${file}: recorded ${recorded.slice(0, 16)}, actual ${actual.slice(0, 16)}`);
      failures += 1;
    } else {
      console.log(`ok       ${file} ${actual.slice(0, 16)}`);
    }
    continue;
  }

  if (!present) {
    const url = `https://huggingface.co/${REPO}/resolve/main/${file}`;
    process.stdout.write(`fetching ${file} ... `);
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
      console.error(`failed: ${response.status} ${response.statusText}`);
      process.exit(1);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(target, bytes);
    console.log(`${bytes.length} bytes`);
  }

  const actual = sha256(await readFile(target));
  if (recorded && recorded !== actual) {
    console.error(
      `MISMATCH ${file}: recorded ${recorded.slice(0, 16)}, actual ${actual.slice(0, 16)}. ` +
        `Refusing to update the lock file silently — delete ${target} and re-run if the upstream asset legitimately changed.`,
    );
    process.exit(1);
  }
  lock.files[file] = { sha256: actual, bytes: (await readFile(target)).length };
}

if (verifyOnly) {
  console.log(failures === 0 ? "\nmodel assets verified" : `\n${failures} problem(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

lock.variant = variant;
lock.verified_at = new Date().toISOString();
await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
console.log(`\nwrote ${lockPath}`);
console.log("GATE_ENTAILMENT_BACKEND=onnx");
console.log(`GATE_MODEL_PATH=${DIR}/${VARIANTS[variant].split("/").pop()}`);
console.log(`GATE_TOKENIZER_PATH=${DIR}/tokenizer.json`);
console.log(`GATE_MODEL_SHA256=${lock.files[VARIANTS[variant]].sha256}`);
