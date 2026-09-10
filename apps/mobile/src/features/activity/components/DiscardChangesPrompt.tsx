import { Button, Sheet, Text } from '@od/ui';

/**
 * The notes dirty-cancel confirmation (`activities.md` §6.1). Sheets reuse it so Cancel,
 * scrim and Escape do not grow a third pair of labels.
 */
export function DiscardChangesPrompt({
  open,
  message,
  onKeepEditing,
  onDiscard,
  onClosed,
}: {
  open: boolean;
  message: string;
  onKeepEditing: () => void;
  onDiscard: () => void;
  onClosed?: () => void;
}) {
  return (
    <Sheet
      open={open}
      title="Discard changes?"
      onClose={onKeepEditing}
      {...(onClosed === undefined ? {} : { onClosed })}
      actions={
        <>
          <Button contentSized label="Keep editing" onPress={onKeepEditing} />
          <Button
            contentSized
            label="Discard changes"
            variant="secondary"
            onPress={onDiscard}
          />
        </>
      }
    >
      <Text numberOfLines={0}>{message}</Text>
    </Sheet>
  );
}
