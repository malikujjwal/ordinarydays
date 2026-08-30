import { MAX_NOTES_LEN, MAX_TITLE_LEN } from '@od/shared/constants';
import { Field, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { CaptureRow } from './CaptureRow';
import { type ListDestination, ListDestinationChooser } from './ListDestinationChooser';

export interface GlobalListItemComposerProps {
  title: string;
  note: string;
  selectedListId?: string;
  destinations: readonly ListDestination[];
  destinationStatus: 'pending' | 'success' | 'error';
  sourceUrl: string | undefined;
  attachmentUri: string | undefined;
  errorMessage?: string;
  onTitleChange: (title: string) => void;
  onNoteChange: (note: string) => void;
  onChooseList: (listId: string) => void;
  onCreateList: () => void;
  onRetryDestinations: () => void;
  onSourceUrlChange: (url: string) => void;
  onAttach: (uri: string) => void;
  onClearAttachment: () => void;
}

/** Global List-item fields and their required inline destination (§P3-33). */
export function GlobalListItemComposer({
  title,
  note,
  selectedListId,
  destinations,
  destinationStatus,
  sourceUrl,
  attachmentUri,
  errorMessage,
  onTitleChange,
  onNoteChange,
  onChooseList,
  onCreateList,
  onRetryDestinations,
  onSourceUrlChange,
  onAttach,
  onClearAttachment,
}: GlobalListItemComposerProps) {
  const theme = useTheme();

  return (
    <View testID="compose-list-item" style={{ gap: theme.space[6] }}>
      <Text variant="title" color="textDisplay" accessibilityRole="header">
        Add list item
      </Text>
      {errorMessage === undefined ? null : (
        <Text accessibilityRole="alert" variant="footnote" color="danger">
          {errorMessage}
        </Text>
      )}
      <Field
        label="Title"
        value={title}
        onChangeText={onTitleChange}
        maxLength={MAX_TITLE_LEN}
        testID="compose-title"
      />
      <Field
        label="Note"
        optional
        value={note}
        onChangeText={onNoteChange}
        multiline
        maxLength={MAX_NOTES_LEN}
        testID="compose-item-note"
      />
      <ListDestinationChooser
        lists={destinations}
        status={destinationStatus}
        {...(selectedListId === undefined ? {} : { selectedListId })}
        onChoose={onChooseList}
        onCreateList={onCreateList}
        onRetry={onRetryDestinations}
      />
      {selectedListId === undefined ? null : (
        <CaptureRow
          sourceUrl={sourceUrl}
          onSourceUrlChange={onSourceUrlChange}
          attachmentUri={attachmentUri}
          onAttach={onAttach}
          onClearAttachment={onClearAttachment}
        />
      )}
    </View>
  );
}
