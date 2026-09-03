import { SettingRow } from '@od/ui';
import { memo, useCallback } from 'react';

interface ExistingListPickerRowProps {
  readonly listId: string;
  readonly title: string;
  readonly itemCount: number;
  readonly selected: boolean;
  readonly disabledReason: string | undefined;
  readonly onSelect: (listId: string) => void;
}

export const ExistingListPickerRow = memo(function ExistingListPickerRow({
  listId,
  title,
  itemCount,
  selected,
  disabledReason,
  onSelect,
}: ExistingListPickerRowProps) {
  const countLabel = `${String(itemCount)} ${itemCount === 1 ? 'item' : 'items'}`;
  const summary = disabledReason ?? countLabel;
  const select = useCallback(() => onSelect(listId), [listId, onSelect]);

  return (
    <SettingRow
      label={title}
      summary={summary}
      accessibilityLabel={`${title}. ${summary}`}
      {...(disabledReason === undefined ? { selected } : {})}
      disabled={disabledReason !== undefined}
      onPress={select}
      testID={`plan-list-choice-${listId}`}
    />
  );
});
