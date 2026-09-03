import type { List } from '@od/shared/types';
import type { Confirmation } from '@/components/ConfirmDialog';

const itemCount = (count: number) => `${String(count)} ${count === 1 ? 'item' : 'items'}`;

/** Member-only leave copy. Leaving removes access; it never deletes the shared List. */
export function leaveListConfirmation(
  list: Pick<List, 'title' | 'itemCount'>,
): Confirmation {
  return {
    heading: `Leave "${list.title}"?`,
    removesLead: 'This removes',
    removes: ['the list from your Lists.'],
    keeps: `all ${itemCount(list.itemCount)} on it. Its owner keeps the list.`,
    confirmLabel: 'Leave',
  };
}
