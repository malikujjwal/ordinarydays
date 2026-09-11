import { formatMinorUnits } from '@od/shared/money';
import type {
  Activity,
  ActivityDetails,
  ActivityParentSummary,
  ActivitySourceList,
  EventReservation,
} from '@od/shared/types';
import { assertNever } from '@od/shared/types';
import { ChevronRight, Text, Touchable, useTheme } from '@od/ui';
import { Linking, View } from 'react-native';
import { SectionFrame } from '@/features/activity/components/SectionFrame';
import { formatWallTime } from '@/features/activity/model/dates';
import {
  type DetailRowKey,
  detailRowsFor,
  shownSourceUrl,
} from '@/features/activity/model/sections';
import type { PendingActivity } from '@/lib/pendingActivity';

type DisplayActivity = Activity | PendingActivity;

/**
 * The one `Details` group on Activity detail (founder, 2026-09-10).
 *
 * Replaces the six topic sections (RECIPE / WATCHING / DESCRIPTION / RESERVATION / TICKETS /
 * LINK) and the `Related plan` / `From <list>` setting rows with one ruled, label-left /
 * value-right list under one caption heading and one trailing `Edit`. It renders only when
 * {@link detailRowsFor} yields at least one row. A row that opens something is the whole
 * target — a link opens the browser (`↗`), `Part of` and `From` navigate (chevron) — and a
 * row never mutates (rule 6).
 */
export interface DetailsSectionProps {
  activity: DisplayActivity;
  /** The envelope's named parent plan; absent leaves `Part of` reading `A plan`. */
  parent: ActivityParentSummary | undefined;
  sourceList: ActivitySourceList | undefined;
  onOpenParent?: (activityId: string) => void;
  onOpenList?: (listId: string) => void;
  /** The one `Edit`: the type sheet on Meal / Watch / Event, the Link sheet otherwise. */
  onEdit?: () => void;
}

export function DetailsSection({
  activity,
  parent,
  sourceList,
  onOpenParent,
  onOpenList,
  onEdit,
}: DetailsSectionProps) {
  const keys = detailRowsFor(activity, { hasSourceList: sourceList !== undefined });
  if (keys.length === 0) return null;
  return (
    <SectionFrame
      label="Details"
      ruled
      testID="section-details"
      {...(onEdit === undefined
        ? {}
        : {
            trailing: 'Edit',
            trailingAccessibilityLabel: 'Edit details',
            onTrailingPress: onEdit,
            trailingTestID: 'details-edit',
          })}
    >
      {keys.map((key) => (
        <DetailRowFor
          key={key}
          rowKey={key}
          activity={activity}
          parent={parent}
          sourceList={sourceList}
          {...(onOpenParent === undefined ? {} : { onOpenParent })}
          {...(onOpenList === undefined ? {} : { onOpenList })}
        />
      ))}
    </SectionFrame>
  );
}

function DetailRowFor({
  rowKey,
  activity,
  parent,
  sourceList,
  onOpenParent,
  onOpenList,
}: {
  rowKey: DetailRowKey;
  activity: DisplayActivity;
  parent: ActivityParentSummary | undefined;
  sourceList: ActivitySourceList | undefined;
  onOpenParent?: (activityId: string) => void;
  onOpenList?: (listId: string) => void;
}) {
  const { details } = activity;
  switch (rowKey) {
    case 'recipe':
      return details.kind === 'meal' && details.recipeUrl !== undefined ? (
        <LinkRow label="Recipe" url={details.recipeUrl} testID="details-recipe" />
      ) : null;
    case 'episode':
      return details.kind === 'watch' ? <EpisodeRow details={details} /> : null;
    case 'service': {
      const service =
        details.kind === 'watch' ? shownFreeText(details.service) : undefined;
      return service === undefined ? null : (
        <DetailRow label="Service" value={service} testID="details-service" />
      );
    }
    case 'booking':
      return details.kind === 'event' && details.reservation !== undefined ? (
        <BookingRow reservation={details.reservation} />
      ) : null;
    case 'tickets':
      return details.kind === 'event' ? <TicketsRow details={details} /> : null;
    case 'organiser': {
      const organiser =
        details.kind === 'event' ? shownFreeText(details.organiser) : undefined;
      return organiser === undefined ? null : (
        <DetailRow label="Organiser" value={organiser} testID="details-organiser" />
      );
    }
    case 'description': {
      const description =
        details.kind === 'event' ? shownFreeText(details.description) : undefined;
      return description === undefined ? null : (
        <DescriptionRow text={description} shared={activity.visibility === 'shared'} />
      );
    }
    case 'link': {
      const url = shownSourceUrl(activity);
      return url === undefined ? null : (
        <LinkRow label="Link" url={url} testID="details-link" />
      );
    }
    case 'partOf': {
      // Named when the envelope could title the parent; `A plan`, inert, otherwise.
      const open =
        parent === undefined || onOpenParent === undefined
          ? undefined
          : () => onOpenParent(parent.activityId);
      return (
        <DetailRow
          label="Part of"
          value={parent?.title ?? 'A plan'}
          {...(open === undefined ? {} : { onPress: open, trailing: 'chevron' as const })}
          testID="section-related"
        />
      );
    }
    case 'from': {
      if (sourceList === undefined) return null;
      const open =
        onOpenList === undefined ? undefined : () => onOpenList(sourceList.listId);
      return (
        <DetailRow
          label="From"
          value={sourceList.title}
          {...(open === undefined ? {} : { onPress: open, trailing: 'chevron' as const })}
          testID="section-from-list"
        />
      );
    }
    default:
      return assertNever(rowKey, 'DetailRowKey');
  }
}

