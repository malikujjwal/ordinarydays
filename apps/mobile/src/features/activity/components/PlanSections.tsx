import type {
  ActivityChild,
  ActivityUpdate,
  Attachment,
  SourceListSummary,
} from '@od/shared/types';
import { Checkbox, Chip, SectionHeader, Text, Touchable, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
import {
  peekRows,
  prepProgress,
  sourceListLine,
} from '@/features/activity/model/planSections';

/**
 * The Plan sections that exist only once they hold something (P3-37, `plans-and-lists.md`
 * §2.1 amended 2026-08-25), plus the one `Add to this plan` chip row that makes the empty
 * ones discoverable.
 *
 * A section of 1–3 rows renders in full; 4 or more peeks at three and defers to
 * `Show all n`. `Show all n` expands **in place**: the whole collection is already in the
 * one detail response (prep and attachments are model-capped, updates carry their first
 * page), so a pushed sub-screen would re-fetch what the screen is holding. The amendment
 * prefers a push; the deviation is recorded in the PR for the founder to reverse if the
 * in-place scroll reads badly on device.
 *
 * Tapping a prep row's **body** opens the child's own detail (U1); its checkbox is the one
 * sanctioned row mutation and belongs to P3-38's completion wiring — absent here, the
 * checkbox renders disabled.
 */

/** One section's frame: caption header with a trailing figure, then its rows. */
function SectionFrame({
  label,
  trailing,
  children,
  testID,
}: {
  label: string;
  trailing?: string;
  children: React.ReactNode;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[2] }} {...(testID === undefined ? {} : { testID })}>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: theme.space[2],
        }}
      >
        <SectionHeader title={label} />
        {trailing === undefined ? null : (
          <Text variant="footnoteStrong" color="textSecondary">
            {trailing}
          </Text>
        )}
      </View>
      {children}
    </View>
  );
}

function ShowAllRow({
  count,
  onPress,
  testID,
}: {
  count: number;
  onPress: () => void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`Show all ${count}`}
      onPress={onPress}
      style={{ alignItems: 'flex-start', paddingVertical: theme.space[2] }}
      {...(testID === undefined ? {} : { testID })}
    >
      <Text variant="subhead" color="textAction">{`Show all ${count}`}</Text>
    </Touchable>
  );
}

export interface PrepSectionProps {
  /** Named for what they are rather than `children`, which JSX reserves for its own slot. */
  prepTasks: readonly ActivityChild[];
  onOpenChild: (activityId: string) => void;
  /** P3-38's completion write; absent renders the checkbox disabled. */
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
        <ShowAllRow
          count={showAllCount}
          onPress={() => setExpanded(true)}
          testID="prep-show-all"
        />
      )}
      {onAddPrepTask === undefined ? null : (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Add prep task"
          onPress={onAddPrepTask}
          style={{ alignItems: 'flex-start', paddingVertical: theme.space[2] }}
          testID="prep-add"
        >
          <Text variant="body" color="textAction">
            + Add prep task
          </Text>
        </Touchable>
      )}
    </SectionFrame>
  );
}

export interface ListsSectionProps {
  sourceLists: readonly SourceListSummary[];
  onOpenList: (listId: string) => void;
  /** P3-39's `+ Add list`; absent renders no affordance. */
  onAddList?: () => void;
}

export function ListsSection({ sourceLists, onOpenList, onAddList }: ListsSectionProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const { shown, showAllCount } = peekRows(sourceLists, expanded);

  return (
    <SectionFrame label="Lists" testID="section-lists">
      {shown.map((summary) => (
        <Touchable
          key={summary.listId}
          accessibilityRole="button"
          accessibilityLabel={`${summary.title}, ${sourceListLine(summary)}`}
          onPress={() => onOpenList(summary.listId)}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.space[3],
            minHeight: theme.layout.hitTarget,
          }}
          testID={`plan-list-${summary.listId}`}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="body" color="textPrimary" numberOfLines={1}>
              {summary.title}
            </Text>
          </View>
          <Text variant="footnote" color="textSecondary">
            {sourceListLine(summary)}
          </Text>
        </Touchable>
      ))}
      {showAllCount === undefined ? null : (
        <ShowAllRow
          count={showAllCount}
          onPress={() => setExpanded(true)}
          testID="lists-show-all"
        />
      )}
      {onAddList === undefined ? null : (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Add list"
          onPress={onAddList}
          style={{ alignItems: 'flex-start', paddingVertical: theme.space[2] }}
          testID="lists-add"
        >
          <Text variant="body" color="textAction">
            + Add list
          </Text>
        </Touchable>
      )}
    </SectionFrame>
  );
}

