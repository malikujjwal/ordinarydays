import { Button, Sheet, Text, useTheme } from '@od/ui';
import { View } from 'react-native';

/**
 * `Discard this?` — shown when a compose modal with content is closed
 * (`activities.md` §2.2, P1-24).
 *
 * `Keep editing` is the **non-destructive option and comes first**, matching
 * `interaction-contract.md` §1a.1 rule 1: the safe choice sits first and the destructive
 * button repeats its own verb rather than saying `OK`.
 *
 * The dialog is not dismissible by tapping the scrim. A confirmation whose scrim silently
 * cancels it is a confirmation that can be answered by accident, which for a discard means
 * losing what the user typed to a stray tap.
 */
export interface DiscardPromptProps {
  open: boolean;
  onDiscard: () => void;
  onKeepEditing: () => void;
}

export function DiscardPrompt({ open, onDiscard, onKeepEditing }: DiscardPromptProps) {
  const theme = useTheme();

  return (
    <Sheet
      open={open}
      onClose={onKeepEditing}
      dismissible={false}
      testID="discard-prompt"
    >
      <Text variant="heading" color="textDisplay" accessibilityRole="header">
        Discard this?
      </Text>

      <View style={{ flexDirection: 'row', gap: theme.space[3], flexWrap: 'wrap' }}>
        <Button
          label="Keep editing"
          variant="secondary"
          onPress={onKeepEditing}
          testID="discard-keep-editing"
        />
        <Button
          label="Discard"
          variant="danger"
          onPress={onDiscard}
          testID="discard-confirm"
        />
      </View>
    </Sheet>
  );
}
