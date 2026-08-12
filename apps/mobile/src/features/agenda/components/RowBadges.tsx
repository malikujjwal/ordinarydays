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
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space[3],
      }}
    >
      {recurrenceDescription === undefined ? null : (
        <View
          accessible
          accessibilityLabel={recurrenceDescription}
          testID="agenda-badge-recurrence"
        >
          <Text variant="subhead" color="textSecondary">
            ↻
          </Text>
        </View>
      )}
      {original === undefined || effective === undefined ? null : (
        <View
          accessible
          accessibilityLabel={`Snoozed from ${original} to ${effective}`}
          testID="agenda-badge-snooze"
        >
          <Text variant="footnote" color="textSecondary">
            <Text testID="agenda-snooze-original" variant="footnote" color="textDisabled">
              {original}
            </Text>
            {` → ${effective}`}
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
