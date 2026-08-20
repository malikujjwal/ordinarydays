import type { AgendaItem } from '@od/shared/types';
import { Button, Card, formatWallTime, Text, Touchable, useTheme } from '@od/ui';
import { View } from 'react-native';
import { useCompletionCommitLock } from '@/features/agenda/hooks/useCompletionCommitLock';
import {
  type AgendaSwipeAction,
  agendaSwipeActions,
  allAgendaSwipeActions,
} from '@/features/agenda/model/swipeActions';
import type { UpNextSelection } from '@/features/agenda/model/upNext';
import { SwipeableRow } from './SwipeableRow';

export interface UpNextCardProps {
  selection: UpNextSelection;
  onOpen: (item: AgendaItem) => void;
  onOpenReschedule?: (item: AgendaItem) => void;
  onToggleComplete?: (item: AgendaItem, checked: boolean) => void;
  onAction?: (item: AgendaItem, action: AgendaSwipeAction) => void;
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
 * Today's one hero surface, in the anatomy `design-system.md` §7.1 draws (P2-44, restructured on
 * the founder's 2026-08-17 frames — which agree with §7.1 exactly, so this is the diagram
 * implemented rather than a new decision):
 *
 * ```
 *  UP NEXT · IN 2H 15M                      caption, textAction — inside the card
 *   ◇  Dentist appointment                  type marker · bodyStrong
 *      2:30 PM · Jefferson Dental Center    subhead
 *      Complete   Snooze                    footnoteStrong text actions
 *  accentSurface fill · 3 pt accentDeep left border
 * ```
 *
 * Three things the first build got wrong, each of which made it outsize the day beneath it: the
 * eyebrow sat **outside** as a `SectionHeader`, the time was a `heading`-sized block of its own,
 * and the card was outlined on all four sides. §7.1 puts the eyebrow inside, folds the time onto
 * the subtitle line, and rules the card with a left border alone.
 *
 * Its body is still the canonical `AgendaRow` — one row implementation, per P2-21.
 *
 * **The actions stay in the accessibility tree.** Hiding them because the row already exposes
 * each as a rotor action is axe's `aria-hidden-focus` (focusable controls inside an
 * `aria-hidden` container) and wrong on the contract too: `interaction-contract.md` §1 says
 * nothing important lives behind a gesture alone, so the visible button is the real path and the
 * rotor action is the accelerator.
 */
export function UpNextCard({
  selection,
  onOpen,
  onOpenReschedule,
  onToggleComplete,
  onAction,
}: UpNextCardProps) {
  const theme = useTheme();
  const completionLocked = useCompletionCommitLock(selection.item);
  const actions = allAgendaSwipeActions(agendaSwipeActions(selection.item)).filter(
    (action) => CARD_ACTIONS.has(action.name),
  );

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
         * The card's own backdrop. `AgendaRow`'s covers the row band only, and the card adds an
         * eyebrow, its padding and an actions strip **outside** that band — which is the region
         * the founder marked as dead. Same shape as the row's: behind everything, so the
         * checkbox and the two actions still win their own taps, and invisible to assistive
         * technology because the row body above already carries the name, role and actions.
         */}
        <Touchable
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          focusable={false}
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
        <View pointerEvents="box-none">
          {/**
           * One eyebrow, inside the card, carrying both the label and the countdown. It replaced a
           * `SectionHeader` above the card plus a `heading`-sized time inside it — two lines of
           * chrome for one fact, which is most of why the card dwarfed the rows under it.
           */}
          <Text
            variant="caption"
            color="textAction"
            pointerEvents="none"
            testID="up-next-eyebrow"
          >
            {`Up next · ${selection.relativeTime}`}
          </Text>

          <View pointerEvents="box-none" style={{ marginTop: theme.space[5] }}>
            <SwipeableRow
              item={selection.item}
              subtitleColor="textPrimary"
              subtitlePrefix={formatWallTime(selection.time)}
              divider={false}
              dense
              completionLocked={completionLocked}
              onOpen={onOpen}
              {...(onOpenReschedule === undefined ? {} : { onOpenReschedule })}
              {...(onToggleComplete === undefined ? {} : { onToggleComplete })}
              {...(onAction === undefined ? {} : { onAction })}
            />
          </View>

          {actions.length === 0 || onAction === undefined ? null : (
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
                  disabled={completionLocked && action.name === 'complete'}
                  onPress={() => onAction(selection.item, action)}
                  testID={`up-next-action-${action.name}`}
                />
              ))}
            </View>
          )}
        </View>
      </Card>
    </View>
  );
}
