/**
 * Time is injected, never read from the ambient clock.
 *
 * Every event this adapter writes carries `occurred_at`, and the adapter's own
 * tests assert on recorded payloads. A module that calls `new Date()` directly is a
 * module whose behaviour cannot be replayed, so callers pass a clock — and the
 * default is the system clock, so the ordinary case stays one line.
 */

export interface Clock {
  now(): Date;
}

/** The production clock. Tests pass a fixed one instead. */
export const systemClock: Clock = Object.freeze({
  now: (): Date => new Date(),
});

/** A clock frozen at one instant. Exported because a caller replaying a run needs it. */
export function fixedClock(instant: string | Date): Clock {
  const frozen = typeof instant === "string" ? new Date(instant) : new Date(instant.getTime());
  if (Number.isNaN(frozen.getTime())) {
    throw new TypeError(`fixedClock: ${String(instant)} is not a valid instant`);
  }
  return Object.freeze({ now: (): Date => new Date(frozen.getTime()) });
}
