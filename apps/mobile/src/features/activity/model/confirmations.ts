import { type ChangeTarget, changeActivityKind } from '@od/shared';
import type { Activity, ActivityType, PlanType } from '@od/shared/types';
import { planKindLabel } from '@/lib/planKinds';

/**
 * What a destructive confirmation says (P1-27).
 *
 * `interaction-contract.md` §1a.1 owns the shape and is emphatic about why: a dialog reading
 * `Are you sure?`, `This can't be undone.` alone, or `Delete items?` is **a defect, not a
 * style choice**, because the user cannot weigh a decision they have not been told the size
 * of. So this module's job is to produce the numbers and the field names, and it is pure so
 * that the copy can be asserted without rendering anything.
 *
 * Two rules from §1a.1 that shape the return type:
 *
 * - **A conditional confirmation that can appear with a count of 0 is a bug.** A kind change
 *   that drops nothing is additive, so `kindChangeConfirmation` returns `undefined` and the
 *   caller applies the change immediately.
 * - **Deletions always confirm**, even when the thing being deleted is empty — so
 *   `deleteConfirmation` always returns one.
 */
export interface Confirmation {
  /** Names the object and the change: `Delete "Paris weekend"?` */
  heading: string;
  /** `This removes:` for a deletion, `This will remove:` for a change (§6.3, §6.4). */
  removesLead: string;
  /**
   * One entry is rendered as a prose sentence after the lead; several are rendered as a
   * list. Deletion names its losses in a sentence and a kind change lists them by field,
   * which is how `activities.md` §6.3 and §6.4 write them.
   */
  removes: string[];
  /** Present whenever anything survives (§1a.1: "the `Keeps:` line, whenever anything does"). */
  keeps?: string;
  /** The destructive button. **Repeats the verb** — never `OK`, never `Continue`. */
  confirmLabel: string;
}

/** `a, b and c` — no Oxford comma, matching the copy in `activities.md` §6.4. */
function sentenceList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * `Delete "<title>"?` (`activities.md` §6.4).
 *
 * Every count is real and taken from the Activity itself. What Phase 1 can honestly count is
 * the notes, the caller's own reminders, and the prep children — attachments are Phase 3 and
 * are not on the stored Activity, the shared-plan line is Phase 6, and the settled-expense
 * block is Phase 7. Each of those adds a line here when its phase lands; none of them is
 * silently approximated now.
 */
export function deleteConfirmation(
  activity: Activity,
  reminderCount: number,
): Confirmation {
  const noun = activity.objectKind === 'task' ? 'task' : 'plan';

  const removes = [`the ${noun}`];
  if (activity.notes !== undefined && activity.notes !== '') removes.push('its notes');
  if (reminderCount > 0) {
    removes.push(plural(reminderCount, 'reminder', 'reminders'));
  }

  /**
   * Prep children survive with `parentActivityId` cleared — the cascade P1-14 built — so
   * they belong on the `Keeps:` line rather than being left unmentioned. A user deleting a
   * trip is entitled to know its two prep tasks are still on their Today.
   */
  const keeps =
    activity.childCount > 0
      ? `its ${plural(activity.childCount, 'prep task', 'prep tasks')}, which ${
          activity.childCount === 1 ? 'becomes an ordinary task' : 'become ordinary tasks'
        }`
      : undefined;

  return {
    heading: `Delete "${activity.title}"?`,
    removesLead: 'This removes:',
    removes: [`${sentenceList(removes)}.`],
    ...(keeps === undefined ? {} : { keeps: `${keeps}.` }),
    confirmLabel: activity.objectKind === 'task' ? 'Delete task' : 'Delete plan',
  };
}

/**
 * `Change Watch → Event?` — or nothing at all (`activities.md` §6.3 rule 6).
 *
 * The dropped fields come from **P1-17's mapping**, the same pure function the server runs,
 * so the dialog cannot promise to keep something the write then drops. Their labels already
 * carry the values — `Season and episode (S2 E4)` — because §6.3's example shows the user
 * what they are about to lose rather than which field name holds it.
 *
 * Returns `undefined` when the change is additive. That is not an optimisation: §1a.1 rule 3
 * says a conditional confirmation that can appear with nothing to name is a bug.
 */
export function kindChangeConfirmation(
  activity: Activity,
  target: ChangeTarget,
  reminderCount: number,
): Confirmation | undefined {
  const result = changeActivityKind(activity, target);
  if (result.dropped.length === 0) return undefined;

  const to = kindLabel(target);

  return {
    heading: `Change ${kindLabel(activity)} → ${to}?`,
    removesLead: 'This will remove:',
    removes: result.dropped.map((field) => field.label),
    keeps: `${sentenceList(keptFields(activity, reminderCount))}.`,
    confirmLabel: `Change to ${to}`,
  };
}

/**
 * How a kind is named in the heading: `Task`, or the Plan kind's own visible label.
 *
 * The same labels the choosers show, so the confirmation names the thing the user tapped
 * rather than the stored `type` — `General`, never `custom`.
 */
export function kindLabel(of: {
  objectKind: 'task' | 'plan';
  type: ActivityType;
}): string {
  return of.objectKind === 'task' ? 'Task' : planKindLabel(of.type as PlanType);
}

/**
 * The `Keeps:` line, built from what this activity actually has.
 *
 * §6.3's example reads `Keeps: title, date, time, people, notes, reminders.` — but naming a
 * date on an undated plan would be the confirmation telling the user about data that is not
 * there, which is the same failure as under-naming what is lost. §1a.1's own rule about
 * counts ("the number of records that actually carry the data") applies in both directions.
 */
function keptFields(activity: Activity, reminderCount: number): string[] {
  const kept = ['title'];
  if (activity.schedule !== undefined) {
    kept.push('date');
    if (activity.schedule.time !== undefined) kept.push('time');
  }
  if (activity.location !== undefined) kept.push('location');
  if (activity.participantCount > 0) kept.push('people');
  if (activity.notes !== undefined && activity.notes !== '') kept.push('notes');
  if (reminderCount > 0) kept.push('reminders');
  return kept;
}
