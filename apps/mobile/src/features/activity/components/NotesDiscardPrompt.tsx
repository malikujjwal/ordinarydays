import { Button, Sheet, Text } from '@od/ui';
import type { NotesDraft } from './ActivityNotes';

export function NotesDiscardPrompt({ notes }: { notes: NotesDraft }) {
  return (
    <Sheet
      open={notes.confirming}
      title="Discard changes?"
      onClose={notes.keepEditing}
      onClosed={() => {
        notes.promptClosed();
        requestAnimationFrame(() => {
          if (notes.editing) notes.inputRef.current?.focus();
          else notes.focusAction();
        });
      }}
      actions={
        <>
          <Button contentSized label="Keep editing" onPress={notes.keepEditing} />
          <Button
            contentSized
            label="Discard changes"
            variant="secondary"
            onPress={notes.discard}
          />
        </>
      }
    >
      <Text numberOfLines={0}>Your notes have unsaved changes.</Text>
    </Sheet>
  );
}
