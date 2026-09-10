import { formatMinorUnits } from '@od/shared/money';
import type { Activity, ActivityDetails, EventReservation } from '@od/shared/types';
import { Text, Touchable, useTheme } from '@od/ui';
import { Linking, View } from 'react-native';
import { SectionFrame } from '@/features/activity/components/SectionFrame';
import { formatWallTime } from '@/features/activity/model/dates';
import {
  shownSourceUrl,
  type TypeDetailSectionKey,
  typeDetailSectionsFor,
} from '@/features/activity/model/sections';
import type { PendingActivity } from '@/lib/pendingActivity';

type DisplayActivity = Activity | PendingActivity;

/**
 * Read-only type-fact sections on Activity detail (mock v2 agreeing subset).
 *
 * Topic-named `SectionFrame` content after settings and before PREPARATION. Empty groups
 * omit the section. There is no Edit trailing action and no chip row in this slice.
 */
export function TypeDetailsSection({ activity }: { activity: DisplayActivity }) {
  const keys = typeDetailSectionsFor(activity);
  if (keys.length === 0) return null;
  return (
    <>
      {keys.map((key) => (
        <TypeDetailGroup activity={activity} sectionKey={key} key={key} />
      ))}
    </>
  );
}

function TypeDetailGroup({
  activity,
  sectionKey,
}: {
  activity: DisplayActivity;
  sectionKey: TypeDetailSectionKey;
}) {
  const { details } = activity;
  switch (sectionKey) {
    case 'recipe':
      return details.kind === 'meal' && details.recipeUrl !== undefined ? (
        <SectionFrame label="Recipe" testID="section-recipe">
          <LinkFact label="Recipe link" url={details.recipeUrl} />
        </SectionFrame>
      ) : null;
    case 'watching':
      return details.kind === 'watch' ? (
        <SectionFrame label="Watching" testID="section-watching">
          <WatchingFacts details={details} />
        </SectionFrame>
      ) : null;
    case 'description':
      return details.kind === 'event' && details.description !== undefined ? (
        <SectionFrame label="Description" testID="section-description">
          {activity.visibility === 'shared' ? (
            <Text variant="footnote" color="textSecondary" testID="description-privacy">
              Everyone you invite can read this.
            </Text>
          ) : null}
          <Text variant="body" color="textPrimary" numberOfLines={0}>
            {details.description}
          </Text>
        </SectionFrame>
      ) : null;
    case 'reservation':
      return details.kind === 'event' && details.reservation !== undefined ? (
        <SectionFrame label="Reservation" testID="section-reservation">
          <ReservationFacts reservation={details.reservation} />
        </SectionFrame>
      ) : null;
    case 'tickets':
      return details.kind === 'event' ? (
        <SectionFrame label="Tickets" testID="section-tickets">
          {details.priceCents === undefined ? null : (
            <DataFact
              label="Price"
              value={
                details.currency === undefined
                  ? formatMinorUnits(details.priceCents)
                  : formatMinorUnits(details.priceCents, details.currency)
              }
            />
          )}
          {details.ticketUrl === undefined ? null : (
            <LinkFact label="Ticket link" url={details.ticketUrl} />
          )}
        </SectionFrame>
      ) : null;
    case 'link': {
      const url = shownSourceUrl(activity);
      return url === undefined ? null : (
        <SectionFrame label="Link" testID="section-link">
          <LinkFact label="Opens" url={url} />
        </SectionFrame>
      );
    }
  }
}

function WatchingFacts({
  details,
}: {
  details: Extract<ActivityDetails, { kind: 'watch' }>;
}) {
  const movie = details.mediaKind === 'movie';
  const season = movie ? undefined : details.season;
  const episode = movie ? undefined : details.episode;
  const mediaParts: string[] = [];
  if (season !== undefined) mediaParts.push(`Season ${season}`);
  if (episode !== undefined) mediaParts.push(`Episode ${episode}`);
  const mediaLine = mediaParts.length === 0 ? undefined : mediaParts.join(' · ');
  return (
    <>
      {mediaLine === undefined ? (
        details.episodeTitle === undefined ? null : (
          <DataFact label="Episode title" value={details.episodeTitle} />
        )
      ) : (
        <FactBlock
          primary={mediaLine}
          secondary={details.episodeTitle}
          accessibilityLabel={
            details.episodeTitle === undefined
              ? mediaLine
              : `${mediaLine}, ${details.episodeTitle}`
          }
        />
      )}
      {details.service === undefined ? null : (
        <DataFact label="Streaming service" value={details.service} />
      )}
    </>
  );
}

function ReservationFacts({ reservation }: { reservation: EventReservation }) {
  const rest: string[] = [];
  if (reservation.time !== undefined) rest.push(formatWallTime(reservation.time));
  if (reservation.partySize !== undefined) {
    rest.push(
      `${reservation.partySize} ${reservation.partySize === 1 ? 'person' : 'people'}`,
    );
  }
  if (reservation.reference !== undefined) rest.push(`Ref ${reservation.reference}`);
  const restLine = rest.join(' · ');
  const primary = reservation.name ?? restLine;
  const secondary = reservation.name === undefined ? undefined : restLine;
  const spoken = [reservation.name, restLine].filter((part) => part !== '').join(', ');
  return (
    <FactBlock
      primary={primary}
      secondary={secondary === '' ? undefined : secondary}
      accessibilityLabel={`Reservation: ${spoken}`}
    />
  );
}

function FactBlock({
  primary,
  secondary,
  accessibilityLabel,
}: {
  primary: string;
  secondary?: string;
  accessibilityLabel: string;
}) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      style={{
        gap: theme.space[1],
        minHeight: theme.layout.hitTarget,
        justifyContent: 'center',
      }}
    >
      <Text variant="body" color="textPrimary" numberOfLines={2}>
        {primary}
      </Text>
      {secondary === undefined ? null : (
        <Text variant="footnote" color="textSecondary" numberOfLines={2}>
          {secondary}
        </Text>
      )}
    </View>
  );
}

function DataFact({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}, ${value}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
        minHeight: theme.layout.hitTarget,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="body" color="textPrimary" numberOfLines={1}>
          {label}
        </Text>
      </View>
      <Text variant="body" color="textSecondary" numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function LinkFact({ label, url }: { label: string; url: string }) {
  const theme = useTheme();
  const host = hostFromUrl(url);
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${host}`}
      onPress={() => {
        void Linking.openURL(url).catch(() => undefined);
      }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
        minHeight: theme.layout.hitTarget,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="body" color="textPrimary" numberOfLines={1}>
          {label}
        </Text>
      </View>
      <Text variant="body" color="textAction" numberOfLines={1}>
        {host}
      </Text>
    </Touchable>
  );
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
