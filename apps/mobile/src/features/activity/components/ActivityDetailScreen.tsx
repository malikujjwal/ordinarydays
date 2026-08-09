import type { PatchActivityInput } from '@od/shared/schemas';
import type { Activity } from '@od/shared/types';
import {
  Button,
  EmptyState,
  Field,
  IconButton,
  MoreHorizontal,
  SectionHeader,
  Skeleton,
  Text,
  useBreakpoint,
  useTheme,
} from '@od/ui';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ComingSoonSection } from '@/features/activity/components/ComingSoonSection';
import { OverflowMenu } from '@/features/activity/components/OverflowMenu';
import { RescheduleSheet } from '@/features/activity/components/RescheduleSheet';
import { WhenWhereBlock } from '@/features/activity/components/WhenWhereBlock';
import { useActivityDetail } from '@/features/activity/hooks/useActivity';
import type { WallDate } from '@/features/activity/model/dates';
import { sectionsFor, subtitleFor } from '@/features/activity/model/sections';
import { planKindLabel } from '@/lib/planKinds';

/**
 * The Activity detail screen (P1-26).
 *
 * One `GET /v1/activities/:id`, which is one DynamoDB Query. Editing is **in place**: there
 * is no edit mode and no per-field Save button. Text commits on blur, pickers commit on
 * selection, and each issues its own `PATCH` with `If-Match` (`activities.md` §6.1).
 *
 * ## The two rules this screen exists to hold
 *
 * - **Rule 6 / U1: tapping a row opens; it never mutates.** Nothing on this screen writes
 *   from a tap except the controls that are *about* writing — a field losing focus, a chip in
 *   the reschedule sheet.
 * - **U4: tapping a date or a time opens the reschedule sheet**, anywhere it is rendered. It
 *   never turns the row into an editable field. `WhenWhereBlock` owns that target.
 *
 * ## Layout at width
 *
 * `design-system.md` §8: single column at `compact`, capped and centred from `medium` up. The
 * cap is what stops a 1280 px browser rendering a 1200 px line of body text — the mock's
 * measure is ~620 pt and that is what the content column uses at `expanded`.
 *
 * The **two-pane master/detail** that §8 describes at `expanded` is *not* built here. It is a
 * shell concern — the left rail replacing the tab bar, a list pane owning selection, this
 * screen filling the right pane — and it belongs with the rail, which P1-23 has not built
 * either. At `expanded` this screen is therefore a centred column and pushes as a route, which
 * §8 names as the `medium` fallback: "nothing is lost, only rearranged". Flagged in the PR.
 */
export interface ActivityDetailScreenProps {
  activityId: string;
  /** The user's today, in their zone. Injected so the quick chips are testable (§4.3). */
  today: WallDate;
  onBack: () => void;
}

export function ActivityDetailScreen({
  activityId,
  today,
  onBack,
}: ActivityDetailScreenProps) {
  const theme = useTheme();
  const breakpoint = useBreakpoint();
  const insets = useSafeAreaInsets();
  const detail = useActivityDetail(activityId);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const activity = detail.detail?.activity;

  /** The measure, per §8. `compact` is full width minus the gutters. */
  const maxWidth =
    breakpoint === 'compact' ? undefined : breakpoint === 'medium' ? 720 : 620;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: insets.top + theme.space[3],
          paddingHorizontal: theme.space[5],
          paddingBottom: theme.space[3],
        }}
      >
        <Button label="Back" variant="ghost" onPress={onBack} testID="detail-back" />
        {activity === undefined ? null : (
          <IconButton
            icon={MoreHorizontal}
            label="More"
            onPress={() => setMenuOpen(true)}
            testID="detail-overflow"
          />
        )}
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space[5],
          paddingBottom: insets.bottom + theme.space[8],
        }}
      >
        <View
          style={{
            gap: theme.space[7],
            width: '100%',
            alignSelf: 'center',
            ...(maxWidth === undefined ? {} : { maxWidth }),
          }}
        >
          {detail.status === 'pending' ? (
            // A skeleton matching the real layout's shape, not a spinner (§5.1).
            <View style={{ gap: theme.space[5] }} testID="detail-loading">
              <Skeleton shape="text" count={2} />
              <Skeleton shape="card" count={1} />
              <Skeleton shape="row" count={3} />
            </View>
          ) : detail.status === 'error' || activity === undefined ? (
            <View testID="detail-error">
              <EmptyState
                heading={detail.message ?? "Couldn't load this."}
                {...(detail.requestId === undefined ? {} : { body: detail.requestId })}
                action={{ label: 'Try again', onPress: detail.refetch }}
              />
            </View>
          ) : (
            <Loaded
              activity={activity}
              detail={detail}
              today={today}
              onOpenReschedule={() => setRescheduleOpen(true)}
            />
          )}
        </View>
      </ScrollView>

      {activity === undefined ? null : (
        <>
          <RescheduleSheet
            open={rescheduleOpen}
            onClose={() => setRescheduleOpen(false)}
            today={today}
            value={activity.schedule?.date}
            onChoose={(date) =>
              void detail.patch({
                schedule: {
                  date,
                  timezone:
                    activity.schedule?.timezone ??
                    Intl.DateTimeFormat().resolvedOptions().timeZone,
                  ...(activity.schedule?.time === undefined
                    ? {}
                    : { time: activity.schedule.time }),
                },
              })
            }
            onClear={() => void detail.patch({ schedule: null })}
          />
          <OverflowMenu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            activity={activity}
            onChangePlanKind={() => {}}
            onChangeObject={() => {}}
          />
        </>
      )}
    </View>
  );
}

