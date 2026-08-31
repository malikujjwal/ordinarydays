import { MAX_NOTES_LEN, MAX_TITLE_LEN } from '@od/shared/constants';
import { Field, Text, useTheme } from '@od/ui';
import { View } from 'react-native';

export interface ListItemComposerFieldsProps {
  title: string;
  note: string;
  errorMessage?: string;
  errorRequestId?: string;
  autoFocusTitle?: boolean;
  onTitleChange: (title: string) => void;
  onNoteChange: (note: string) => void;
  onSubmitTitle?: () => void;
  titleTestID?: string;
  noteTestID?: string;
}

/** The one Title/optional-Note/error shell shared by both List-item creation intents. */
export function ListItemComposerFields({
  title,
  note,
  errorMessage,
  errorRequestId,
  autoFocusTitle = false,
  onTitleChange,
  onNoteChange,
  onSubmitTitle,
  titleTestID,
  noteTestID,
}: ListItemComposerFieldsProps) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.space[6] }}>
      {errorMessage === undefined ? null : (
        <View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{
            gap: theme.space[2],
            padding: theme.space[5],
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.surfaceSunken,
          }}
        >
          <Text variant="subhead" color="danger">
            {errorMessage}
          </Text>
          {errorRequestId === undefined ? null : (
            <Text variant="footnote" color="textSecondary" selectable>
              {errorRequestId}
            </Text>
          )}
        </View>
      )}
      <Field
        label="Title"
        value={title}
        onChangeText={onTitleChange}
        autoFocus={autoFocusTitle}
        maxLength={MAX_TITLE_LEN}
        {...(onSubmitTitle === undefined ? {} : { onSubmitEditing: onSubmitTitle })}
        {...(titleTestID === undefined ? {} : { testID: titleTestID })}
      />
      <Field
        label="Note"
        optional
        value={note}
        onChangeText={onNoteChange}
        multiline
        maxLength={MAX_NOTES_LEN}
        {...(noteTestID === undefined ? {} : { testID: noteTestID })}
      />
    </View>
  );
}
