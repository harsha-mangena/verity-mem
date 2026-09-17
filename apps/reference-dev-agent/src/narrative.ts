/**
 * Narrative output for the reference workload.
 *
 * Plain text on stdout, not JSON: the specification calls this workload the
 * go-to-market wedge, which means its primary reader is a person deciding whether
 * the architecture does what it claims. The machine-readable form is the database
 * itself — every line printed here is read back out of `events`, `claims`,
 * `decisions`, `claim_evidence` or a retention manifest, and `--json` prints the
 * whole `ReferenceRun` for anything that wants to diff two runs.
 *
 * `write` is injectable so the test can capture the narrative and assert *what the
 * run printed*, not just what it computed. A demo whose printed numbers could drift
 * from its assertions would be the exact failure this project criticises.
 */

export interface NarrativeOptions {
  readonly write: (line: string) => void;
}

const RULE = "─".repeat(78);

export function createNarrative(options: NarrativeOptions): {
  step(step: number, name: string, detail: Record<string, unknown>): void;
  header(lines: readonly string[]): void;
  section(title: string): void;
  raw(line: string): void;
} {
  const out = options.write;

  const render = (value: unknown): string => {
    if (value === null || value === undefined) return "(none)";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return value.length === 0 ? "[]" : value.map(render).join(", ");
    return JSON.stringify(value);
  };

  return {
    raw: (line) => out(line),
    header(lines) {
      out(RULE);
      for (const line of lines) out(line);
      out(RULE);
    },
    section(title) {
      out("");
      out(title);
      out("─".repeat(title.length));
    },
    step(step, name, detail) {
      out("");
      out(`STEP ${step}. ${name}`);
      for (const [key, value] of Object.entries(detail)) {
        const text = render(value);
        // Long values (reason-code lists, `missing` arrays) are indented onto their
        // own line so the narrative stays scannable and nothing is truncated. A
        // truncated reason code is worse than a long line: it reads as a different
        // code.
        if (text.length > 72 || text.includes("\n")) {
          out(`  ${key}:`);
          for (const part of wrap(text, 72)) out(`      ${part}`);
        } else {
          out(`  ${key}: ${text}`);
        }
      }
    },
  };
}

/** Wrap a string at `width` characters, on whitespace where possible. */
export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

/** Signed percentage with two decimals, which is the precision the ceiling needs. */
export function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}
