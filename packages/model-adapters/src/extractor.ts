/**
 * The extractor contract.
 *
 * Two rules, and both are enforced by the types rather than by discipline:
 *
 *  1. An extractor returns *proposals*. It has no handle to the claim store and
 *     cannot express "accepted", so the invariant that no model call sets
 *     `status = accepted` is a property of the interface, not a promise.
 *  2. Every proposal carries exact byte offsets. A proposal without spans cannot
 *     be constructed, because a claim with no evidence is not a weaker claim, it
 *     is an unfalsifiable one.
 */
import type { AuthorityClass, ClaimKind, EvidenceRole, OriginKind } from "@veritymem/contracts";

export interface ExtractorSpan {
  /** Byte offset into the event payload, inclusive. */
  readonly start: number;
  /** Byte offset into the event payload, exclusive. */
  readonly end: number;
  readonly role?: EvidenceRole;
  readonly selector?: string;
}

export interface Proposal {
  readonly kind: ClaimKind;
  readonly subject: string;
  readonly predicate: string;
  readonly object: unknown;
  readonly spans: readonly ExtractorSpan[];
  readonly authority?: AuthorityClass;
  readonly confidence?: number;
  /**
   * A scope narrower than the originating event's scope. An extractor may only
   * ever narrow: a proposal that names a dimension the event did not bind is
   * caught by the gate and downgraded, never upgraded.
   */
  readonly requested_scope?: {
    readonly project?: string;
    readonly user?: string;
    readonly agent?: string;
    readonly session?: string;
    readonly purpose?: readonly string[];
  };
  /** Set by model extractors so the gate can record which prompt produced this. */
  readonly prompt_version?: string;
}

export interface ExtractionInput {
  /**
   * The event payload as raw bytes. Extractors work in bytes because offsets are
   * bytes: a JavaScript string index is a UTF-16 code-unit offset and would
   * silently disagree with the stored span for any non-ASCII content.
   */
  readonly content: string;
  readonly origin: OriginKind;
  readonly actor_id: string;
  readonly media_type: string;
  /** True when admission flagged instruction-like material from an external origin. */
  readonly instruction_flagged: boolean;
  /** True when the origin is external, so procedure/permission extraction is refused. */
  readonly external: boolean;
}

export interface Extractor {
  /** `name@version`; recorded on every candidate and therefore on every claim. */
  readonly id: string;
  /**
   * Whether this extractor makes a model call. The write path holds the line at
   * one extraction call per unstructured event, and this is how that is counted.
   */
  readonly isModelCall: boolean;
  /** Claim kinds this extractor is capable of producing, for admission routing. */
  readonly produces: readonly ClaimKind[];
  extract(input: ExtractionInput): Promise<readonly Proposal[]>;
}

/**
 * Convert a code-unit index into a byte offset.
 *
 * `TextEncoder` allocates, so this walks the string and counts bytes directly.
 * For ASCII — the overwhelmingly common case — the two are equal and the loop is
 * a single length check.
 */
export function codeUnitToByteOffset(text: string, codeUnitIndex: number): number {
  if (codeUnitIndex <= 0) return 0;
  if (codeUnitIndex >= text.length) return Buffer.byteLength(text, "utf8");
  return Buffer.byteLength(text.slice(0, codeUnitIndex), "utf8");
}

/** Build a proposal span from a regex match over the payload. */
export function spanFromMatch(match: RegExpExecArray, role: EvidenceRole = "supports"): ExtractorSpan {
  return {
    start: codeUnitToByteOffset(match.input, match.index),
    end: codeUnitToByteOffset(match.input, match.index + match[0].length),
    role,
  };
}

/**
 * Extract the capture group text as a value, trimmed. Returns null when the group
 * did not participate, so a caller cannot accidentally build a claim from
 * `undefined`.
 */
export function group(match: RegExpExecArray, index: number): string | null {
  const value = match[index];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Normalise a person or system identifier into a `type:name` subject key. */
export function subjectKey(kind: "user" | "service" | "repo" | "tool" | "doc", name: string): string {
  const cleaned = name.trim().replace(/\s+/g, " ").replace(/[.,;:]+$/, "");
  return `${kind}:${cleaned.toLowerCase()}`;
}
