/**
 * Deterministic extractors.
 *
 * These run first, before any model, and they are the reason a well-structured
 * write costs nothing. Each one targets a shape where the authority is
 * mechanically checkable: an explicit preference form, a tool result, repository
 * metadata, or an unambiguous approval/rejection sentence.
 *
 * They are conservative by construction. A deterministic extractor that guesses
 * is worse than a model extractor that guesses, because its output looks
 * authoritative — it carries no model version, so a reader cannot tell that a
 * human-written heuristic produced it.
 */
import type { OriginKind } from "@veritymem/contracts";
import {
  codeUnitToByteOffset,
  type ExtractionInput,
  type Extractor,
  type ExtractorSpan,
  type Proposal,
  group,
  spanFromMatch,
  subjectKey,
} from "./extractor.ts";

/**
 * Explicit self-reports of preference or configuration.
 *
 * Matches only first-person, declarative statements. "I might prefer X for this
 * trip" is deliberately *not* matched: the hedge is the whole point, and a
 * deterministic extractor that strips it would convert a tentative remark into a
 * durable fact.
 */
export class PreferenceFormExtractor implements Extractor {
  readonly id = "preference-form@1";
  readonly isModelCall = false;
  readonly produces = ["preference", "user_self_report"] as const;

  private static readonly PATTERNS: readonly {
    readonly pattern: RegExp;
    readonly predicate: string;
    readonly subjectGroup: number;
    readonly objectGroup: number;
  }[] = [
    {
      // "my editor keymap is vim", "my preferred shell is zsh"
      pattern: /\bmy\s+(?:preferred\s+|default\s+)?([a-z][a-z0-9 ._-]{1,40}?)\s+is\s+(?!not\b)([^.;\n]{1,80})/gi,
      predicate: "preference",
      subjectGroup: 1,
      objectGroup: 2,
    },
    {
      // "I prefer tabs over spaces", "I prefer to deploy on Sundays"
      pattern: /\bI\s+prefer\s+(?:to\s+)?([^.;\n]{1,90})/gi,
      predicate: "preference",
      subjectGroup: 0,
      objectGroup: 1,
    },
    {
      // "I always use pnpm", "I never force-push"
      pattern: /\bI\s+(always|never)\s+([^.;\n]{1,80})/gi,
      predicate: "preference",
      subjectGroup: 0,
      objectGroup: 0,
    },
  ];

  async extract(input: ExtractionInput): Promise<readonly Proposal[]> {
    // Preferences asserted by a tool or a document are not self-reports, and
    // relabelling them as such would launder a third party's claim into the
    // user's voice.
    if (input.origin !== "user" && input.origin !== "agent") return [];

    const proposals: Proposal[] = [];
    for (const { pattern, predicate, subjectGroup, objectGroup } of PreferenceFormExtractor.PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match = regex.exec(input.content);
      while (match !== null) {
        const raw = group(match, objectGroup);
        if (raw !== null) {
          if (pattern.source.includes("always|never")) {
            const polarity = group(match, 1) ?? "always";
            const rest = group(match, 2);
            if (rest !== null) {
              proposals.push({
                kind: "preference",
                subject: subjectKey("user", input.actor_id),
                predicate,
                object: polarity === "never" ? `not ${rest}` : rest,
                spans: [spanFromMatch(match)],
                confidence: 0.9,
              });
            }
          } else if (subjectGroup === 0) {
            proposals.push({
              kind: "preference",
              subject: subjectKey("user", input.actor_id),
              predicate,
              object: raw,
              spans: [spanFromMatch(match)],
              confidence: 0.9,
            });
          } else {
            const subject = group(match, subjectGroup);
            if (subject !== null) {
              proposals.push({
                kind: "preference",
                subject: subjectKey("user", input.actor_id),
                predicate: `setting.${subject.toLowerCase().replace(/\s+/g, "_")}`,
                object: raw,
                spans: [spanFromMatch(match)],
                confidence: 0.9,
              });
            }
          }
        }
        match = regex.exec(input.content);
      }
    }
    return dedupe(proposals);
  }
}

/**
 * Structured tool results.
 *
 * When a tool reports its own outcome, the authority is `observation` and the
 * evidence is the tool's own output text. This is the highest-authority
 * unstructured path in the system: nothing here is inferred.
 */
export class ToolResultExtractor implements Extractor {
  readonly id = "tool-result@1";
  readonly isModelCall = false;
  readonly produces = ["observation"] as const;

