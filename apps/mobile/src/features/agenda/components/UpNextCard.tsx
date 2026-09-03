import type { AgendaItem } from '@od/shared/types';
import { Button, Card, formatWallTime, Text, Touchable, useTheme } from '@od/ui';
import { View } from 'react-native';
import {
  type CompletionCommitState,
  useCompletionCommitState,
} from '@/features/agenda/hooks/useCompletionCommitLock';
import { scopeForRow } from '@/features/agenda/model/rowScope';
import {
  type AgendaSwipeAction,
  agendaSwipeActions,
  allAgendaSwipeActions,
} from '@/features/agenda/model/swipeActions';
import type { UpNextSelection } from '@/features/agenda/model/upNext';
import {
  type AgendaRowIntentState,
  pendingCreateAllowsOpen,
  useAgendaRowIntentState,
} from '@/hooks/usePendingIntents';

export interface UpNextCardProps {
  selection: UpNextSelection;
  onOpen: (item: AgendaItem) => void;
  onOpenReschedule?: (item: AgendaItem) => void;
  onToggleComplete?: (item: AgendaItem, checked: boolean) => void;
  onAction?: (item: AgendaItem, action: AgendaSwipeAction) => void;
}

export interface UpNextCardWithStateProps extends UpNextCardProps {
  intentState: AgendaRowIntentState;
  completion: CompletionCommitState;
}

/**
 * The two actions the card offers — founder decision, 2026-08-17.
 *
 * The card carried all four of the row's actions and read as a control panel; the founder's
 * ruling is that "only complete and snooze are good enough for now". This is a **filter over**
 * `agendaSwipeActions`, never a list of its own: an action appears here only if the row already
 * offers it, so the card still cannot present something the row does not, and a capability the
 * server withheld stays withheld. `complete` is the positive action whatever verb its type
 * derives (`Had it`, `Watched`, `Attended`, `Done`).
 */
const CARD_ACTIONS = new Set(['complete', 'snooze']);

/**
 * Today's one hero surface, in the anatomy `design-system.md` §7.1 draws (P2-44; restructured
 * again on the founder's 2026-08-31 frame):
 *
 * ```
 *  2:30 ║ UP NEXT · IN 2H 15M               time rail: heading + caption meridiem · double rule
 *   PM  ║ Dentist appointment               title — no marker, no checkbox
 *       ║ ───────────────────────           1 px border rules under each band
 *       ║ Jefferson Dental Center           subhead — the metadata band, ruled below
 *       ║ ───────────────────────
 *       ║ Complete   Snooze                 footnoteStrong text actions
 *  upNextSurface fill · no left edge
 * ```
 *
 * The 2026-08-31 planner frame: the time in a margin rail beside a **double** hairline —
 * a planner page's ruling — with the title and metadata as ruled bands and the card's
 * accent left edge removed. The marker column and the checkbox left with the embedded
 * `AgendaRow`: the card's two text actions already carry complete and snooze, so the row's
 * swipe surface and checkbox duplicated them. This is the one surface that departs from
 * P2-21's one-row rule, on the founder's frame; the backdrop announces the card to
 * assistive technology since no row carries the name any more.
 *
 * **The actions stay in the accessibility tree.** Hiding them because the row already exposes
 * each as a rotor action is axe's `aria-hidden-focus` (focusable controls inside an
 * `aria-hidden` container) and wrong on the contract too: `interaction-contract.md` §1 says
 * nothing important lives behind a gesture alone, so the visible button is the real path and the
 * rotor action is the accelerator.
 */
export function UpNextCard({ selection, ...props }: UpNextCardProps) {
  const scope = scopeForRow(selection.item);
  const intentState = useAgendaRowIntentState(
    selection.item.activityId,
    scope.kind === 'occurrence' ? scope.date : undefined,
  );
  const completion = useCompletionCommitState(
    selection.item,
    intentState.failedCompletionIntentIds,
  );
  return (
    <UpNextCardWithState
      {...props}
      selection={selection}
      intentState={intentState}
      completion={completion}
    />
  );
}

