import { Archive, SettingRow, Sheet, Trash } from '@od/ui';
import { useRef } from 'react';
import { View } from 'react-native';
import type { ListSwipeAction } from '../model/listSwipeActions';

export interface ListCardActionsSheetProps {
  open: boolean;
  listTitle: string;
  actions: readonly ListSwipeAction[];
  onClose: () => void;
  onAction: (action: ListSwipeAction) => void;
}

/** The touch-friendly alternative to narrow swipe buttons on collection cards. */
export function ListCardActionsSheet({
  open,
  listTitle,
  actions,
  onClose,
  onAction,
}: ListCardActionsSheetProps) {
  const pendingAction = useRef<ListSwipeAction | undefined>(undefined);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      onClosed={() => {
        const action = pendingAction.current;
        pendingAction.current = undefined;
        if (action !== undefined) onAction(action);
      }}
      title={`${listTitle} actions`}
      testID="list-card-actions"
    >
      <View>
        {actions.map((action, index) => (
          <SettingRow
            key={action.name}
            label={action.label}
            {...(action.name === 'archive'
              ? { icon: Archive }
              : action.name === 'delete'
                ? { icon: Trash }
                : {})}
            density="compact"
            danger={action.destructive}
            separated={action.destructive && index > 0}
            onPress={() => {
              if (action.destructive) pendingAction.current = action;
              else onAction(action);
              onClose();
            }}
            testID={`list-card-action-${action.name}`}
          />
        ))}
      </View>
    </Sheet>
  );
}