  private static readonly PATTERNS: readonly {
    readonly pattern: RegExp;
    readonly predicate: string;
    readonly valueGroup: number;
  }[] = [
    { pattern: /\bexit\s*code[:\s]+(\d+)/gi, predicate: "process.exit_code", valueGroup: 1 },
    { pattern: /\bstatus[:\s]+(success|succeeded|failure|failed|pass|passed|fail|error|ok)\b/gi, predicate: "tool.status", valueGroup: 1 },
    { pattern: /\b(\d+)\s+(?:tests?|specs?)\s+(?:passed|passing)\b/gi, predicate: "tests.passed", valueGroup: 1 },
    { pattern: /\b(\d+)\s+(?:tests?|specs?)\s+(?:failed|failing)\b/gi, predicate: "tests.failed", valueGroup: 1 },
    { pattern: /\bcommit\s+([0-9a-f]{7,40})\b/gi, predicate: "commit.sha", valueGroup: 1 },
    { pattern: /\bbranch[:\s]+([A-Za-z0-9._/-]{1,120})/gi, predicate: "repo.branch", valueGroup: 1 },
    { pattern: /\bversion[:\s]+v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?)/gi, predicate: "release.version", valueGroup: 1 },
    { pattern: /\b(PR|pull request)\s+#?(\d{1,7})\b/gi, predicate: "pr.number", valueGroup: 2 },
    { pattern: /\bissue\s+#?(\d{1,7})\b/gi, predicate: "issue.number", valueGroup: 1 },
    { pattern: /\bhttps?:\/\/([^\s/]+)\/([^\s]+)/gi, predicate: "reference.url", valueGroup: 0 },
  ];

  async extract(input: ExtractionInput): Promise<readonly Proposal[]> {
    if (input.origin !== "tool" && input.origin !== "database") return [];
    const proposals: Proposal[] = [];
    for (const { pattern, predicate, valueGroup } of ToolResultExtractor.PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match = regex.exec(input.content);
      while (match !== null) {
        const value = group(match, valueGroup);
        if (value !== null) {
          proposals.push({
            kind: "observation",
            subject: subjectKey("tool", input.actor_id),
            predicate,
            object: value,
            spans: [spanFromMatch(match)],
            confidence: 0.98,
          });
        }
        match = regex.exec(input.content);
      }
    }
    return dedupe(proposals);
  }
}

/**
 * Explicit approvals and rejections.
 *
 * This is the shape the reference workload turns on: "I approved the Sunday
 * 02:00 UTC deploy window." It requires a first-person verb and a specific
 * object, because an approval with no object is a sentiment, not a decision.
 */
export class DecisionStatementExtractor implements Extractor {
  readonly id = "decision-statement@1";
  readonly isModelCall = false;
  readonly produces = ["decision", "event"] as const;

  private static readonly PATTERNS: readonly {
    readonly pattern: RegExp;
    readonly predicate: string;
    readonly objectGroup: number;
  }[] = [
    {
      pattern: /\bI\s+approv(?:e|ed)\s+(?:the\s+)?([^.;\n]{3,120})/gi,
      predicate: "approved",
      objectGroup: 1,
    },
    {
      pattern: /\bI\s+reject(?:ed)?\s+(?:the\s+)?([^.;\n]{3,120})/gi,
      predicate: "rejected",
      objectGroup: 1,
    },
    {
      pattern: /\bwe\s+(?:have\s+)?decided\s+(?:to\s+)?([^.;\n]{3,120})/gi,
      predicate: "decided",
      objectGroup: 1,
    },
    {
      pattern: /\bdeadline\s+is\s+([^.;\n]{3,80})/gi,
      predicate: "deadline",
      objectGroup: 1,
    },
  ];

  async extract(input: ExtractionInput): Promise<readonly Proposal[]> {
    if (input.origin !== "user" && input.origin !== "agent") return [];
    const proposals: Proposal[] = [];
    for (const { pattern, predicate, objectGroup } of DecisionStatementExtractor.PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match = regex.exec(input.content);
      while (match !== null) {
        const value = group(match, objectGroup);
        if (value !== null) {
          proposals.push({
            kind: "decision",
            subject: subjectKey("user", input.actor_id),
            predicate,
            object: value,
            spans: [spanFromMatch(match)],
            confidence: 0.92,
          });
        }
        match = regex.exec(input.content);
      }
    }
    return dedupe(proposals);
  }
}

/**
 * Repository and release metadata.
 *
 * Treated as `verified_record` authority only when the origin is a tool or a
 * database. The same string in a document is hearsay, and the authority class
 * follows the origin, not the shape of the text.
 */
export class RepositoryMetadataExtractor implements Extractor {
  readonly id = "repo-metadata@1";
  readonly isModelCall = false;
  readonly produces = ["observation", "event"] as const;

