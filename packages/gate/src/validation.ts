/**
 * Span-level validation, separated from policy.
 *
 * Validation answers "is this candidate well-formed and does its evidence
 * exist?". Policy answers "should the system believe it?". Keeping them apart
 * means a policy change never weakens the integrity checks, and an operator
 * reading a decision can tell which kind of rule fired.
 */
import { REASON_CODES } from "@veritymem/contracts";
import type { Ledger, QueryExecutor, SpanRecord, SpanVerification } from "@veritymem/ledger";

export interface SpanValidationInput {
  readonly span: SpanRecord;
  readonly role: "supports" | "refutes";
}

export interface SpanValidationResult {
  readonly span_id: string;
  readonly role: "supports" | "refutes";
  readonly valid: boolean;
  readonly status: SpanVerification["status"];
  readonly reason_codes: readonly string[];
  readonly quote: string | null;
  readonly quote_matches_stored: boolean;
}

export interface ValidationReport {
  readonly spans: readonly SpanValidationResult[];
  readonly supporting_count: number;
  readonly refuting_count: number;
  readonly valid_supporting_count: number;
  /** True when at least one supporting span resolved with a matching digest. */
  readonly has_valid_support: boolean;
  readonly reason_codes: readonly string[];
}

/**
 * Validate every cited span against the ledger's current bytes.
 *
 * A span whose stored quote disagrees with the bytes at its offsets is reported
 * as `quote_matches_stored: false`. That is a distinct failure from a digest
 * mismatch: the digest covers the offsets, so a disagreement here means the
 * `quote` column was written by something other than the span writer.
 */
export async function validateSpans(
  ledger: Ledger,
  executor: QueryExecutor,
  spans: readonly SpanValidationInput[],
): Promise<ValidationReport> {
  if (spans.length === 0) {
    return {
      spans: [],
      supporting_count: 0,
      refuting_count: 0,
      valid_supporting_count: 0,
      has_valid_support: false,
      reason_codes: [REASON_CODES.NO_SUPPORTING_EVIDENCE],
    };
  }

  const verifications = await ledger.verifySpans(
    executor,
    spans.map((entry) => entry.span),
  );

  const results: SpanValidationResult[] = [];
  for (const entry of spans) {
    const verification = verifications.get(entry.span.span_id);
    const status = verification?.status ?? "missing";
    const codes: string[] = [];
    let quote: string | null = null;
    let matches = false;

    switch (status) {
      case "ok": {
        codes.push(REASON_CODES.SPAN_RESOLVED);
        quote = verification && "quote" in verification ? verification.quote : null;
        matches = quote === entry.span.quote;
        if (!matches) codes.push(REASON_CODES.SPAN_DIGEST_MISMATCH);
        break;
      }
      case "redacted":
        codes.push(REASON_CODES.SPAN_EVENT_REDACTED, REASON_CODES.SPAN_UNRESOLVABLE);
        break;
      case "digest_mismatch":
        codes.push(REASON_CODES.SPAN_DIGEST_MISMATCH, REASON_CODES.SPAN_UNRESOLVABLE);
        break;
      case "out_of_bounds":
        codes.push(REASON_CODES.SPAN_OUT_OF_BOUNDS, REASON_CODES.SPAN_UNRESOLVABLE);
        break;
      case "missing":
        codes.push(REASON_CODES.SPAN_UNRESOLVABLE);
        break;
    }

    results.push({
      span_id: entry.span.span_id,
      role: entry.role,
      valid: status === "ok" && matches,
      status,
      reason_codes: codes,
      quote,
      quote_matches_stored: matches,
    });
  }

  const supporting = results.filter((entry) => entry.role === "supports");
  const refuting = results.filter((entry) => entry.role === "refutes");
  const validSupporting = supporting.filter((entry) => entry.valid);

  const reasonCodes: string[] = [];
  if (supporting.length === 0) reasonCodes.push(REASON_CODES.NO_SUPPORTING_EVIDENCE);

  return {
    spans: results,
    supporting_count: supporting.length,
    refuting_count: refuting.length,
    valid_supporting_count: validSupporting.length,
    has_valid_support: validSupporting.length > 0,
    reason_codes: reasonCodes,
  };
}

/**
 * Concatenate the text of the valid supporting spans, in span order.
 *
 * This is the premise the entailment check runs against. It is the whole support
 * set rather than one span, because a claim can legitimately require two
 * sentences to establish.
 */
export function supportingPremise(report: ValidationReport): string {
  return report.spans
    .filter((entry) => entry.role === "supports" && entry.valid && entry.quote !== null)
    .map((entry) => entry.quote as string)
    .join("\n");
}
