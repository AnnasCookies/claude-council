import { HUMAN_ROUTE } from './schema';

/** One seat's verdict on one item, attributed to the seat that gave it. */
export interface TriageVerdict {
  readonly seat: string;
  readonly class: string;
  readonly severity: string;
  readonly route: string;
  readonly confidence: number;
  readonly reason: string;
}

export interface TriageRouting {
  readonly agreed: boolean;
  readonly route: string;
}

/**
 * The whole routing rule, and the only place it lives.
 *
 * Seats that agree on class and route route there. Seats that disagree on either are never
 * averaged, never reconciled and never out-voted by confidence: the item goes to a human with
 * `agreed: false`, and both verdicts stay in the output so the disagreement is visible rather
 * than resolved inside the engine. One valid verdict routes alone — a single-seat desk has
 * nothing to disagree with, and `agreed` then says only that no valid verdict contradicted
 * another. No valid verdict is not a routing decision at all, so the caller gets `null` and the
 * item joins `unprocessed`: the desk never routes an item it did not read.
 *
 * Severity is deliberately outside the rule. Two seats that call an item a bug to be fixed have
 * agreed about where it goes; that one thinks it worse than the other is a detail of their
 * verdicts, which the output keeps in full.
 */
export function routeItem(verdicts: readonly TriageVerdict[]): TriageRouting | null {
  const first = verdicts[0];
  if (first === undefined) return null;
  const agreed = verdicts.every(
    (verdict) => verdict.class === first.class && verdict.route === first.route,
  );
  return agreed ? { agreed, route: first.route } : { agreed, route: HUMAN_ROUTE };
}
