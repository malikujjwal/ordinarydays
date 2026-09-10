import type { NotesDraft } from './ActivityNotes';
import { DiscardChangesPrompt } from './DiscardChangesPrompt';

export function NotesDiscardPrompt({ notes }: { notes: NotesDraft }) {
  return (
    <DiscardChangesPrompt
      open={notes.confirming}
      message="Your notes have unsaved changes."
      onKeepEditing={notes.keepEditing}
      onDiscard={notes.discard}
      onClosed={() => {
        notes.promptClosed();
        requestAnimationFrame(() => {
          if (notes.editing) notes.inputRef.current?.focus();
          else notes.focusAction();
        });
      }}
    />
  );
}