/** Card presentation sharing one keyed intent/completion snapshot with the timeline row. */
export function UpNextCardWithState({
  selection,
  onOpen,
  onAction,
  intentState,
  completion,
}: UpNextCardWithStateProps) {
  const theme = useTheme();
  const completionLocked = completion.locked;
  const mutationInert = intentState.mutationInert;
  const openInert = intentState.pendingCreate.pending && !pendingCreateAllowsOpen;
  const actions = allAgendaSwipeActions(agendaSwipeActions(selection.item)).filter(
    (action) => CARD_ACTIONS.has(action.name),
  );
  const formattedTime = formatWallTime(selection.time);
  // `2:30 PM` splits into the rail's two lines; a 24-hour locale simply has no second line.
  const [railTime, ...railMeridiem] = formattedTime.split(' ');
  /*
   * The metadata band uses only the trimmed Agenda projection: location, note excerpt,
   * type subtitle, then the snooze/recurrence description, de-duplicated and `·`-joined.
   */
  const recurrenceMeta =
    selection.item.isSnoozed &&
    selection.item.originalTime !== undefined &&
    selection.item.time !== undefined
      ? `${formatWallTime(selection.item.originalTime)} → ${formatWallTime(selection.item.time)}`
      : selection.item.isRecurring && selection.item.recurrenceDescription !== undefined
        ? `↻ ${selection.item.recurrenceDescription}`
        : undefined;
  const metaParts = [
    selection.item.locationLabel,
    selection.item.noteExcerpt,
    selection.item.subtitle,
    recurrenceMeta,
  ].filter(
    (part, index, parts): part is string =>
      part !== undefined && part.trim() !== '' && parts.indexOf(part) === index,
  );
  const metaLine = metaParts.length === 0 ? undefined : metaParts.join(' · ');

  return (
    <View testID="today-up-next">
      {/**
       * `padding` and the inner `gap` are the **same token** so the space above the eyebrow and
       * the space below it are equal (founder, 2026-08-17). At `space[6]` padding with a
       * `space[3]` gap the eyebrow sat 20 pt below the card's top edge and 8 pt above the row,
       * which read as the header being stuck to the title rather than sitting between the two.
       */}
      <Card
        hero
        radius="xl"
        elevation="e3"
        padding={5}
        /**
         * The actions below are 44 pt targets carrying 18 pt of text, so they bring ~13 pt of
         * their own slack. Without this the card read bottom-heavy against its 16 pt top.
         */
        paddingBottom={2}
        testID="up-next-card"
      >
        {/**
         * The card's own backdrop, and — since the 2026-08-31 planner frame — the card's one
         * accessible opener. The frame removed the embedded row that used to carry the name,
         * role and rotor actions, so the backdrop now announces the card as a whole; the two
         * quick actions keep their own focusable buttons above it.
         */}
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={[`${selection.item.title}. ${formattedTime}`, metaLine]
            .filter((part) => part !== undefined)
            .join('. ')}
          disabled={openInert}
          onPress={() => onOpen(selection.item)}
          testID="up-next-backdrop"
          style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
        >
          <View />
        </Touchable>

        {/**
         * **Explicit steps, not one uniform gap** (founder, 2026-08-17: the card is still too
         * tall — "try reduce the gap marked in white").
         *
         * The eyebrow keeps `space[5]` beneath it so it stays evenly placed between the card's
         * top edge and the title, which is the symmetry asked for earlier. The actions do not
         * need the same: they are 44 pt targets carrying 18 pt of text, so they arrive with ~13
         * pt of their own slack above the words. A uniform gap paid for that twice and left the
         * band between the recurrence badge and `Complete` looking like a hole.
         */}
        <View pointerEvents="box-none" style={{ flexDirection: 'row' }}>
          {/**
           * The time rail (founder, 2026-08-31): the timeline's own left-rail grammar,
           * promoted into the card. One accessible element, so a screen reader hears
           * `2:30 PM` once rather than the two visual lines it is drawn as.
           */}
          {/**
           * Sized to its numerals, not to the timeline rail's fixed column — that column
           * is measured for `footnote` text, and under `heading` numerals it left the
           * time swimming in dead width (founder, 2026-08-31). The margin pair beside it
           * no longer needs an integer rail: it is one element whose two edges share a
           * fractional pixel phase wherever they land.
           */}
          <View
            accessible
            // `group` so the label is legal on web: a bare div may not carry `aria-label`
            // (axe `aria-prohibited-attr`, serious), and the role keeps this one element
            // announcing `2:30 PM` once rather than its two drawn lines.
            role="group"
            accessibilityLabel={formattedTime}
            pointerEvents="none"
            testID="up-next-time-rail"
            style={{ alignItems: 'center', paddingTop: theme.space[1] }}
          >
            <Text variant="heading" color="textAction" aria-hidden>
              {railTime}
            </Text>
            {railMeridiem.length === 0 ? null : (
              <Text variant="caption" color="textSecondary" aria-hidden>
                {railMeridiem.join(' ')}
              </Text>
            )}
          </View>
          {/**
           * The planner margin: two rules, close together, per the 2026-08-31 frame.
           * One element, integer width, integer 1 pt borders. The two edges sit an
           * integer distance apart, so they share the same fractional pixel phase at any
           * position, scale or Display Zoom and must rasterise identically — every
           * two-layer variant let the lines land on different phases and drew the pair
           * with two weights or two shades (founder reports, 2026-08-31).
           */}
          <View
            aria-hidden
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
            style={{
              width: 4,
              alignSelf: 'stretch',
              marginHorizontal: theme.space[4],
              borderLeftWidth: 1,
              borderRightWidth: 1,
              borderColor: theme.colors.border,
            }}
          />

          <View pointerEvents="box-none" style={{ flex: 1, minWidth: 0 }}>
            {/**
             * One eyebrow, inside the card, carrying both the label and the countdown. It
             * replaced a `SectionHeader` above the card plus a `heading`-sized time inside
             * it — two lines of chrome for one fact, which is most of why the card once
             * dwarfed the rows under it. The rail's time is the row's, relocated — the
             * subtitle line below carries the place alone now.
             */}
            <Text
              variant="caption"
              color="textAction"
              pointerEvents="none"
              testID="up-next-eyebrow"
            >
              {`Up next · ${selection.relativeTime}`}
            </Text>

            {/**
             * The planner page (founder, 2026-08-31): title and metadata as ruled bands —
             * a hairline under each — with no marker column and no checkbox. The embedded
             * `AgendaRow` left with them: its swipe surface duplicated the two text
             * actions below, and the completion checkbox is exactly what the frame
             * removes. Completing still happens through the `complete` action button.
             */}
            <View pointerEvents="none" style={{ marginTop: theme.space[4] }}>
              <Text
                variant="title"
                color="textPrimary"
                numberOfLines={2}
                testID="up-next-title"
              >
                {selection.item.title}
              </Text>
            </View>
            <View
              aria-hidden
              pointerEvents="none"
              style={{
                height: 1,
                backgroundColor: theme.colors.border,
                marginTop: theme.space[3],
              }}
            />
            {metaLine === undefined ? null : (
              <>
                <View pointerEvents="none" style={{ marginVertical: theme.space[2] }}>
                  <Text
                    variant="subhead"
                    color="textPrimary"
                    numberOfLines={1}
                    testID="up-next-meta"
                  >
                    {metaLine}
                  </Text>
                </View>
                <View
                  aria-hidden
                  pointerEvents="none"
                  style={{ height: 1, backgroundColor: theme.colors.border }}
                />
              </>
            )}

            {intentState.recurrenceEdit.inert ? (
              <View
                testID="up-next-recurrence-state"
                pointerEvents="none"
                style={{
                  minHeight: theme.layout.hitTarget,
                  marginTop: theme.space[1],
                  justifyContent: 'center',
                }}
              >
                <Text variant="footnote" color="textSecondary">
                  {intentState.recurrenceEdit.message}
                </Text>
              </View>
            ) : actions.length === 0 || onAction === undefined ? null : (
              <View
                testID="up-next-quick-actions"
                pointerEvents="box-none"
                style={{
                  marginTop: theme.space[1],
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: theme.space[5],
                }}
              >
                {actions.map((action) => (
                  <Button
                    key={action.name}
                    label={action.label}
                    variant="ghost"
                    size="sm"
                    flush
                    disabled={mutationInert || completionLocked}
                    onPress={() => onAction(selection.item, action)}
                    testID={`up-next-action-${action.name}`}
                  />
                ))}
              </View>
            )}
          </View>
        </View>
      </Card>
    </View>
  );
}
