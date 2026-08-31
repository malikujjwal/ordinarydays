import { Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { ListItemComposerFields } from '@/components/ListItemComposerFields';
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
  errorRequestId?: string;
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
  errorRequestId,
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
      <ListItemComposerFields
        title={title}
        note={note}
        {...(errorMessage === undefined ? {} : { errorMessage })}
        {...(errorRequestId === undefined ? {} : { errorRequestId })}
        onTitleChange={onTitleChange}
        onNoteChange={onNoteChange}
        titleTestID="compose-title"
        noteTestID="compose-item-note"
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
