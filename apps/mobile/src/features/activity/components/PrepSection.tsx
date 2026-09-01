import type { ActivityChild } from '@od/shared/types';
import { Checkbox, Text, Touchable, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionRow } from '@/features/activity/components/ActionRow';
import { SectionFrame } from '@/features/activity/components/SectionFrame';
import { peekRows, prepProgress } from '@/features/activity/model/planSections';

/**
 * The PREP section (P3-37/P3-38): 1–3 rows in full, 4+ peek at three with `Show all n`
 * expanding **in place** (deviation recorded — the amendment prefers a push). Tapping a
 * row's body opens the child's own detail (U1); the checkbox is the one sanctioned row
 * mutation and renders disabled until its completion write is wired.
 */
export interface PrepSectionProps {
  /** Named for what they are rather than `children`, which JSX reserves for its own slot. */
  prepTasks: readonly ActivityChild[];
  onOpenChild: (activityId: string) => void;
  /** The completion write; absent renders the checkbox disabled. */
  onToggleChild?: (child: ActivityChild, completed: boolean) => void;
  /** P3-38's `+ Add prep task`; absent renders no affordance. */
  onAddPrepTask?: () => void;
}

export function PrepSection({
  prepTasks,
  onOpenChild,
  onToggleChild,
  onAddPrepTask,
}: PrepSectionProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const { shown, showAllCount } = peekRows(prepTasks, expanded);

  return (
    <SectionFrame
      label="Preparation"
      trailing={prepProgress(prepTasks)}
      testID="section-prep"
    >
      {shown.map((child) => (
        <View
          key={child.activityId}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.space[3],
            minHeight: theme.layout.hitTarget,
          }}
          testID={`prep-child-${child.activityId}`}
        >
          <Checkbox
            checked={child.status === 'completed'}
            label={`${child.title}, ${child.status === 'completed' ? 'completed' : 'not completed'}`}
            disabled={onToggleChild === undefined}
            {...(onToggleChild === undefined
              ? {}
              : {
                  onChange: (next: boolean) => onToggleChild(child, next),
                })}
          />
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={child.title}
            onPress={() => onOpenChild(child.activityId)}
            style={{ flex: 1, minWidth: 0, alignItems: 'flex-start' }}
          >
            <Text
              variant="body"
              color={child.status === 'completed' ? 'textSecondary' : 'textPrimary'}
              struck={child.status === 'completed'}
              numberOfLines={2}
            >
              {child.title}
            </Text>
          </Touchable>
        </View>
      ))}
      {showAllCount === undefined ? null : (
        <ActionRow
          label={`Show all ${showAllCount}`}
          accessibilityLabel={`Show all ${showAllCount}`}
          variant="subhead"
          onPress={() => setExpanded(true)}
          testID="prep-show-all"
        />
      )}
      {onAddPrepTask === undefined ? null : (
        <ActionRow
          label="+ Add prep task"
          accessibilityLabel="Add prep task"
          onPress={onAddPrepTask}
          testID="prep-add"
        />
      )}
    </SectionFrame>
  );
}
