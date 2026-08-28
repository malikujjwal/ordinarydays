import type { ListItemPlanState, ListItemView } from '@od/shared/types';
import { Checkbox, Chip, Text, Touchable, useTheme } from '@od/ui';
import { View } from 'react-native';
import {
  checkboxLabel,
  ingredientCount,
  mayShowPlanStateLine,
  type RowList,
  rowBodyLabel,
  showsCheckbox,
  showsLocation,
  watchProgress,
  watchStatusLabel,
} from '../model/listItemRow';

/**
 * **One row component for every list in the product** (§P3-28,
 * [`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.7, §6.2).
 *
 * ```
 *  ☐  Chicken  — Sunday dinner                         collection, checkable
 *
 *  ☐  Zahav                                            + supportsLocation
 *     237 St James Place                          →      its own maps target
 *     Planned Saturday · 7 PM                     →      its own Activity target
 *
 *     Severance                                        watch
 *     [Watching]  S2 E4                                  the chip replaces the checkbox
 *
 *     Chicken tacos                                    meals
 *     4 ingredients
 * ```
 *
 * ## It reads two fields off the list, and never the catalogue
 *
 * `behaviour` and `capabilities` — the values **copied onto the List row at creation**
 * (ADR-032). There is no `templateKey` comparison in this file and no lookup that could reach
 * `LIST_TEMPLATES`; `listIndex.test.ts`'s grep covers the whole feature directory, and §P3-28
 * says in as many words that a template key here would mean the model has been misunderstood.
 * A list whose capabilities changed a second ago therefore renders correctly, because the row
 * asks the row it is in rather than the record it came from.
 *
 * ## Independent slots
 *
 * Provenance, the location line and the caller's state line are three separate things and none
 * hides another (§P3-28's edge cases). A linked item on a checkable collection with a place and
 * a source meal legitimately uses four lines, and its checkbox, its address and its state line
 * are three distinct accessibility elements with three distinct labels.
 *
 * That holds on **every** behaviour, `watch` included: the body says
 * `Severance, watching, season 2 episode 4` and the state line says
 * `Next session Friday 8:00 PM, open plan`, because they go to two different screens
 * (`interaction-contract.md` §6.2, corrected 2026-08-28). Neither label repeats the other.
 *
 * ## The checkbox is the only tap that mutates
 *
 * `CLAUDE.md` rule 6 and U1/U2: the body opens item detail, the address opens Maps, the state
 * line opens the Activity, and only the checkbox writes — as `checked: next`, the absolute
 * value, which is why the callback takes one rather than being a bare `onToggle` (§5.11.5). Each is its own 44 pt target — which
 * is `Touchable`'s minimum — because they mean four different things.
 *
 * ## Retained is not cleared
 *
 * A `checked` value under a failed gate, or a `location` on a list that is no longer a
 * collection, is **hidden and kept**. Turning the capability back on restores exactly what was
 * there (§5.5). Nothing in this component writes.
 *
 * ## Invalid data stays invalid
 *
 * A committed `watch` or `meals` item with no typed `details` is rejected by the schema before
 * it reaches here. If one arrives anyway the row draws the title and stops: it does not invent
 * `want`, and it does not invent an empty ingredient list.
 */
export interface ListItemRowProps {
  /**
   * The list's own two fields. `Pick`ed rather than the whole List, so there is nothing else
   * on the prop for a future edit to start branching on.
   */
  list: RowList;
  item: ListItemView;
  /**
   * The caller's trimmed Plan state, present only alongside its pointer (ADR-034).
   *
   * The row uses it for **one** decision — whether a state line is allowed at all — and reads
   * nothing else from it. What the line says is {@link planStateLine}'s.
   */
  viewerPlan?: ListItemPlanState;
  /**
   * P3-34's rendered state line.
   *
   * The wording, the relative date format and the `Cancelled` arm are that task's; the
   * eligibility rule above is this one's, and it wins — passing a line for an unscheduled Plan
   * renders nothing, because link presence is never display eligibility (§6.2).
   */
  planStateLine?: string;
  /** U1 — opens item detail (P3-29). Absent leaves the body inert rather than pretending. */
  onOpen?: () => void;
  /** U2 — the only mutating tap on this row. */
  onToggleChecked?: (next: boolean) => void;
  /** Opens the platform maps app for a qualifying collection's stored place. */
  onOpenLocation?: () => void;
  /** Opens the caller's linked Activity (P3-34). */
  onOpenPlan?: () => void;
  testID?: string;
}

