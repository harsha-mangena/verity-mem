/**
 * A fixture that does not parse is a bug in the fixture, not a skipped test.
 *
 * The error carries the file and the 1-based line number because a 3 a.m. failure
 * that says "invalid expectation" without a location is worse than no fixture at
 * all: it invites the reader to delete the line.
 */
export class FixtureParseError extends Error {
  readonly file: string;
  readonly line: number;
  readonly code: string;

  constructor(file: string, line: number, code: string, message: string) {
    super(`${file}:${line}: ${message}`);
    this.name = "FixtureParseError";
    this.file = file;
    this.line = line;
    this.code = code;
  }
}

/** Every parse failure is one of a closed set, so a CI summary can group them. */
export type FixtureErrorCode =
  | "not_json"
  | "not_an_object"
  | "missing_header"
  | "duplicate_header"
  | "unsupported_version"
  | "unknown_suite"
  | "unknown_action"
  | "missing_field"
  | "wrong_type"
  | "empty_value"
  | "unknown_reason_code"
  | "unknown_vocabulary"
  | "bad_instant"
  | "bad_span"
  | "duplicate_line_id"
  | "empty_expectation"
  | "unsupported_expectation"
  | "io";
