import { Button, Field, Text, useTheme } from '@od/ui';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import type { useNotesDraft } from '../hooks/useNotesDraft';

export type NotesDraft = ReturnType<typeof useNotesDraft>;

export function ActivityNotes({
  notes,
  value,
  kind,
  pending,
}: {
  notes: NotesDraft;
  value: string;
  kind: 'task' | 'plan';
  pending: boolean;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const wasSaving = useRef(false);
  useEffect(() => {
    if (!notes.editing && !notes.confirming) {
      const frame = requestAnimationFrame(notes.focusAction);
      return () => cancelAnimationFrame(frame);
    }
  }, [notes.editing, notes.confirming, notes.focusAction]);
  useEffect(() => {
    if (wasSaving.current && !notes.saving) {
      if (notes.error) notes.inputRef.current?.focus();
      else AccessibilityInfo.announceForAccessibility('Notes saved.');
    }
    wasSaving.current = notes.saving;
  }, [notes.saving, notes.error, notes.inputRef]);
  return (
    <View
      testID="section-notes"
      style={{
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        paddingVertical: theme.space[5],
        gap: theme.space[3],
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: theme.space[2],
        }}
      >
        <Text variant="subhead">Notes</Text>
        {pending ? (
          value.trim() ? (
            <Button
              contentSized
              label={expanded ? 'Show less' : 'Show notes'}
              variant="ghost"
              onPress={() => setExpanded(!expanded)}
            />
          ) : null
        ) : notes.editing ? null : (
          <Button
            contentSized
            elementRef={notes.actionRef}
            label={value.trim() ? 'Edit notes' : 'Add notes'}
            variant="ghost"
            onPress={notes.edit}
            testID="notes-edit"
          />
        )}
      </View>
      {notes.editing ? (
        <Field
          inputRef={notes.inputRef}
          label={`Notes for this ${kind}`}
          value={notes.draft}
          onChangeText={notes.change}
          multiline
          autoFocus
          disabled={notes.saving}
          testID="detail-notes"
          hint="Changes are saved only when you choose Save notes."
          {...(notes.error
            ? {
                error:
                  "Couldn't save your notes. Your draft is still here. Choose Save notes to try again.",
              }
            : {})}
        />
      ) : (
        <Text
          color="textSecondary"
          numberOfLines={pending && expanded ? 0 : 2}
          testID="notes-preview"
        >
          {value.trim() ? value : 'No notes yet.'}
        </Text>
      )}
    </View>
  );
}
