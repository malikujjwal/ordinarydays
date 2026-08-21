import type { AgendaItem } from '@od/shared/types';
import {
  Chip,
  formatWallTime,
  Text,
  Touchable,
  type as typeScale,
  useTheme,
} from '@od/ui';
import type { AccessibilityActionEvent } from 'react-native';
import { View } from 'react-native';
import { PendingLabel } from '@/components/PendingIndicator';
import { useCompletionCommitState } from '@/features/agenda/hooks/useCompletionCommitLock';
import { isFutureRecurringOccurrence } from '@/features/agenda/model/rowScope';
import {
  type AgendaRowIntentState,
  pendingCreateAllowsOpen,
  useAgendaRowIntentState,
} from '@/hooks/usePendingIntents';
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
   * Drops the row's ordinary vertical padding and list minimum — for a row inside a `Card`,
   * which supplies both already (P2-44). It retains a 2 pt optical top inset so the lifted
   * 24 pt checkbox visual remains inside the card's clipped rounded edge.
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
   * Two halves, because the rule is about a section's ends: nothing renders above the **first**
   * marker or below the **last**. The section owns that knowledge; the row only knows how to draw
   * its own column. Purely decorative, so both are hidden from assistive technology — a screen
   * reader hears the rows, not the line between them.
   */
  connectorAbove?: boolean;
  connectorBelow?: boolean;
  /** Locked only until this row reflects its SQLite-committed completion state. */
  completionLocked?: boolean;
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

interface AgendaRowWithIntentStateProps extends AgendaRowProps {
  intentState: AgendaRowIntentState;
  /** Durable local value used only while the wider Agenda projection catches up. */
  completionCheckedOverride?: boolean;
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
  pending: boolean,
): string {
  const parts = [item.title];
  if (checked) parts.push(outcomeVerb(item.type));
  // Spoken as well as shown: dimming is not a state a screen reader can hear.
  if (SKIPPED_STATUSES.has(item.status)) parts.push('Skipped');
  if (item.noteExcerpt !== undefined) parts.push(item.noteExcerpt);
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
  if (pending) parts.push('Pending, saved on this device and waiting to sync');
  return parts.join(', ');
}

/** The shared agenda row body; gestures and optimistic state are added by their owning tasks. */
export function AgendaRow(props: AgendaRowProps) {
  const intentState = useAgendaRowIntentState(
    props.item.activityId,
    props.item.occurrenceDate,
  );
  const completion = useCompletionCommitState(
    props.item,
    intentState.failedCompletionIntentIds,
  );
  return (
    <AgendaRowWithIntentState
      {...props}
      completionLocked={props.completionLocked ?? completion.locked}
      {...(completion.checkedOverride === undefined
        ? {}
        : { completionCheckedOverride: completion.checkedOverride })}
      intentState={intentState}
    />
  );
}

