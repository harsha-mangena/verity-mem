#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Separate from `cli.ts` so that importing the CLI — for argument-parsing tests —
 * does not run a benchmark as a side effect. `main()` is pure until it is called.
 */
import { main } from "./cli.ts";

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `perf benchmark failed: ${(error as Error).message}\n${(error as Error).stack ?? ""}\n`,
    );
    process.exitCode = 2;
  });
