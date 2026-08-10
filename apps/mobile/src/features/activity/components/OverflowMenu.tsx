import type { Activity } from '@od/shared/types';
import { Button, Sheet, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import {
  planToTaskBlockedMessage,
  planToTaskBlockers,
} from '@/features/activity/model/sections';

/**
 * The `⋯` menu (U6: "everything else").
 *
 * > **Nothing destructive lives anywhere but here** (and behind a swipe-revealed button that
 * > still requires a tap).
 *
 * ## What is here in Phase 1, and the one decision behind it
 *
 * P1-26 ships the detail screen with **no completion button** — completion is Phase 2, and a
 * disabled primary action teaches users the app is unfinished. The explicit conversion path
 * *is* here, because P1-27 needs the mapping and the blocker copy exercised.
 *
 * `Change Plan kind` on a Plan, `Change to Plan` on a Task, `Change to Task` on a Plan
 * (`activities.md` §6.3 rule 1). Duplicate and Delete are P1-27's, and are absent rather than
 * disabled: a menu of greyed-out rows is a menu that teaches nothing.
 *
 * ## Plan → Task is blocked, not hidden
 *
 * §6.3 rule 3: available only at zero participants, zero expenses and zero prep children.
 * When it is blocked the row **stays visible and names exactly what must be removed first** —
 * hiding it would leave the user unable to find out why the conversion they expected is not
 * offered. The counts come from the Activity's own denormalised fields.
 */
export interface OverflowMenuProps {
  open: boolean;
  onClose: () => void;
  activity: Activity;
  onChangePlanKind: () => void;
  onChangeObject: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function OverflowMenu({
  open,
  onClose,
  activity,
  onChangePlanKind,
  onChangeObject,
  onDuplicate,
  onDelete,
}: OverflowMenuProps) {
  const theme = useTheme();
  const isTask = activity.objectKind === 'task';
  const blockers = isTask ? [] : planToTaskBlockers(activity);
  const blocked = planToTaskBlockedMessage(blockers);

  return (
    <Sheet open={open} onClose={onClose} title="More" testID="overflow-menu">
      <View style={{ gap: theme.space[4], alignItems: 'stretch' }}>
        {isTask ? null : (
          <Button
            label="Change Plan kind"
            variant="secondary"
            fullWidth
            onPress={() => {
              onClose();
              onChangePlanKind();
            }}
            testID="overflow-change-plan-kind"
          />
        )}

        <View style={{ gap: theme.space[2] }}>
          <Button
            label={isTask ? 'Change to Plan' : 'Change to Task'}
            variant="secondary"
            fullWidth
            disabled={blocked !== undefined}
            onPress={() => {
              onClose();
              onChangeObject();
            }}
            testID="overflow-change-object"
          />
          {blocked === undefined ? null : (
            <Text variant="footnote" color="textSecondary" testID="overflow-blocked">
              {blocked}
            </Text>
          )}
        </View>

        <Button
          label="Duplicate"
          variant="secondary"
          fullWidth
          onPress={() => {
            onClose();
            onDuplicate();
          }}
          testID="overflow-duplicate"
        />

        {/**
         * Last, and the only `danger` row. U6: nothing destructive lives anywhere but here,
         * and §6.4 gives it its own confirmation naming what is removed — the button opens
         * that dialog rather than deleting.
         */}
        <Button
          label="Delete"
          variant="danger"
          fullWidth
          onPress={() => {
            onClose();
            onDelete();
          }}
          testID="overflow-delete"
        />
      </View>
    </Sheet>
  );
}
