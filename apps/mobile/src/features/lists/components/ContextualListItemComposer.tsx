import { MAX_NOTES_LEN, MAX_TITLE_LEN } from '@od/shared/constants';
import { Button, Field, Sheet, Text, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';

export interface ContextualListItemComposerProps {
  open: boolean;
  listName: string;
  isAdding: boolean;
  errorMessage?: string;
  onClose: () => void;
  onAdd: (fields: { title: string; note?: string }) => Promise<string | undefined>;
}

/** Compact, destination-fixed List-item composer. */
export function ContextualListItemComposer({
  open,
  listName,
  isAdding,
  errorMessage,
  onClose,
  onAdd,
}: ContextualListItemComposerProps) {
  const theme = useTheme();
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const action = `Add to ${listName}`;
  const disabled = title.trim() === '' || isAdding;

  async function commit() {
    const trimmedTitle = title.trim();
    if (trimmedTitle === '' || isAdding) return;
    const trimmedNote = note.trim();
    const itemId = await onAdd({
      title: trimmedTitle,
      ...(trimmedNote === '' ? {} : { note: trimmedNote }),
    });
    if (itemId === undefined) return;
    setTitle('');
    setNote('');
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Add item to ${listName}`}
      detent="fit"
      testID="list-contextual-add"
      actions={
        <Button
          label={action}
          fullWidth
          size="lg"
          disabled={disabled}
          loading={isAdding}
          onPress={() => void commit()}
          testID="list-contextual-add-commit"
        />
      }
    >
      <View style={{ gap: theme.space[6] }}>
        {errorMessage === undefined ? null : (
          <Text accessibilityRole="alert" variant="footnote" color="danger">
            {errorMessage}
          </Text>
        )}
        <Field
          label="Title"
          value={title}
          onChangeText={setTitle}
          autoFocus
          maxLength={MAX_TITLE_LEN}
          onSubmitEditing={() => void commit()}
          testID="list-contextual-add-title"
        />
        <Field
          label="Note"
          optional
          value={note}
          onChangeText={setNote}
          multiline
          maxLength={MAX_NOTES_LEN}
          testID="list-contextual-add-note"
        />
      </View>
    </Sheet>
  );
}