/** `S2 · E4` with the episode title beneath; a movie never shows season or episode. */
function EpisodeRow({
  details,
}: {
  details: Extract<ActivityDetails, { kind: 'watch' }>;
}) {
  const movie = details.mediaKind === 'movie';
  const parts: string[] = [];
  if (!movie && details.season !== undefined) parts.push(`S${details.season}`);
  if (!movie && details.episode !== undefined) parts.push(`E${details.episode}`);
  const episodeTitle = shownFreeText(details.episodeTitle);
  const progress = parts.length === 0 ? undefined : parts.join(' · ');
  const value = progress ?? episodeTitle;
  if (value === undefined) return null;
  return (
    <DetailRow
      label="Episode"
      value={value}
      {...(progress === undefined || episodeTitle === undefined
        ? {}
        : { secondary: episodeTitle })}
      testID="details-episode"
    />
  );
}

/** `Noble Rot · 7:30 PM` over `2 people · Ref X`, from whichever fields exist. */
function BookingRow({ reservation }: { reservation: EventReservation }) {
  const first: string[] = [];
  const name = shownFreeText(reservation.name);
  if (name !== undefined) first.push(name);
  if (reservation.time !== undefined) first.push(formatWallTime(reservation.time));
  const second: string[] = [];
  if (reservation.partySize !== undefined) {
    second.push(
      `${reservation.partySize} ${reservation.partySize === 1 ? 'person' : 'people'}`,
    );
  }
  const reference = shownFreeText(reservation.reference);
  if (reference !== undefined) second.push(`Ref ${reference}`);
  const primary = (first.length > 0 ? first : second).join(' · ');
  const secondary =
    first.length > 0 && second.length > 0 ? second.join(' · ') : undefined;
  if (primary === '') return null;
  return (
    <DetailRow
      label="Booking"
      value={primary}
      {...(secondary === undefined ? {} : { secondary })}
      testID="details-booking"
    />
  );
}

/** The formatted price (integer minor units, never float maths) and the ticket host `↗`. */
function TicketsRow({
  details,
}: {
  details: Extract<ActivityDetails, { kind: 'event' }>;
}) {
  const price =
    details.priceCents === undefined
      ? undefined
      : details.currency === undefined
        ? formatMinorUnits(details.priceCents)
        : formatMinorUnits(details.priceCents, details.currency);
  const url = details.ticketUrl;
  const host = url === undefined ? undefined : hostFromUrl(url);
  const value = price ?? host;
  if (value === undefined) return null;
  return (
    <DetailRow
      label="Tickets"
      value={value}
      {...(price !== undefined && host !== undefined ? { secondary: `${host} ↗` } : {})}
      {...(url === undefined
        ? {}
        : {
            onPress: () => openUrl(url),
            trailing: price === undefined ? ('external' as const) : undefined,
          })}
      testID="details-tickets"
    />
  );
}

function LinkRow({ label, url, testID }: { label: string; url: string; testID: string }) {
  return (
    <DetailRow
      label={label}
      value={hostFromUrl(url)}
      onPress={() => openUrl(url)}
      trailing="external"
      testID={testID}
    />
  );
}

/** A full-width paragraph with its caption above, not a label/value pair. */
function DescriptionRow({ text, shared }: { text: string; shared: boolean }) {
  const theme = useTheme();
  return (
    <View
      testID="details-description"
      style={{
        gap: theme.space[2],
        paddingVertical: theme.space[4],
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <Text variant="footnote" color="textSecondary">
        Description
      </Text>
      {shared ? (
        <Text variant="footnote" color="textSecondary" testID="description-privacy">
          Everyone you invite can read this.
        </Text>
      ) : null}
      <Text variant="body" color="textPrimary" numberOfLines={0}>
        {text}
      </Text>
    </View>
  );
}

/**
 * One label-left / value-right row, ~48 pt, closed by its own rule. When it opens something
 * the whole row is the target and the value takes the action ink, like `SettingRow`'s.
 */
function DetailRow({
  label,
  value,
  secondary,
  onPress,
  trailing,
  testID,
}: {
  label: string;
  value: string;
  secondary?: string;
  onPress?: () => void;
  trailing?: 'external' | 'chevron' | undefined;
  testID: string;
}) {
  const theme = useTheme();
  const interactive = onPress !== undefined;
  const spoken = [label, value, secondary].filter(Boolean).join(', ');
  const style = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.space[4],
    minHeight: theme.space[10],
    paddingVertical: theme.space[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  };
  const content = (
    <>
      <Text variant="subhead" color="textSecondary">
        {label}
      </Text>
      <View style={{ flex: 1, minWidth: 0, alignItems: 'flex-end', gap: theme.space[1] }}>
        <Text
          variant="subhead"
          color={interactive ? 'textAction' : 'textPrimary'}
          numberOfLines={2}
          align="right"
        >
          {trailing === 'external' ? `${value} ↗` : value}
        </Text>
        {secondary === undefined ? null : (
          <Text variant="footnote" color="textSecondary" numberOfLines={2} align="right">
            {secondary}
          </Text>
        )}
      </View>
      {trailing === 'chevron' && interactive ? (
        <View aria-hidden>
          <ChevronRight size={20} color={theme.colors.accentControl} />
        </View>
      ) : null}
    </>
  );
  if (!interactive) {
    return (
      <View accessible accessibilityLabel={spoken} style={style} testID={testID}>
        {content}
      </View>
    );
  }
  return (
    <Touchable
      square={false}
      accessibilityRole={trailing === 'chevron' ? 'button' : 'link'}
      accessibilityLabel={spoken}
      onPress={onPress}
      style={style}
      testID={testID}
    >
      {content}
    </Touchable>
  );
}

function openUrl(url: string) {
  void Linking.openURL(url).catch(() => undefined);
}

/** `freeText` allows `''`; blank is the same as absent on the detail rows. */
function shownFreeText(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
