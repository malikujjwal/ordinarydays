import { Button, Sheet } from '@od/ui';
import { useState } from 'react';
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
    </Sheet>
  );
}
