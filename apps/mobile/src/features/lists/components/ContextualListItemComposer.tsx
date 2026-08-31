import { Button, Card, Close, IconButton, Text, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { ListItemComposerFields } from '@/components/ListItemComposerFields';

export interface ContextualListItemComposerProps {
  open: boolean;
  listName: string;
  isAdding: boolean;
  errorMessage?: string;
  errorRequestId?: string;
  onClose: () => void;
  onAdd: (fields: { title: string; note?: string }) => Promise<string | undefined>;
}

/** Compact, destination-fixed List-item composer. */
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

  if (!open) return null;

  return (
    <Card elevation="e1" padding={5} testID="list-contextual-add">
      <View style={{ gap: theme.space[5] }}>
        <View
          style={{
            minHeight: theme.layout.hitTarget,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.space[3],
          }}
        >
          <View style={{ flex: 1 }}>
            <Text variant="heading" accessibilityRole="header">
              {`Add item to ${listName}`}
            </Text>
          </View>
          <IconButton icon={Close} label="Close" onPress={onClose} />
        </View>
        <ListItemComposerFields
          title={title}
          note={note}
          {...(errorMessage === undefined ? {} : { errorMessage })}
          {...(errorRequestId === undefined ? {} : { errorRequestId })}
          autoFocusTitle
          onTitleChange={setTitle}
          onNoteChange={setNote}
          onSubmitTitle={() => void commit()}
          titleTestID="list-contextual-add-title"
          noteTestID="list-contextual-add-note"
        />
        <View>
          <Button
            label={action}
            fullWidth
            size="lg"
            disabled={disabled}
            loading={isAdding}
            onPress={() => void commit()}
            testID="list-contextual-add-commit"
          />
        </View>
      </View>
    </Card>
  );
}