/** Presentation for gesture owners that already subscribed to this row's intent state. */
export function AgendaRowWithIntentState({
  item,
  today,
  untimedContextLabel = 'today',
  showTime = false,
  subtitleColor = 'textSecondary',
  subtitlePrefix,
  divider = true,
  dense = false,
  connectorAbove = false,
  connectorBelow = false,
  completionLocked = false,
  completionCheckedOverride,
  onOpen,
  onToggleComplete,
  onOpenReschedule,
  onOpenOverdue,
  onOpenResolution,
  accessibilityActions,
  onAccessibilityAction,
  onBodyFocus,
  onBodyBlur,
  intentState,
}: AgendaRowWithIntentStateProps) {
  const theme = useTheme();
  const checked = completionCheckedOverride ?? COMPLETED_STATUSES.has(item.status);
  /**
   * Derived from the intent log, not from `AgendaItem` (P2-50). No field was added to any
   * shared schema: the server cannot report that a row it has never seen is pending, and a
   * DTO field would be a second source of truth for something only this device knows.
   */
  const { pendingCreate, recurrenceEdit, mutationInert: inert } = intentState;
  const openInert =
    recurrenceEdit.inert || (pendingCreate.pending && !pendingCreateAllowsOpen);
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
  /**
   * **One value, four uses.** The row's vertical padding also positions the time column, the
   * overdue chip and the connector's origin, and those three were carrying `space[5]` as a
   * literal. Tightening the padding to `space[3]` therefore left the time sitting 8 pt below the
   * title it belongs to and started the connector 8 pt below the marker it hangs from — one
   * change, three symptoms, because the same number was written in four places.
   */
  /**
   * `space[4]`, up from `space[3]` — founder, 2026-08-17: with the rules gone, "spacing is doing
   * the job the borders used to do", and a row carrying a two-line title plus a recurrence badge
   * ran too close to the next one. 12 either side puts 24 pt between one row's last line and the
   * next row's first, against 4 pt between a title and its own badge — a 6:1 ratio, so the eye
   * reads the grouping without a separator to help it.
   */
  const rowPaddingTop = dense ? theme.space[1] : theme.space[4];
  const rowPaddingBottom = dense ? theme.space[1] : theme.space[4] + theme.space[1];
  /**
   * **How far the leading control is lifted**, so its 44 pt box centres on the title's first
   * line rather than on the row (founder, 2026-08-17).
   */
  /**
   * Timeline context may de-emphasize a past/skipped row, but completion itself never changes
   * the title's measure or weight. This keeps both current and already-past tasks stable when
   * their checkbox changes.
   */
  const titleVariant = item.isPast || skipped ? 'subhead' : 'bodyStrong';
  const leadingLift = (theme.layout.hitTarget - typeScale[titleVariant].lineHeight) / 2;
  /**
   * **Where anything that must sit on the title's line starts.**
   *
   * The leading control, the time column and the overdue chip are all 44 pt targets that centre
   * their content, so each one needs the same lift to land on the title rather than 11 pt below
   * it. Lifting them one at a time is what produced four separate misalignments in this task —
   * the marker, then the time, then the connector's origin, then the chip. One value, and they
   * move together or not at all.
   */
  const railTop = rowPaddingTop - leadingLift;
  /**
   * **The marker's real centre, lift included.**
   *
   * This is the connector's origin, and it was still computing the *unlifted* position — so the
   * thread was drawn for a marker 11 pt below where the marker actually is: a stub above each
   * glyph and a gap beneath it, which is the founder's "attached to the top of the checkbox
   * instead of drawing down". The same failure as the time column carrying `space[5]` after the
   * padding changed: a second copy of a position that moved.
   */
  const markerCentreY = rowPaddingTop - leadingLift + theme.layout.hitTarget / 2;

  /**
   * **One secondary line, not two** — founder, 2026-08-17: "as you add more metadata, I'd combine
   * those two secondary lines when possible". A Meal was spending three lines on
   * `Dinner` / `Meal · Dinner` / `↻ Daily`; joined, a plan row is the same height as a task's.
   *
   * The recurrence run keeps its own `Text` inside the line so it retains the testID and the
   * accessible label the agenda specs read, and so the pre-snooze time can stay `textMuted`.
   */
  /**
   * **Three roles, three treatments** — founder, 2026-08-17: "what → context → system
   * information". The note used to share the metadata's token, so a row's second and third lines
   * carried equal weight and the note competed with the title.
   *
   * A **resolved** row dims the whole stack, not just its title: a completed row whose note was
   * still at full strength went on demanding attention after it was done.
   *
   * The `subtitleColor` override stays ahead of all of it — the UP NEXT card's tinted ground
   * needs `textPrimary` for AA, which is a contrast requirement rather than a hierarchy choice.
   */
  const noteColor =
    subtitleColor === 'textPrimary'
      ? 'textPrimary'
      : dimmed
        ? 'textMuted'
        : 'textSecondary';
  const metaColor = subtitleColor === 'textPrimary' ? 'textPrimary' : 'textMuted';
  const recurrenceMeta =
    item.isSnoozed && item.originalTime !== undefined && item.time !== undefined
      ? `${formatWallTime(item.originalTime)} → ${formatWallTime(item.time)}`
      : (item.recurrenceDescription ?? undefined);
  const showsRecurrence = item.isRecurring && item.recurrenceDescription !== undefined;
  const subtitleLine =
    subtitlePrefix === undefined
      ? item.subtitle
      : [subtitlePrefix, item.subtitle].filter((part) => part !== undefined).join(' · ');
  const hasMetadata = subtitleLine !== undefined || recurrenceMeta !== undefined;

  /**
   * The timeline's spine — **two halves with a halo round the marker**.
   *
   * It began as two halves meeting at the marker's centre, so the line ran *through* every glyph.
   * Fixing that by drawing only the lower half broke the other way: on a 60 pt row the segment
   * came out a few pixels tall, and the thread disappeared between rows entirely — the founder's
   * report that "the vertical line is disconnected".
   *
   * Both halves are back, each stopping `space[2]` clear of the marker, so the glyph sits in a
   * gap on a continuous thread. `above` is suppressed on a section's first row and `below` on its
   * last, which is what keeps the spine inside the section rather than trailing out of it.
   */
  const connector = (half: 'above' | 'below') => (
    <View
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      testID={`agenda-row-connector-${half}`}
      style={{
        position: 'absolute',
        left: markerCentreX,
        width: 1,
        backgroundColor: theme.colors.border,
        ...(half === 'above'
          ? {
              top: 0,
              height: Math.max(markerCentreY - theme.layout.hitTarget / 2, 0),
            }
          : {
              top: markerCentreY + theme.layout.hitTarget / 2,
              bottom: 0,
            }),
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
        /**
         * `space[3]`, down from `space[5]` — founder, 2026-08-17, once the row rules came off:
         * without a divider the old padding read as loose rather than as separation.
         *
         * A row's height is set by its **leading control**, not by its text: the checkbox is a
         * 44 pt target (`interaction-contract.md` §2) with the padding either side, so 16+44+16
         * made every one-line row 76 pt. At 8 it is 60, and two stacked checkboxes sit 44 pt
         * apart — well over §6.1's 8 pt minimum between adjacent targets, which is the number
         * that stops this going lower.
         */
        paddingTop: rowPaddingTop,
        /**
         * **Two points more below than above** (founder, 2026-08-17: "add extra 2pts of space
         * after every row"). It goes on the row's own padding rather than on the section's gap so
         * the connector, which runs to the row's bottom edge, still meets the next row's marker —
         * a gap between rows would break the thread by exactly this much.
         */
        paddingBottom: rowPaddingBottom,
        borderBottomWidth: divider ? 1 : 0,
        borderBottomColor: theme.colors.border,
        /**
         * **No opacity.** `interaction-contract.md` §6.4 is explicit that de-emphasis "is
         * achieved with weight and size, not by dropping contrast below the threshold", and
         * 0.62 did exactly that: it blends the ink toward the background, which took a
         * `textSecondary` subtitle from 4.77:1 to roughly 3.3:1 — under AA on every completed
         * row. The quieter treatment now lives on the title itself, below.
         */
      }}
    >
      {connectorAbove ? connector('above') : null}
      {connectorBelow ? connector('below') : null}

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
        disabled={openInert}
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

      {/**
       * **The glyph's centre meets the title's first line** — founder, 2026-08-17: the plan
       * markers "are not in a straight line horizontally".
       *
       * They measured identical in x (centre 102, width 44); the mismatch is vertical. A leading
       * control is a 44 pt target that centres its 24 pt visual, so its centre sits 22 pt below
       * the row's content top — while the title's first line centres at half its 21 pt leading,
       * about 10. Every marker therefore sat ~11 pt below the word it belongs to, which reads as
       * crooked on a row whose title wraps and merely low on one that does not.
       *
       * The offset is derived from the two tokens rather than typed in, so it follows the type
       * scale. The 44 pt target is untouched — it simply overlaps the row's padding by 11 pt,
       * and rows are 68 pt or taller, so adjacent targets stay far past §6.1's 8 pt minimum.
       */}
      <View
        testID="agenda-row-leading"
        style={{
          marginLeft: railOffset,
          marginTop: -leadingLift,
        }}
      >
        <RowLeading
          /**
           * **No checkbox at all while the create is unacknowledged** (P2-50, §5.4).
           *
           * A server-directed action against an entity the server has never seen has nowhere
           * to go. Absent rather than disabled, so a capability probe finds nothing — and the
           * `Pending` indicator on the metadata line is what says why, in words, rather than
           * leaving a greyed control as the only signal (§6.4).
           */
          hasCheckbox={item.hasCheckbox && !inert}
          checked={checked}
          title={item.title}
          disabled={futureRecurringCompletion || completionLocked}
          {...(onToggleComplete === undefined || inert || completionLocked
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
          disabled={openInert}
          accessibilityRole="button"
          accessibilityLabel={bodyLabel(
            item,
            checked,
            untimedContextLabel,
            pendingCreate.pending,
          )}
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
            /**
             * **The title starts at the top, it is not centred in the tap target.**
             *
             * `Touchable` gives every pressable a 44 pt `minHeight` and centres its content, which
             * is right for a button and wrong for a row body: a one-line title was centred inside
             * those 44 pt and sat 11 pt below the checkbox, while a title with a metadata line
             * under it was tall enough that the centring did nothing. That is why only rows
             * *without* metadata looked crooked — the founder's "Single Task" case.
             *
             * The 44 pt minimum stays; only the alignment changes, so the first line lands on the
             * same centre as the marker and the time whatever else the row carries.
             */
            justifyContent: 'flex-start',
          }}
        >
          {/**
           * `bodyStrong` over `footnote` — the founder's row grammar, 2026-08-17: "16pt
           * semibold" for the title, "13–14pt" for the line under it. The title carried the
           * regular weight and the subtitle sat at `subhead`, which put only two points between
           * them and made every row read as two equal lines.
           */}
          {/**
           * Completion stays visible through the check, strike and muted ink. The surrounding
           * timeline context still chooses the typography, so checking a row never changes it.
           */}
          <Text
            variant={titleVariant}
            color={dimmed ? 'textMuted' : 'textPrimary'}
            struck={checked}
            numberOfLines={dense ? 1 : undefined}
          >
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
          {/**
           * **The note takes its own line, above the metadata** (founder, 2026-08-17).
           *
           * It is the user's own words, so it does not join `Meal · Dinner · ↻ Daily` — that line
           * is server-composed type metadata plus recurrence, and merging the two would read as
           * one sentence made of two unrelated things. A row carrying both is therefore three
           * lines; that is the founder's own sketch and the cost of showing a note at all.
           *
           * The server sends one clamped line (`noteExcerpt`), so this renders it verbatim rather
           * than slicing 4,000 characters on the client. The dense Up Next preview deliberately
           * omits it: that card keeps a stable two-line content budget without imposing a fixed
           * height or adding empty bottom padding. The same note remains in every ordinary row
           * and in Activity Detail.
           */}
          {dense || item.noteExcerpt === undefined ? null : (
            <Text
              /** Notes keep the preferred compact size before and after completion. */
              variant="footnote"
              color={noteColor}
              numberOfLines={1}
              testID="agenda-row-note"
            >
              {item.noteExcerpt}
            </Text>
          )}
          {!hasMetadata && !pendingCreate.pending ? null : (
            <View
              testID="agenda-row-metadata"
              style={{
                alignSelf: 'stretch',
                minWidth: 0,
                flexDirection: 'row',
                alignItems: 'center',
              }}
            >
              {!hasMetadata ? null : (
                <View style={{ flexShrink: 1, minWidth: 0 }}>
                  <Text variant="footnote" color={metaColor} numberOfLines={1}>
                    {subtitleLine === undefined ? null : (
                      <Text
                        variant="footnote"
                        color={metaColor}
                        testID="agenda-row-subtitle"
                      >
                        {subtitleLine}
                      </Text>
                    )}
                    {subtitleLine === undefined || recurrenceMeta === undefined
                      ? null
                      : ' · '}
                    {recurrenceMeta === undefined ? null : (
                      <Text
                        variant="footnote"
                        color={metaColor}
                        accessibilityLabel={
                          showsRecurrence
                            ? (item.recurrenceDescription ?? '')
                            : `Snoozed from ${formatWallTime(item.originalTime ?? '')} to ${formatWallTime(item.time ?? '')}`
                        }
                        testID="agenda-badge-recurrence"
                      >
                        {showsRecurrence ? `↻ ${recurrenceMeta}` : recurrenceMeta}
                      </Text>
                    )}
                  </Text>
                </View>
              )}
              {!hasMetadata || !pendingCreate.pending ? null : (
                <Text variant="footnote" color={metaColor}>
                  {' · '}
                </Text>
              )}
              {pendingCreate.pending ? <PendingLabel /> : null}
            </View>
          )}
        </Touchable>

        {/**
         * **Recurrence and snooze are not passed here any more** — they render inside the
         * metadata line above (founder, 2026-08-17). Passing them as well rendered `↻ Daily`
         * twice and made the row taller than before the merge, which was the opposite of the
         * point. What is left for this strip is the overdue chip, the avatars and the RSVP slot,
         * in their canonical order.
         */}
        {dense || recurrenceEdit.message === undefined ? null : (
          <Text
            variant="footnote"
            color={recurrenceEdit.status === 'failed' ? 'danger' : 'textSecondary'}
            testID="agenda-row-recurrence-state"
          >
            {recurrenceEdit.message}
          </Text>
        )}
        {dense ? null : (
          <RowBadges
            {...(item.overdueFromDate === undefined || showTime
              ? {}
              : { overdueFromDate: item.overdueFromDate })}
            {...(today === undefined ? {} : { today })}
            participantAvatars={item.participantAvatars}
            {...(onOpenOverdue === undefined || inert
              ? {}
              : { onOpenOverdue: () => onOpenOverdue(item) })}
          />
        )}
      </View>

      {!showTime || formattedTime === undefined ? null : (
        <Touchable
          disabled={inert}
          accessibilityRole="button"
          accessibilityLabel={`${formattedTime}, change time`}
          onPress={() => onOpenReschedule?.(item)}
          testID="agenda-row-time"
          style={{
            position: 'absolute',
            top: railTop,
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
            top: railTop,
            left: theme.space[0],
            width: railWidth,
          }}
        >
          <OverdueChip
            overdueFromDate={item.overdueFromDate}
            today={today}
            {...(onOpenOverdue === undefined || inert
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

      {inert ||
      !canResolvePassedAgendaItem(item) ||
      onOpenResolution === undefined ? null : (
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
