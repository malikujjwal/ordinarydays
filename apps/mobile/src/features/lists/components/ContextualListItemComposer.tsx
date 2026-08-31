import { MAX_TITLE_LEN } from '@od/shared/constants';
import { Button, Field, IconTile, Plus, Text, Touchable, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';

export interface ContextualListItemComposerProps {
  open: boolean;
  listName: string;
  isAdding: boolean;
  errorMessage?: string;
  errorRequestId?: string;
  onClose: () => void;
  onAdd: (fields: { title: string; note?: string }) => Promise<string | undefined>;
}

/**
 * The rapid-entry add row (`plans-and-lists.md` §5.6), in the shape the founder asked for
 * (2026-08-31): the dashed `+` tile, one `underline` field and an `Add` button, **inline in
 * the list's own measure** — not a card that reads as a modal.
 *
 * ## Return adds another
 *
 * `Field`'s `onSubmitEditing` keeps the keyboard up by design ("rapid entry is the point"),
 * so Return commits, clears and stays focused — a shopping list is typed in one breath. The
 * note is deliberately absent here: the quick row captures the *item*, and the item sheet
 * owns everything else. Keyboard visibility is `ScreenShell`'s `keepEndVisibleWithKeyboard`,
 * which the detail surface enables while this row is mounted.
 *
 * ## Closing is the tile
 *
 * Tapping the dashed `+` that opened the row retires it — the same pixel means "add" when
 * closed and "done adding" when open, and there is no `✕` taking a third of the row.
 */
export function ContextualListItemComposer({
  open,
  listName,
  isAdding,
  errorMessage,
  errorRequestId,
  onClose,
  onAdd,
}: ContextualListItemComposerProps) {
  const theme = useTheme();
  const [title, setTitle] = useState('');
  const disabled = title.trim() === '' || isAdding;

  async function commit() {
    const trimmedTitle = title.trim();
    if (trimmedTitle === '' || isAdding) return;
    const itemId = await onAdd({ title: trimmedTitle });
    if (itemId === undefined) return;
    setTitle('');
  }

  if (!open) return null;

  return (
    <View testID="list-contextual-add" style={{ gap: theme.space[1] }}>
      <View
        style={{
          minHeight: theme.layout.rowMinHeight,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space[3],
        }}
      >
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Done adding"
          onPress={onClose}
          testID="list-contextual-add-close"
        >
          <IconTile icon={Plus} tint="task" size={36} treatment="dashed" />
        </Touchable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Field
            label={`Add item to ${listName}`}
            hideLabel
            appearance="underline"
            value={title}
            autoFocus
            placeholder="Add an item"
            maxLength={MAX_TITLE_LEN}
            onChangeText={setTitle}
            onSubmitEditing={() => void commit()}
            {...(errorMessage === undefined
              ? { hint: 'Return adds another' }
              : { error: errorMessage })}
            testID="list-contextual-add-title"
          />
        </View>
        <Button
          label="Add"
          disabled={disabled}
          loading={isAdding}
          onPress={() => void commit()}
          testID="list-contextual-add-commit"
        />
      </View>
      {errorRequestId === undefined ? null : (
        <Text
          variant="footnote"
          color="textSecondary"
          selectable
          testID="list-contextual-add-request-id"
        >
          {errorRequestId}
        </Text>
      )}
    </View>
  );
}