export function ListItemRow({
  list,
  item,
  viewerPlan,
  planStateLine,
  onOpen,
  onToggleChecked,
  onOpenLocation,
  onOpenPlan,
  testID,
}: ListItemRowProps) {
  const theme = useTheme();
  const checkable = showsCheckbox(list);
  const located = showsLocation(list, item);
  const place = located ? item.location : undefined;
  const status = watchStatusLabel(item);
  const progress = watchProgress(item);
  const ingredients = ingredientCount(item);
  /* Both gates: the row decides eligibility, P3-34 decides the words. */
  const stateLine =
    mayShowPlanStateLine(viewerPlan) && planStateLine !== undefined
      ? planStateLine
      : undefined;
  /** Struck only where a tick is operative; hidden `checked` changes nothing on screen. */
  const struck = checkable && item.checked;
  /**
   * Spread rather than passed, so a row rendered without a `testID` passes the prop at all
   * rather than passing `undefined` — which `exactOptionalPropertyTypes` treats as a value.
   */
  const id = (suffix: string) =>
    testID === undefined ? {} : { testID: `${testID}-${suffix}` };

  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space[3],
        paddingVertical: theme.space[3],
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.borderSubtle,
      }}
    >
      {checkable ? (
        <Checkbox
          checked={item.checked}
          label={checkboxLabel(item)}
          /*
           * Disabled rather than inert without a caller. P3-29 owns the write and the list
           * screen supplies it, so this is now the exception rather than the rule — but a
           * surface that renders the row without one still gets the disabled form and its
           * `aria-disabled`, because a control that looks live and does nothing is the worse
           * of the two incomplete states and nothing may be implied by colour alone (§6.4).
           */
          disabled={onToggleChecked === undefined}
          {...(onToggleChecked === undefined ? {} : { onChange: onToggleChecked })}
          {...id('checkbox')}
        />
      ) : null}

      {/*
       * `box-none` so this column does not swallow presses aimed at the separate targets
       * inside it — the pattern `AgendaRow` records for the same reason.
       */}
      <View
        pointerEvents="box-none"
        style={{ flex: 1, minWidth: 0, gap: theme.space[1] }}
      >
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={rowBodyLabel(list, item)}
          disabled={onOpen === undefined}
          {...(onOpen === undefined ? {} : { onPress: onOpen })}
          {...id('body')}
          style={{
            alignItems: 'flex-start',
            alignSelf: 'stretch',
            justifyContent: 'flex-start',
          }}
        >
          {/*
           * Title and provenance on one line: §7.5 draws `Chicken — Sunday dinner`, and the
           * label is text rather than a link in v1 — item detail is where the source meal
           * becomes navigable.
           */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              gap: theme.space[2],
            }}
          >
            <Text
              variant="body"
              color={struck ? 'textSecondary' : 'textPrimary'}
              struck={struck}
            >
              {item.title}
            </Text>
            {item.sourceLabel === undefined ? null : (
              <Text variant="subhead" color="textMuted" {...id('provenance')}>
                {`— ${item.sourceLabel}`}
              </Text>
            )}
          </View>

          {item.note === undefined ? null : (
            <Text variant="subhead" color="textSecondary" numberOfLines={1}>
              {item.note}
            </Text>
          )}
        </Touchable>

        {/*
         * The behaviour line. A `watch` row's chip **replaces** the checkbox rather than
         * joining it — status is what that behaviour has instead of a tick (§5.7) — and the
         * absence above is what makes that true rather than this line's presence.
         */}
        {status === undefined && ingredients === undefined ? null : (
          <View
            style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}
            /* Its meaning is already inside the row body's label; saying it twice is noise. */
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            aria-hidden
            {...id('behaviour')}
          >
            {status === undefined ? null : (
              <Chip label={status} {...id('watch-status')} />
            )}
            {progress === undefined ? null : (
              <Text variant="subhead" color="textSecondary" {...id('progress')}>
                {progress}
              </Text>
            )}
            {ingredients === undefined ? null : (
              <Text variant="subhead" color="textSecondary" {...id('ingredients')}>
                {ingredients}
              </Text>
            )}
          </View>
        )}

        {/* §6.2's address line: its own element, its own label, its own target. */}
        {place === undefined ? null : (
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={`${place.address ?? place.label}, open in Maps`}
            disabled={onOpenLocation === undefined}
            {...(onOpenLocation === undefined ? {} : { onPress: onOpenLocation })}
            {...id('location')}
            style={{ alignItems: 'flex-start', alignSelf: 'stretch' }}
          >
            <Text variant="subhead" color="textSecondary">
              {place.address ?? place.label}
            </Text>
          </Touchable>
        )}

        {/*
         * §6.2's state line, and P3-34's rule that tapping it opens the **Activity** while
         * tapping the title opens the item. Two targets, because they are two destinations.
         */}
        {stateLine === undefined ? null : (
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={`${stateLine}, open plan`}
            disabled={onOpenPlan === undefined}
            {...(onOpenPlan === undefined ? {} : { onPress: onOpenPlan })}
            {...id('plan-state')}
            style={{ alignItems: 'flex-start', alignSelf: 'stretch' }}
          >
            <Text variant="subhead" color="textSecondary">
              {stateLine}
            </Text>
          </Touchable>
        )}
      </View>
    </View>
  );
}
