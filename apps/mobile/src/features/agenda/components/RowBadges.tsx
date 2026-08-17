import type { AgendaParticipantAvatar } from '@od/shared/types';
import { AvatarStack, Chip, formatWallTime, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { OverdueChip } from './OverdueChip';

export interface RowBadgesProps {
  recurrenceDescription?: string;
  originalTime?: string;
  effectiveTime?: string;
  overdueFromDate?: string;
  today?: string;
  participantAvatars: readonly AgendaParticipantAvatar[];
  /** Phase 6 supplies this projection value; the slot intentionally renders empty today. */
  pendingRsvpLabel?: string;
  onOpenOverdue?: () => void;
}

/** Projection-backed badges in the canonical recurrence → snooze → overdue → people → RSVP order. */
export function RowBadges({
  recurrenceDescription,
  originalTime,
  effectiveTime,
  overdueFromDate,
  today,
  participantAvatars,
  pendingRsvpLabel,
  onOpenOverdue,
}: RowBadgesProps) {
  const theme = useTheme();
  const original = originalTime === undefined ? undefined : formatWallTime(originalTime);
  const effective =
    effectiveTime === undefined ? undefined : formatWallTime(effectiveTime);
  const hasOverdue = overdueFromDate !== undefined && today !== undefined;
  const people = participantAvatars.map(({ displayName, avatarUrl }) => ({
    displayName,
    ...(avatarUrl === undefined ? {} : { imageUrl: avatarUrl }),
  }));

  if (
    recurrenceDescription === undefined &&
    (original === undefined || effective === undefined) &&
    !hasOverdue &&
    people.length === 0 &&
    pendingRsvpLabel === undefined
  ) {
    return null;
  }

  return (
    <View
      testID="agenda-row-badges"
      /**
       * **`box-none`: the strip is never the tap target, its chips still are.**
       *
       * It is painted after the row's backdrop, so as an ordinary `View` it sat on top of it and
       * swallowed every tap in its band — the founder's report that the area around the `↻`
       * badge stayed dead after the backdrop landed. `box-none` lets the press fall through to
       * the backdrop while the overdue chip and any future interactive badge keep theirs.
       */
      pointerEvents="box-none"
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space[3],
      }}
    >
      {/**
       * **One metadata line, and it says something** — founder, 2026-08-17.
       *
       * The glyph rendered alone with its description hidden in an `accessibilityLabel`, so a
       * recurring row was a whole line taller than a non-recurring one and carried a single
       * character of information for it. The line now reads `↻ Repeats daily`, or
       * `↻ 6:00 PM → 7:00 PM` when a snooze has moved the occurrence — the change being the more
       * useful of the two whenever there is one.
       *
       * Same height as before, earning it. `footnote` keeps it below the title in the hierarchy.
       */}
      {recurrenceDescription === undefined &&
      (original === undefined || effective === undefined) ? null : (
        <View
          accessible
          accessibilityLabel={
            original !== undefined && effective !== undefined
              ? `Snoozed from ${original} to ${effective}`
              : (recurrenceDescription ?? '')
          }
          testID="agenda-badge-recurrence"
        >
          <Text variant="footnote" color="textSecondary" numberOfLines={1}>
            {/**
             * **The glyph only when the row actually recurs.** A one-off can be snoozed too, and
             * leading its line with `↻` would say "this repeats" about something that does not —
             * `design-system.md` §0's first rule, that every sign means one thing and no other.
             */}
            {recurrenceDescription === undefined ? '' : '↻  '}
            {original !== undefined && effective !== undefined ? (
              <Text variant="footnote" color="textSecondary">
                {/* The pre-snooze time carries meaning, so it is muted, never disabled. */}
                <Text
                  testID="agenda-snooze-original"
                  variant="footnote"
                  color="textMuted"
                >
                  {original}
                </Text>
                {` → ${effective}`}
              </Text>
            ) : (
              recurrenceDescription
            )}
          </Text>
        </View>
      )}
      {!hasOverdue ? null : (
        <OverdueChip
          overdueFromDate={overdueFromDate}
          today={today}
          {...(onOpenOverdue === undefined ? {} : { onPress: onOpenOverdue })}
        />
      )}
      {people.length === 0 ? null : (
        <View
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID="agenda-badge-participants"
        >
          <AvatarStack people={people} max={3} />
        </View>
      )}
      {pendingRsvpLabel === undefined ? null : (
        <Chip
          label={pendingRsvpLabel}
          tone="warning"
          testID="agenda-badge-pending-rsvp"
        />
      )}
    </View>
  );
}
