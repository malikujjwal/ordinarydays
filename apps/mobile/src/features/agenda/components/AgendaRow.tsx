import type { AgendaItem } from '@od/shared/types';
import { Chip, formatWallTime, Text, Touchable, useTheme } from '@od/ui';
import type { AccessibilityActionEvent } from 'react-native';
import { View } from 'react-native';
import { isFutureRecurringOccurrence } from '@/features/agenda/model/rowScope';
import {
  canResolvePassedAgendaItem,
  outcomeVerb,
  passedPlanResolution,
} from '@/lib/passedPlanResolution';
import { OverdueChip } from './OverdueChip';
import { RowBadges } from './RowBadges';
import { RowLeading } from './RowLeading';

export interface AgendaRowProps {
  item: AgendaItem;
  today?: string;
  /** Date context spoken for untimed rows outside Today. */
  untimedContextLabel?: string;
  showTime?: boolean;
  /** A tinted containing surface may require primary ink to retain AA contrast. */
  subtitleColor?: 'textPrimary' | 'textSecondary';
  /**
   * Prepended to the server's `subtitle`, `·`-joined — the UP NEXT card's
   * `2:30 PM · Jefferson Dental Center` (`design-system.md` §7.1).
   *
   * The card has no time rail, so its time belongs on the subtitle line. The server's own
   * `subtitle` is still rendered verbatim after it: this composes two projected fields for
   * display, it does not replace or reinterpret either.
   */
  subtitlePrefix?: string;
  /** Cards turn off the ordinary list divider while retaining this same row body. */
  divider?: boolean;
  /**
   * Drops the row's own vertical padding and list minimum — for a row inside a `Card`, which
   * supplies both already (P2-44).
   *
   * Without it the UP NEXT card paid for its padding twice and stood a third taller than it
   * needed to, which is most of what the founder meant by the card being disproportionate. It
   * removes a **minimum**, never fixing a height: the row is still content-sized and still grows
   * under dynamic type, so `design-system.md` §0's "fixed-height rows do not exist" holds.
   */
  dense?: boolean;
  /**
   * The timeline connector (`design-system.md` §7.1, P2-44) — "it is what makes the day read as
   * a timeline".
   *
   * One flag, not two halves: a row draws the link **beneath** it, and the section's last row
   * draws none. It was a pair meeting at the marker's centre, which ran the line through every
   * glyph. Purely decorative, so it is hidden from assistive technology — a screen reader hears
   * the rows, not the line between them.
   */
  connectorBelow?: boolean;
  onOpen: (item: AgendaItem) => void;
  onToggleComplete?: (item: AgendaItem, checked: boolean) => void;
  onOpenReschedule?: (item: AgendaItem) => void;
  onOpenOverdue?: (item: AgendaItem) => void;
  onOpenResolution?: (item: AgendaItem) => void;
  accessibilityActions?: { name: string; label: string }[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
  onBodyFocus?: () => void;
  onBodyBlur?: () => void;
}

const COMPLETED_STATUSES = new Set<AgendaItem['status']>([
  'completed',
  'completed_occurrence',
]);

const SKIPPED_STATUSES = new Set<AgendaItem['status']>(['skipped', 'skipped_occurrence']);

function bodyLabel(
  item: AgendaItem,
  checked: boolean,
  untimedContextLabel: string,
): string {
  const parts = [item.title];
  if (checked) parts.push(outcomeVerb(item.type));
  // Spoken as well as shown: dimming is not a state a screen reader can hear.
  if (SKIPPED_STATUSES.has(item.status)) parts.push('Skipped');
  if (item.subtitle !== undefined) parts.push(item.subtitle);
  if (item.time === undefined) parts.push(untimedContextLabel, 'no time');
  else parts.push(formatWallTime(item.time));
  if (item.recurrenceDescription !== undefined) parts.push(item.recurrenceDescription);
  if (item.locationLabel !== undefined) parts.push(item.locationLabel);
  if (item.participantAvatars.length > 0) {
    parts.push(
      `with ${item.participantAvatars.map(({ displayName }) => displayName).join(', ')}`,
    );
  }
  return parts.join(', ');
}

/** The shared agenda row body; gestures and optimistic state are added by their owning tasks. */
export function AgendaRow({
  item,
  today,
  untimedContextLabel = 'today',
  showTime = false,
  subtitleColor = 'textSecondary',
  subtitlePrefix,
  divider = true,
  dense = false,
  connectorBelow = false,
  onOpen,
  onToggleComplete,
  onOpenReschedule,
  onOpenOverdue,
  onOpenResolution,
  accessibilityActions,
  onAccessibilityAction,
  onBodyFocus,
  onBodyBlur,
}: AgendaRowProps) {
  const theme = useTheme();
  const checked = COMPLETED_STATUSES.has(item.status);
  const skipped = SKIPPED_STATUSES.has(item.status);
  const dimmed = item.isPast || checked || skipped;
  const formattedTime = item.time === undefined ? undefined : formatWallTime(item.time);
  const futureRecurringCompletion =
    !checked && today !== undefined && isFutureRecurringOccurrence(item, today);

  /**
   * Where the connector runs: the horizontal centre of the leading control, and the vertical
   * centre of it. The leading column is `layout.hitTarget` wide and starts after the time rail
   * when one is shown, so both numbers are the row's own geometry rather than measured values —
   * a measured connector would flicker on first paint and be wrong under dynamic type.
   */
  /**
   * **The rail is reserved by the section, not by the row** — founder, 2026-08-17: "the tasks
   * without time ... are more left aligned than the ones with time. They should have the same
   * alignment."
   *
   * It used to depend on `formattedTime !== undefined`, so an untimed row inside a railed section
   * pulled its marker 56 pt left and the timeline's spine kinked around it. `showTime` is the
   * section's decision and now governs the offset alone; a row with no time simply leaves the
   * rail empty.
   */
  /**
   * The rail is `space[10]` wide because `12:00 PM` has to fit on one line — narrowing it to
   * `space[9]` to pull the markers left wrapped every time into two, which is worse than the
   * 4 pt it bought. The markers move left through the **gap** instead (founder, 2026-08-17).
   */
  /**
   * **One value for the rail's width and the marker's offset**, so the column can never be
   * narrower than the thing it holds.
   *
   * They were two: a `space[10]` column inside a wider offset, which left `11:35 PM` short and
   * silently wrapped it onto a second line — part of the founder's report that those rows stood
   * taller than their neighbours. `numberOfLines` pins it to one line so a future squeeze
   * ellipsises visibly rather than growing the row.
   *
   * **`space[11]`, measured rather than guessed.** The widest time this renders is `12:00 PM` at
   * **58 pt** in `footnote`; `space[10]` is 48 and truncates it, and 64 is the next token up.
   * That puts the markers 8 pt further right than before, which runs against the founder's
   * 2026-08-17 request to nudge them left — the trade is flagged rather than split, because the
   * alternative is a time column that cannot hold a time.
   */
  const railWidth = theme.space[11];
  const railOffset = showTime ? railWidth : theme.space[0];
  const markerCentreX = railOffset + theme.layout.hitTarget / 2;
  const markerCentreY = theme.space[5] + theme.layout.hitTarget / 2;

  const subtitleLine =
    subtitlePrefix === undefined
      ? item.subtitle
      : [subtitlePrefix, item.subtitle].filter((part) => part !== undefined).join(' · ');

  /**
   * The timeline's spine (founder, 2026-08-17): **from just below this row's marker to just above
   * the next row's top edge**, and absent on a section's last row.
   *
   * It used to be two halves that met at the marker's centre, so the line ran *through* every
   * glyph and butted straight into each divider. Starting it clear of the marker and stopping it
   * clear of the rule is what makes the markers read as beads on a thread rather than as circles
   * with a line drawn over them.
   */
  const connector = () => (
    <View
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      testID="agenda-row-connector-below"
      style={{
        position: 'absolute',
        left: markerCentreX,
        width: 1,
        backgroundColor: theme.colors.border,
        top: markerCentreY + theme.layout.hitTarget / 2 - theme.space[2],
        bottom: theme.space[2],
      }}
    />
  );

  return (
    <View
      testID={`agenda-row-${item.activityId}`}
      style={{
        minHeight: dense ? undefined : theme.layout.rowMinHeight,
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingVertical: dense ? theme.space[0] : theme.space[5],
        borderBottomWidth: divider ? 1 : 0,
        borderBottomColor: theme.colors.border,
        opacity: dimmed ? 0.62 : 1,
      }}
    >
      {connectorBelow ? connector() : null}

      {/**
       * **Every pixel that is not a control opens the row** (founder, 2026-08-17: "I have got
       * people to use and they keep on clicking that area").
       *
       * The badges strip, the space beside a short title and the room under a wrapped one all
       * belonged to a plain `View`. Rather than nesting the real controls inside one enormous
       * pressable — which is `nested-interactive` to axe and would swallow the checkbox — this
       * is a **backdrop**: it sits behind everything, so any control above it wins the tap, and
       * it starts after the leading column so a non-task marker still does nothing, which
       * acceptance criterion 12 requires.
       *
       * It is invisible to assistive technology and not focusable. The row body above it already
       * carries the accessible name, the role and every custom action; this is a pointer
       * convenience, never a second way in.
       */}
      <Touchable
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        focusable={false}
        onPress={() => onOpen(item)}
        testID="agenda-row-backdrop"
        style={{
          position: 'absolute',
          left: railOffset + theme.layout.hitTarget,
          right: 0,
          top: 0,
          bottom: 0,
        }}
      >
        <View />
      </Touchable>

      <View style={{ marginLeft: railOffset }}>
        <RowLeading
          hasCheckbox={item.hasCheckbox}
          checked={checked}
          title={item.title}
          disabled={futureRecurringCompletion}
          {...(onToggleComplete === undefined
            ? {}
            : { onChange: (next) => onToggleComplete(item, next) })}
        />
      </View>

      {/**
       * `box-none` for the same reason the badge strip has it: this column is painted after the
       * backdrop, so as an ordinary `View` it captured every press in its band before the
       * backdrop could see it — including the gap between the title and the badges, which is
       * where the founder's mark sat. The body `Touchable` and the chips inside keep their own.
       */}
      <View
        pointerEvents="box-none"
        style={{ flex: 1, minWidth: 0, gap: theme.space[2] }}
      >
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={bodyLabel(item, checked, untimedContextLabel)}
          {...(accessibilityActions === undefined ? {} : { accessibilityActions })}
          {...(onAccessibilityAction === undefined ? {} : { onAccessibilityAction })}
          {...(onBodyFocus === undefined ? {} : { onFocus: onBodyFocus })}
          {...(onBodyBlur === undefined ? {} : { onBlur: onBodyBlur })}
          onPress={() => onOpen(item)}
          testID="agenda-row-body"
          /**
           * **Full width, and it owns the gutter beside the marker** (founder, 2026-08-17: the
           * click issue).
           *
           * It was `alignItems: 'flex-start'` alone, which makes a flex child shrink to its
           * content — so every pixel to the right of a short title belonged to the row's outer
           * `View`, which has no `onPress`. Probing a row across its width returned the row
           * container, not the body, for most of it. The old `gap` between the marker and this
           * column was dead for the same reason and is now this element's `paddingLeft`, so the
           * pixels belong to the tap target rather than sitting between two of them.
           *
           * The checkbox and the time column stay separate targets: tapping them means
           * *complete* (U2) and *reschedule* (U4), not *open*. That is the one part of "make the
           * whole row clickable" that cannot be done.
           */
          style={{
            alignItems: 'flex-start',
            alignSelf: 'stretch',
            paddingLeft: theme.space[2],
          }}
        >
          {/**
           * `bodyStrong` over `footnote` — the founder's row grammar, 2026-08-17: "16pt
           * semibold" for the title, "13–14pt" for the line under it. The title carried the
           * regular weight and the subtitle sat at `subhead`, which put only two points between
           * them and made every row read as two equal lines.
           */}
          <Text variant="bodyStrong" struck={checked}>
            {item.title}
          </Text>
          {/**
           * **A skipped row says so** (founder, 2026-08-15). `Show skipped` renders these in
           * EARLIER TODAY "de-emphasised" (`today-and-tasks.md` §3.2), and de-emphasis was all
           * they had: 0.62 opacity and nothing else, so a skipped row and a merely past one
           * looked the same and the only way to tell them apart was to open the row.
           *
           * `textMuted` is the founder's ruling on the treatment, and it is the same token the
           * detail screen's resolved block uses, so the tag reads identically wherever the
           * state appears.
           */}
          {!skipped ? null : (
            <Text variant="subhead" color="textMuted" testID="agenda-row-skipped">
              Skipped
            </Text>
          )}
          {subtitleLine === undefined ? null : (
            <Text variant="footnote" color={subtitleColor} testID="agenda-row-subtitle">
              {subtitleLine}
            </Text>
          )}
        </Touchable>

        {dense ? null : (
          <RowBadges
            {...(!item.isRecurring || item.recurrenceDescription === undefined
              ? {}
              : { recurrenceDescription: item.recurrenceDescription })}
            {...(!item.isSnoozed || item.originalTime === undefined
              ? {}
              : { originalTime: item.originalTime })}
            {...(item.time === undefined ? {} : { effectiveTime: item.time })}
            {...(item.overdueFromDate === undefined || showTime
              ? {}
              : { overdueFromDate: item.overdueFromDate })}
            {...(today === undefined ? {} : { today })}
            participantAvatars={item.participantAvatars}
            {...(onOpenOverdue === undefined
              ? {}
              : { onOpenOverdue: () => onOpenOverdue(item) })}
          />
        )}
      </View>

      {!showTime || formattedTime === undefined ? null : (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={`${formattedTime}, change time`}
          onPress={() => onOpenReschedule?.(item)}
          testID="agenda-row-time"
          style={{
            position: 'absolute',
            top: theme.space[5],
            left: theme.space[0],
            width: railWidth,
            alignItems: 'flex-start',
          }}
        >
          <Text variant="footnote" color="textSecondary" numberOfLines={1}>
            {formattedTime}
          </Text>
        </Touchable>
      )}

      {/**
       * **The overdue chip lives in the time rail** (`design-system.md` §7.1: "Overdue rows: a
       * `warning` Chip in the time rail showing the original date").
       *
       * It was rendering under the title, on its own line, which made every overdue ANYTIME row a
       * head taller than its neighbours — the founder's report that they are "disproportionally
       * bigger ... there is enough space for tags". An untimed row's rail is empty by definition,
       * so the chip has the column to itself.
       */}
      {!showTime ||
      formattedTime !== undefined ||
      item.overdueFromDate === undefined ||
      today === undefined ? null : (
        <View
          style={{
            position: 'absolute',
            top: theme.space[5],
            left: theme.space[0],
            width: railWidth,
          }}
        >
          <OverdueChip
            overdueFromDate={item.overdueFromDate}
            today={today}
            {...(onOpenOverdue === undefined
              ? {}
              : { onPress: () => onOpenOverdue(item) })}
          />
        </View>
      )}

      {checked && !item.hasCheckbox ? (
        <View
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text variant="footnoteStrong" color="textSecondary">
            {outcomeVerb(item.type)}
          </Text>
        </View>
      ) : null}

      {!canResolvePassedAgendaItem(item) || onOpenResolution === undefined ? null : (
        <Chip
          label={passedPlanResolution(item.type).prompt}
          accessibilityLabel={`${passedPlanResolution(item.type).prompt} Choose an outcome for ${item.title}`}
          tone="neutral"
          onPress={() => onOpenResolution(item)}
          testID="agenda-resolution-prompt"
        />
      )}
    </View>
  );
}
