import type { Activity } from '../types/activity.js';

/**
 * Selects the single GSI1 feed for an ActivityIndex row (`data-model.md` §3.5).
 *
 * The order is the contract: recurrence wins over a date, a date wins over explicit
 * object intent, and only then does Task versus Plan distinguish Anytime from Needs a date.
 * Type and participants are deliberately not inputs.
 */
export function deriveGsi1Bucket(a: Activity): 'S' | 'P' | 'N' | 'R' {
  if (a.recurrence) return 'R';
  if (a.schedule?.date) return 'S';
  if (a.objectKind === 'plan') return 'P';
  return 'N';
}