interface LoadedProps {
  activity: Activity;
  detail: ReturnType<typeof useActivityDetail>;
  today: WallDate;
  onOpenReschedule: () => void;
}

function Loaded({ activity, detail, today, onOpenReschedule }: LoadedProps) {
  const theme = useTheme();
  const sections = sectionsFor(activity);

  return (
    <>
      {detail.conflict === undefined ? null : (
        <View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          testID="detail-conflict"
          style={{
            gap: theme.space[2],
            padding: theme.space[5],
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.warningSurface,
          }}
        >
          <Text variant="subhead" color="textPrimary">
            {detail.conflict.message}
          </Text>
          {detail.conflict.dropped === undefined ? null : (
            <Text variant="footnote" color="textSecondary">
              {detail.conflict.dropped}
            </Text>
          )}
          <Button
            label="Review"
            variant="ghost"
            onPress={detail.acknowledgeConflict}
            testID="detail-conflict-review"
          />
        </View>
      )}

      {/**
       * The title is the screen's header, not a form row (`plans-and-lists.md` §2.1 row 1):
       * serif `title`, no fill, no drawn label — and still inline-editable by the owner,
       * committing on blur like every other field.
       */}
      <InlineText
        label="Title"
        value={activity.title}
        hideLabel
        appearance="bare"
        textVariant="title"
        onCommit={(title) => detail.patch({ title })}
        testID="detail-title"
      />
      <Text variant="footnote" color="textSecondary" testID="detail-subtitle">
        {subtitleFor(
          activity,
          activity.objectKind === 'plan' ? planKindLabel(activity.type) : '',
        )}
      </Text>

      {detail.editError === undefined ? null : (
        <Text variant="footnote" color="danger" testID="detail-edit-error">
          {detail.editError}
        </Text>
      )}

      {sections.map((section) => {
        if (section.state === 'coming-soon') {
          return (
            <ComingSoonSection
              key={section.key}
              heading={section.heading ?? ''}
              action={section.action ?? ''}
              note={section.note ?? ''}
              testID={`section-${section.key}`}
            />
          );
        }

        if (section.key === 'whenWhere') {
          return (
            <WhenWhereBlock
              key={section.key}
              schedule={activity.schedule}
              location={activity.location}
              reminders={detail.detail?.reminders ?? []}
              today={today}
              onPressDate={onOpenReschedule}
              onPressAddress={undefined}
            />
          );
        }

        if (section.key === 'notes') {
          return (
            <View
              key={section.key}
              style={{ gap: theme.space[3] }}
              testID="section-notes"
            >
              <SectionHeader title="Notes" />
              {/* `hideLabel`: the SectionHeader above already says NOTES. */}
              <InlineText
                label="Notes"
                value={activity.notes ?? ''}
                hideLabel
                multiline
                placeholder="Add notes"
                onCommit={(notes) => detail.patch({ notes })}
                testID="detail-notes"
              />
            </View>
          );
        }

        // Related plan — the parent link on a prep task (`today-and-tasks.md` §5.5).
        return (
          <View
            key={section.key}
            style={{ gap: theme.space[3] }}
            testID="section-related"
          >
            <SectionHeader title="Related plan" />
            <Text variant="body" color="textSecondary">
              {activity.parentActivityId === undefined ? 'None' : 'Part of a plan'}
            </Text>
          </View>
        );
      })}
    </>
  );
}

/**
 * A field that commits on blur and on nothing else.
 *
 * The local copy exists so typing does not fight the query cache mid-keystroke; it is
 * re-synced whenever the server's value changes underneath — which is what makes a 409
 * refetch visible in the field rather than being masked by stale local state.
 *
 * **A commit fires only when the trimmed value actually differs.** Without that, tabbing
 * through a form would issue a `PATCH` per field, each one moving `updatedAt` and each one a
 * chance to collide with somebody else's edit.
 */
function InlineText({
  label,
  value,
  onCommit,
  multiline = false,
  placeholder,
  hideLabel = false,
  appearance,
  textVariant,
  testID,
}: {
  label: string;
  value: string;
  onCommit: (next: string) => void | Promise<void>;
  multiline?: boolean;
  placeholder?: string;
  hideLabel?: boolean;
  appearance?: 'boxed' | 'bare';
  textVariant?: 'body' | 'title';
  testID?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <Field
      label={label}
      value={draft}
      onChangeText={setDraft}
      multiline={multiline}
      hideLabel={hideLabel}
      {...(appearance === undefined ? {} : { appearance })}
      {...(textVariant === undefined ? {} : { textVariant })}
      {...(placeholder === undefined ? {} : { placeholder })}
      onBlur={() => {
        if (draft.trim() === value.trim()) return;
        void onCommit(draft.trim());
      }}
      {...(testID === undefined ? {} : { testID })}
    />
  );
}

/** The patch type is re-exported so the route file does not reach into `@od/shared`. */
export type { PatchActivityInput };
