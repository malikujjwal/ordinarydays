import { SettingRow, Sheet } from '@od/ui';
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
  return (
    <Sheet open={open} onClose={onClose} title="More" testID="today-overflow-menu">
      <View>
        <SettingRow
          label="Show skipped"
          summary="Include skipped occurrences in Earlier today"
          accessibilityLabel="Show skipped"
          density="compact"
          role="checkbox"
          selected={showSkipped}
          onPress={() => onShowSkippedChange(!showSkipped)}
          testID="today-show-skipped"
        />
      </View>
    </Sheet>
  );
}
