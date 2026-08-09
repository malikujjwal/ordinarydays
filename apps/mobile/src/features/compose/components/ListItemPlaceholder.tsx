import { EmptyState } from '@od/ui';

/**
 * Where `List item` lands in Phase 1.
 *
 * The row is **visible in the chooser and always will be** — the mental model is exactly
 * three words and hiding one of them for a phase would teach the wrong one
 * (`activities.md` §2.2). What is missing is the destination: a List item requires an explicit
 * list, Lists arrive in Phase 3, and inventing a default destination would break the same rule
 * from the other direction.
 *
 * So the choice is honoured, nothing is created, and Phase 3 replaces this component with the
 * explicit list picker. Copy is the phase plan's own `Lists are coming soon.` (P1-25), used
 * verbatim so the two places a user can meet this boundary say the same thing.
 */
export interface ListItemPlaceholderProps {
  onBack: () => void;
}

export function ListItemPlaceholder({ onBack }: ListItemPlaceholderProps) {
  return (
    <EmptyState
      testID="list-item-placeholder"
      heading="Lists are coming soon."
      body="Add a task or a plan instead."
      action={{ label: 'Back', onPress: onBack }}
    />
  );
}