  async extract(input: ExtractionInput): Promise<readonly Proposal[]> {
    const proposals: Proposal[] = [];
    const repo = /\brepo(?:sitory)?[:\s]+([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/gi;
    let match = repo.exec(input.content);
    while (match !== null) {
      const value = group(match, 1);
      if (value !== null) {
        proposals.push({
          kind: "observation",
          subject: subjectKey("repo", value),
          predicate: "repo.identifier",
          object: value,
          spans: [spanFromMatch(match)],
          confidence: 0.95,
        });
      }
      match = repo.exec(input.content);
    }

    const tag = /\b(?:released|tagged|shipped)\s+v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?)/gi;
    match = tag.exec(input.content);
    while (match !== null) {
      const value = group(match, 1);
      if (value !== null) {
        proposals.push({
          kind: "event",
          subject: subjectKey("repo", input.actor_id),
          predicate: "release.version",
          object: value,
          spans: [spanFromMatch(match)],
          confidence: 0.9,
        });
      }
      match = tag.exec(input.content);
    }

    return dedupe(proposals);
  }
}

/**
 * An executable procedure stated as a command.
 *
 * This exists specifically so the *gate* has something to quarantine. A
 * deterministic extractor that recognises `run X` and produces a `procedure`
 * candidate is the honest design: the alternative is that procedures arrive
 * silently through the model extractor, where nothing marks them as privileged.
 */
export class ProcedureStatementExtractor implements Extractor {
  readonly id = "procedure-statement@1";
  readonly isModelCall = false;
  readonly produces = ["procedure", "permission"] as const;

  private static readonly PATTERNS: readonly { pattern: RegExp; kind: "procedure" | "permission"; predicate: string }[] = [
    { pattern: /\b(?:run|execute)\s+`([^`]{3,200})`/gi, kind: "procedure", predicate: "run_command" },
    { pattern: /\b(?:you|the agent)\s+(?:must|should)\s+(?:run|execute)\s+([^.;\n]{3,200})/gi, kind: "procedure", predicate: "run_command" },
    { pattern: /\b(?:grant|give)\s+([A-Za-z0-9._:@-]{2,60})\s+(?:admin|owner|write|root)\s+(?:access|permission|privileges?)/gi, kind: "permission", predicate: "grant_access" },
    { pattern: /\badd\s+([A-Za-z0-9._:@-]{2,60})\s+to\s+(?:the\s+)?(?:admins?|owners?|maintainers?)\b/gi, kind: "permission", predicate: "grant_role" },
  ];

  async extract(input: ExtractionInput): Promise<readonly Proposal[]> {
    const proposals: Proposal[] = [];
    for (const { pattern, kind, predicate } of ProcedureStatementExtractor.PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match = regex.exec(input.content);
      while (match !== null) {
        const value = group(match, 1);
        if (value !== null) {
          proposals.push({
            kind,
            subject: input.external ? subjectKey("doc", input.actor_id) : subjectKey("user", input.actor_id),
            predicate,
            object: value,
            spans: [spanFromMatch(match)],
            // Confidence is deliberately not set: a deterministic match on an
            // imperative sentence says nothing about whether the instruction is
            // legitimate, and reporting a number here would invite thresholding.
            ...(input.external ? { authority: "hearsay" as const } : {}),
          });
        }
        match = regex.exec(input.content);
      }
    }
    return dedupe(proposals);
  }
}

/**
 * The deterministic extractor set, in the order the write path runs them.
 *
 * Order matters for cost, not for correctness: the cheap structured passes run
 * before the pattern passes, and the procedure pass runs last so that its
 * privileged candidates are visibly distinguished in the decision trace.
 */
export const DETERMINISTIC_EXTRACTORS: readonly Extractor[] = [
  new ToolResultExtractor(),
  new PreferenceFormExtractor(),
  new DecisionStatementExtractor(),
  new RepositoryMetadataExtractor(),
  new ProcedureStatementExtractor(),
];

function dedupe(proposals: readonly Proposal[]): Proposal[] {
  const seen = new Set<string>();
  const out: Proposal[] = [];
  for (const proposal of proposals) {
    const key = `${proposal.kind}|${proposal.subject}|${proposal.predicate}|${JSON.stringify(proposal.object)}|${proposal.spans.map((s) => `${s.start}-${s.end}`).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(proposal);
  }
  return out;
}

/** Exported for tests that need to assert the ordering guarantee. */
export const DETERMINISTIC_EXTRACTOR_IDS: readonly string[] = DETERMINISTIC_EXTRACTORS.map((e) => e.id);

/** Origin kinds whose content is external, and therefore data rather than instruction. */
export function isExternalOrigin(origin: OriginKind): boolean {
  return origin === "document" || origin === "database";
}

export { codeUnitToByteOffset, type ExtractorSpan };
