import { Button, Text, useTheme } from '@od/ui';
import { useEffect } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import type { NotesDraft } from './ActivityNotes';

export function NotesActions({ notes }: { notes: NotesDraft }) {
  const theme = useTheme();
  const message = notes.saving
    ? 'Saving notes…'
    : notes.error
      ? "Couldn't save your notes. Your draft is still here. Choose Save notes to try again."
      : '';
  useEffect(() => {
    if (message) AccessibilityInfo.announceForAccessibility(message);
  }, [message]);
  if (!notes.editing) return null;
  return (
    <View style={{ gap: theme.space[2] }}>
      {message ? (
        <Text variant="footnote" numberOfLines={0} accessibilityLiveRegion="polite">
          {message}
        </Text>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: theme.space[3],
          justifyContent: 'flex-end',
        }}
      >
        <Button
          contentSized
          label="Cancel"
          variant="secondary"
          disabled={notes.saving}
          onPress={notes.cancel}
          testID="notes-cancel"
        />
        <Button
          contentSized
          label={notes.saving ? 'Saving notes…' : 'Save notes'}
          loading={notes.saving}
          onPress={() => void notes.save()}
          testID="notes-save"
        />
      </View>
    </View>
  );
}
