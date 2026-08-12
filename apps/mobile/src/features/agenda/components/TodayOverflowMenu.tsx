import { Checkbox, Sheet, Text, useTheme } from '@od/ui';
import { View } from 'react-native';

export interface TodayOverflowMenuProps {
  open: boolean;
  showSkipped: boolean;
  onShowSkippedChange: (show: boolean) => void;
  onClose: () => void;
}

/** Today presentation preferences; all data remains in the existing agenda response. */
export function TodayOverflowMenu({
  open,
  showSkipped,
  onShowSkippedChange,
  onClose,
}: TodayOverflowMenuProps) {
  const theme = useTheme();

  return (
    <Sheet open={open} onClose={onClose} title="More" testID="today-overflow-menu">
      <View
        style={{
          minHeight: theme.layout.hitTarget,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[4],
        }}
      >
        <Text>Show skipped</Text>
        <Checkbox
          checked={showSkipped}
          label="Show skipped"
          onChange={onShowSkippedChange}
          testID="today-show-skipped"
        />
      </View>
    </Sheet>
  );
}
