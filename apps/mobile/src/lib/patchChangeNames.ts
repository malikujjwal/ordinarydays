import type { PatchActivityInput } from '@od/shared/schemas';

const PATCH_LABELS: Record<keyof PatchActivityInput, string> = {
  title: 'Title',
  notes: 'Notes',
  recurrence: 'Repeat',
  editedFromDate: 'Repeat',
  location: 'Location',
  details: 'Details',
  sourceUrl: 'Link',
  parentActivityId: 'Prep task',
  status: 'Status',
  objectKind: 'Plan type',
  type: 'Plan type',
};

/** Platform-neutral labels retained with a PATCH for conflict presentation. */
export function patchChangeNames(input: PatchActivityInput): string[] {
  return [
    ...new Set(
      (Object.keys(input) as Array<keyof PatchActivityInput>).map(
        (field) => PATCH_LABELS[field],
      ),
    ),
  ];
}