export function AttachmentsSection({
  attachments,
}: {
  attachments: readonly Attachment[];
}) {
  const theme = useTheme();
  return (
    <SectionFrame
      label="Attachments"
      trailing={String(attachments.length)}
      testID="section-attachments"
    >
      {/**
       * Placeholder tiles until P3-41/P3-42 bring the picker and viewer: the section exists
       * because content exists, but media bytes are served by unguessable key and nothing on
       * this screen may fabricate a URL for one.
       */}
      <View style={{ flexDirection: 'row', gap: theme.space[2], overflow: 'hidden' }}>
        {attachments.slice(0, 4).map((attachment) => (
          <View
            key={attachment.attachmentId}
            style={{
              width: 56,
              height: 56,
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.surfaceSunken,
            }}
            testID={`attachment-tile-${attachment.attachmentId}`}
          />
        ))}
      </View>
    </SectionFrame>
  );
}

export interface UpdatesSectionProps {
  updates: readonly ActivityUpdate[];
  /** `2 days ago` — derived by the caller so this component never reads a clock. */
  relativeTime: (createdAt: string) => string;
  onShowAll?: () => void;
}

/**
 * The read-only Updates section shell (P3-37). P3-40 brings the composer, delete, optimistic
 * posting and pagination; this renders the embedded first page under the peek rule so the
 * section holds its place in the anatomy from the first system entry.
 */
export function UpdatesSection({ updates, relativeTime }: UpdatesSectionProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const { shown, showAllCount } = peekRows(updates, expanded);

  return (
    <SectionFrame
      label="Updates"
      trailing={String(updates.length)}
      testID="section-updates"
    >
      {shown.map((update) => (
        <View
          key={update.updateId}
          style={{
            flexDirection: 'row',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: theme.space[3],
            paddingVertical: theme.space[1],
          }}
          testID={`update-${update.updateId}`}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="body" color="textSecondary" numberOfLines={2}>
              {update.body}
            </Text>
          </View>
          <Text variant="footnote" color="textMuted">
            {relativeTime(update.createdAt)}
          </Text>
        </View>
      ))}
      {showAllCount === undefined ? null : (
        <ShowAllRow
          count={showAllCount}
          onPress={() => setExpanded(true)}
          testID="updates-show-all"
        />
      )}
    </SectionFrame>
  );
}

export interface AddToPlanRowProps {
  chips: { prepTask: boolean; list: boolean; update: boolean };
  onAddPrepTask?: () => void;
  onAddList?: () => void;
  onWriteUpdate?: () => void;
}

/**
 * The one `Add to this plan` row of named chips (§2.1 amended): how an empty section is
 * discovered without an empty heading. `People · coming later` renders as its own row above,
 * not here — the pre-build treatment is unchanged.
 */
export function AddToPlanRow({
  chips,
  onAddPrepTask,
  onAddList,
  onWriteUpdate,
}: AddToPlanRowProps) {
  const theme = useTheme();
  const entries = [
    chips.prepTask && onAddPrepTask !== undefined
      ? { label: 'Prep task', onPress: onAddPrepTask }
      : undefined,
    chips.list && onAddList !== undefined
      ? { label: 'List', onPress: onAddList }
      : undefined,
    chips.update && onWriteUpdate !== undefined
      ? { label: 'Update', onPress: onWriteUpdate }
      : undefined,
  ].filter(
    (entry): entry is { label: string; onPress: () => void } => entry !== undefined,
  );
  if (entries.length === 0) return null;

  return (
    <View style={{ gap: theme.space[3] }} testID="add-to-plan">
      <SectionHeader title="Add to this plan" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        {entries.map((entry) => (
          <Touchable
            key={entry.label}
            accessibilityRole="button"
            accessibilityLabel={`Add ${entry.label.toLowerCase()} to this plan`}
            onPress={entry.onPress}
            testID={`add-to-plan-${entry.label.toLowerCase().replaceAll(' ', '-')}`}
          >
            <Chip label={entry.label} />
          </Touchable>
        ))}
      </View>
    </View>
  );
}
