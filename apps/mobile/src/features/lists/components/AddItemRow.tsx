import { MAX_TITLE_LEN } from '@od/shared/constants';
import { Field, Text, Touchable, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';

/**
 * The persistent `+ Add an item` row at the foot of a list
 * ([`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.6, §P3-27).
 *
 * ```
 *  ┌────────────────────────────────────────────┐
 *  │  + Add an item                             │   ← tap, or the empty state's action
 *  └────────────────────────────────────────────┘
 *  ┌────────────────────────────────────────────┐
 *  │  [ Milk_                                 ] │   ← focused; Return commits and stays
 *  │  Add to Groceries                          │
 *  └────────────────────────────────────────────┘
 * ```
 *
 * ## Rapid entry is the design, not an optimisation
 *
 * §5.6: "Return activates `Add to <list name>` and re-focuses so several items can be typed in
 * sequence." So the field keeps focus and clears rather than closing — a row that dismissed
 * itself would make a shopping list eight taps longer than it needs to be. `blurOnSubmit` is
 * off for exactly that; the keyboard never drops between items.
 *
 * ## The label names the write, and the list is a prop
 *
 * `Add to {list name}` is the accessible action (§2.5, criterion 33) and the list comes from
 * the screen. There is no default destination to fall back to and nothing here reads one; the
 * title is data, and it never chooses where it goes.
 *
 * **Title only.** Note, location and the typed fields belong to the item sheet (P3-29) and the
 * capability rules in §5.7; a second field here would be a form pretending to be a row.
 */
export interface AddItemRowProps {
  /** Named on the commit action, so the user can see where the words are about to land. */
  listName: string;
  /** Commits one item. Resolves to its id, or `undefined` when the write did not land. */
  onAdd: (title: string) => Promise<string | undefined>;
  isAdding: boolean;
  /** `interaction-contract.md` §5.3 copy; the typed title stays put behind it. */
  errorMessage?: string;
  /** Opens focused, for the empty state's `+ Add an item` action. */
  autoFocus?: boolean;
  testID?: string;
}

export function AddItemRow({
  listName,
  onAdd,
  isAdding,
  errorMessage,
  autoFocus = false,
  testID = 'list-add-item',
}: AddItemRowProps) {
  const theme = useTheme();
  const [open, setOpen] = useState(autoFocus);
  const [title, setTitle] = useState('');
  const action = `Add to ${listName}`;

  async function commit() {
    const trimmed = title.trim();
    if (trimmed === '' || isAdding) return;
    const added = await onAdd(trimmed);
    // The words stay put when the write did not land: the banner explains, and re-typing a
    // list of groceries because one request failed is the opposite of rapid entry.
    if (added === undefined) return;
    /*
     * Cleared, not closed — and the field never lost focus, because `Field` keeps the keyboard
     * up on Return. So the next item is typed straight into it with no tap in between.
     */
    setTitle('');
  }

  if (!open) {
    return (
      <Touchable
        accessibilityRole="button"
        accessibilityLabel="Add an item"
        onPress={() => setOpen(true)}
        testID={testID}
        style={{ paddingVertical: theme.space[4] }}
      >
        <Text variant="body" color="textAction">
          + Add an item
        </Text>
      </Touchable>
    );
  }

  return (
    <View style={{ gap: theme.space[2] }} testID={`${testID}-open`}>
      <Field
        label={action}
        hideLabel
        value={title}
        onChangeText={setTitle}
        placeholder="Add an item"
        autoFocus
        maxLength={MAX_TITLE_LEN}
        onSubmitEditing={() => void commit()}
        testID={`${testID}-title`}
      />
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={action}
        accessibilityState={{ disabled: title.trim() === '' || isAdding }}
        disabled={title.trim() === '' || isAdding}
        onPress={() => void commit()}
        testID={`${testID}-commit`}
      >
        <Text
          variant="footnoteStrong"
          color={title.trim() === '' || isAdding ? 'textDisabled' : 'textAction'}
        >
          {action}
        </Text>
      </Touchable>
      {errorMessage === undefined ? null : (
        <Text variant="footnote" color="danger" testID={`${testID}-error`}>
          {errorMessage}
        </Text>
      )}
    </View>
  );
}
