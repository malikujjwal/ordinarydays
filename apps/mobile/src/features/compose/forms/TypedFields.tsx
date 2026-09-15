import type { ActivityType, Recurrence } from '@od/shared/types';
import { DisclosureRow, Field, RowGroup, useTheme } from '@od/ui';
import { Fragment } from 'react';
import { View } from 'react-native';
import { IngredientPicker } from '@/components/IngredientPicker';
import { IngredientsControl } from '@/components/IngredientsControl';
import { RepeatControl } from '@/components/RepeatControl';
import { WatchListDestination } from '@/components/WatchListDestination';
import { CaptureRow } from '@/features/compose/components/CaptureRow';
import {
  DateControl,
  KindControl,
  LocationControl,
  NotesControl,
  ReminderControl,
  ReservationControl,
  SlotControl,
  TicketsAndDetailsControl,
  TimeControl,
} from '@/features/compose/controls/FormControls';
import type {
  DraftDetails,
  DraftLocation,
  DraftReservation,
  DraftSchedule,
} from '@/features/compose/model/draft';
import {
  type FieldKey,
  type FieldSpec,
  fieldRegions,
  fieldsByType,
  slotForTime,
  timeForSlot,
  watchKind,
} from '@/features/compose/model/fields';
import type { AttachmentUploadController } from '@/hooks/useAttachmentUpload';

/**
 * The five creation forms (P1-25) — as one renderer over five tables, not five components.
 *
 * `activities.md` §4 is five tables of fields in a fixed order, and §3 rules 1 and 3 say a
 * form renders exactly its table, in exactly that order. Rendering **from** `fieldsByType`
 * makes both of those structural: there is no place for another field to be added to Meal
 * without adding a row to the table, and no place for Event's `End time` to drift above its
 * `Start time`. Five hand-written components would restate the tables in JSX, and a restatement
 * is a thing that can disagree.
 *
 * ## Progressive disclosure (P2-43)
 *
 * The form shows what the user's choices have made relevant and nothing else. Three
 * consequences, all decided by `fieldRegions` rather than here:
 *
 * - **No disabled field, anywhere.** Time, Reminder and Repeat are absent until a date exists
 *   rather than greyed with `Pick a date first.` beside them.
 * - **Nothing unimplemented is drawn.** People, Related plan and the two list bridges leave no
 *   placeholder; the founder's 2026-08-12 amendment, decision 5.
 * - **The tail of the table folds into `More options`**, whose summary names exactly what is
 *   inside it. The region is a contiguous suffix, so §3 rule 3's order survives folding.
 */
export interface TypedFieldsProps {
  type: ActivityType;
  title: string;
  schedule: DraftSchedule;
  location: DraftLocation;
  reminderOffset: number | undefined;
  recurrence?: Recurrence;
  details: DraftDetails;
  notes: string;
  sourceUrl: string | undefined;
  /** The form's photo uploads (P3-41): the picker renders them and the save waits on them. */
  attachments: AttachmentUploadController;
  /**
   * The list bridges (P3-43). `destinations` are this form's one-off choices; the titles are
   * resolved by the screen so this table stays free of queries. `onChangeDestination` opens
   * the route-composed picker.
   */
  listBridge: {
    groceriesTitle: string | undefined;
    groceriesState: 'use' | 'ask' | 'none' | undefined;
    watchTitle: string | undefined;
    watchState: 'use' | 'ask' | 'none' | undefined;
    alsoAddToList: boolean;
    onAlsoAddToListChange: (enabled: boolean) => void;
    onChangeDestination: (slot: 'groceries' | 'watch') => void;
  };
  /** The user's today, in their zone. Resolved at the route, never read from a clock here. */
  today: string;
  onDateChange: (date: string | undefined) => void;
  onTimeChange: (time: string | undefined) => void;
  /**
   * The Meal slot's implied time. Separate from {@link onTimeChange} because the draft records
   * which of the two set the value: only the app's own guess may be replaced by a later slot.
   */
  onSlotTimeChange: (time: string | undefined) => void;
  onEndTimeChange: (endTime: string | undefined) => void;
  onLocationChange: (patch: Partial<DraftLocation>) => void;
  onReminderChange: (offsetMinutes: number | undefined) => void;
  onRecurrenceChange?: (recurrence: Recurrence | undefined) => void;
  onDetailsChange: (patch: Partial<DraftDetails>) => void;
  onNotesChange: (notes: string) => void;
  onSourceUrlChange: (url: string) => void;
  fieldErrors: Record<string, string>;
}

/**
 * The Event table's own name for the capture row (§4.4), reused as its name in the `More
 * options` summary on the four types whose tables do not list it. Borrowed rather than
 * invented: two names for one control is how a summary stops describing the form.
 */
const CAPTURE_LABEL = 'Source image / link';

const filled = (value: string | undefined): boolean =>
  value !== undefined && value !== '';

/**
 * The fields that render as a **row** rather than as a labelled control.
 *
 * A run of these is wrapped in one `RowGroup` (below) instead of being laid out on the form's
 * `space[6]` flow gap. That gap is right between a chip row and a picker; between two rows it
 * lands on top of `SettingRow`'s own `space[5]` padding and nowhere else, so every row reads as
 * 36 pt of air above its label and 16 below — visibly lopsided, which is what the founder
 * reported on 2026-08-16. Inside a group the rows sit flush and their hairlines do the
 * separating, which is what `RowGroup` exists for.
 */
const ROW_SHAPED: ReadonlySet<FieldKey> = new Set<FieldKey>([
  'reminder',
  'repeat',
  'reservation',
  'ticketsAndDetails',
]);

/**
 * Renders a field list, coalescing consecutive row-shaped fields into one `RowGroup`.
 *
 * Order is never touched: this only decides which container a field lands in, and a field's
 * neighbours are the same either way.
 *
 * ## Why it owns the vertical rhythm rather than a parent `gap`
 *
 * A form gap and a row group cannot share one container. `space[6]` is right between a chip row
 * and a picker, but a `SettingRow` already carries `space[5]` of its own padding and centres its
 * label inside `layout.settingRowMinHeight` — so a flow gap above the group lands **on top of**
 * that, and the first row reads with far more air above its label than below it, while the rows
 * beneath it are even. Two fixes for one report: the rows share a group, **and** the group sits
 * flush against whatever is above it, letting its own padding be the separation.
 *
 * So this returns one container that spaces its own children: `space[6]` above every control
 * that is not a row, nothing above a group.
 */
function renderRegion(
  specs: readonly FieldSpec[],
  props: TypedFieldsProps,
  kind: 'movie' | 'show',
  gap: number,
  trailing?: { row: React.ReactNode } | { block: React.ReactNode },
): React.ReactNode {
  const blocks: { rows: boolean; node: React.ReactNode }[] = [];
  let run: FieldSpec[] = [];

  const flushRun = (extra?: React.ReactNode) => {
    if (run.length === 0 && extra === undefined) return;
    const keys = run.map((spec) => spec.key).join('-');
    blocks.push({
      rows: true,
      node: (
        <RowGroup key={`rows-${keys}-${blocks.length}`}>
          {run.map((spec) => (
            <Fragment key={spec.key}>{renderField(spec, props, kind)}</Fragment>
          ))}
          {extra}
        </RowGroup>
      ),
    });
    run = [];
  };

  for (const spec of specs) {
    if (ROW_SHAPED.has(spec.key)) {
      run.push(spec);
      continue;
    }
    flushRun();
    blocks.push({
      rows: false,
      node: <Fragment key={spec.key}>{renderField(spec, props, kind)}</Fragment>,
    });
  }

  /**
   * **A trailing node says which shape it is, and the two are not interchangeable.**
   *
   * `row` joins the final `RowGroup` so its rule is continuous with the row above it — that is
   * `More options` closing the when block. `block` is ordinary content and takes the normal gap.
   *
   * One `trailing` served both at first, and the capture row — two buttons — was being folded
   * into a `RowGroup` and given a row's zero top margin. It landed hard against the Notes box
   * above it with no space at all, which is what the founder reported on 2026-08-16.
   */
  if (trailing !== undefined && 'row' in trailing) {
    flushRun(trailing.row);
  } else {
    flushRun();
    if (trailing !== undefined) blocks.push({ rows: false, node: trailing.block });
  }

  return (
    <View>
      {blocks.map((block, index) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here
          key={index}
          style={{ marginTop: index === 0 || block.rows ? 0 : gap }}
        >
          {block.node}
        </View>
      ))}
    </View>
  );
}

export function TypedFields(props: TypedFieldsProps) {
  const theme = useTheme();
  const kind = watchKind(
    props.details.mediaKind,
    props.details.season,
    props.details.episode,
  );
  const regions = fieldRegions(props.type, {
    ...(props.type === 'watch' ? { mediaKind: kind } : {}),
    hasDate: filled(props.schedule.date),
    hasTime: filled(props.schedule.time),
  });

  /** Event lists the capture row in its own table; the other four append it at the end. */
  const capturesInTable = fieldsByType[props.type].some(
    (spec) => spec.key === 'sourceImageLink',
  );
  const captureRow = (
    <CaptureRow
      sourceUrl={props.sourceUrl}
      onSourceUrlChange={props.onSourceUrlChange}
      attachments={props.attachments}
    />
  );

  const summary = [
    ...regions.more.map((spec) => spec.label),
    ...(capturesInTable ? [] : [CAPTURE_LABEL]),
  ].join(' · ');

  /**
   * The summary is built from the rows actually rendered inside, so it can never advertise a
   * capability the form does not have — that is what "names only what is built" means once an
   * unbuilt field simply is not in `regions.more`.
   *
   * It joins the when block's `RowGroup` as that group's last row, so `Reminder`, `Repeat` and
   * `More options` read as one ruled list rather than as three rows with gaps between them.
   */
  const moreOptions = (
    <DisclosureRow label="More options" summary={summary} testID="compose-more-options">
      {renderRegion(
        regions.more,
        props,
        kind,
        theme.space[6],
        capturesInTable ? undefined : { block: captureRow },
      )}
    </DisclosureRow>
  );

  return renderRegion(regions.primary, props, kind, theme.space[6], { row: moreOptions });
}

function renderField(
  spec: FieldSpec,
  props: TypedFieldsProps,
  kind: 'movie' | 'show',
): React.ReactNode {
  const { details, schedule, fieldErrors } = props;

  switch (spec.key) {
    case 'title':
      return null;

    case 'date':
      return (
        <DateControl
          value={schedule.date}
          onChange={props.onDateChange}
          today={props.today}
        />
      );

    case 'time':
      return (
        <TimeControl
          label={spec.label}
          value={schedule.time}
          /**
           * Meal's slot → time rule (§4.2), applied **only when no time is set**. The
           * `openAt` prop is where the wheel starts, not a value: nothing is written until
           * the user picks.
           */
          {...(props.type === 'meal' && details.mealSlot !== undefined
            ? { openAt: timeForSlot(details.mealSlot, undefined, false) ?? '09:00' }
            : {})}
          onChange={(time) => {
            props.onTimeChange(time);
            // Time → slot, the mirror rule, and equally only when the other is unset.
            if (props.type === 'meal' && time !== undefined) {
              const slot = slotForTime(time, details.mealSlot);
              if (slot !== details.mealSlot) props.onDetailsChange({ mealSlot: slot });
            }
          }}
        />
      );

    case 'endTime':
      // "Shown only once a start time exists" (§3.4) — absent, not disabled.
      return (
        <TimeControl
          label="End time"
          value={schedule.endTime}
          onChange={props.onEndTimeChange}
          testID="compose-end-time"
        />
      );

    case 'reminder':
      return (
        <ReminderControl
          value={props.reminderOffset}
          onChange={props.onReminderChange}
          time={schedule.time}
        />
      );

    case 'repeat':
      /**
       * `fieldRegions` already refuses this key without a date; the narrowing is the compiler's
       * copy of that rule rather than a second one, because `RepeatControl` now requires a day.
       */
      return schedule.date === undefined ? null : (
        <RepeatControl
          date={schedule.date}
          value={props.recurrence}
          today={props.today}
          onChange={(recurrence) => props.onRecurrenceChange?.(recurrence)}
        />
      );

    /**
     * The four fields in `UNBUILT_FIELDS`. They stay in the switch so it remains exhaustive
     * over `FieldKey` — a field added to a table without a renderer is a compile error — and
     * they draw nothing, because `fieldRegions` never yields them.
     */
    case 'relatedPlan':
    case 'people':
      return null;

    /**
     * P3-43: the ingredient selection lives on the `ingredients` rows above; this row is the
     * always-visible destination the eventual `Save plan and add n items to <list>` writes to.
     */
    case 'addIngredientsTo':
      return (
        <IngredientPicker
          rows={details.ingredients
            .filter((row) => row.name.trim() !== '')
            .map((row) => ({
              ingredientId: row.id,
              name: row.name,
              ...(row.quantity === '' ? {} : { quantity: row.quantity }),
            }))}
          selected={
            new Set(details.ingredients.filter((r) => r.selected).map((r) => r.id))
          }
          onToggle={(ingredientId, selected) => {
            props.onDetailsChange({
              ingredients: details.ingredients.map((row) =>
                row.id === ingredientId ? { ...row, selected } : row,
              ),
            });
            /**
             * §5.8's `ask` case opens the one-time question the moment it is due — on the
             * first selection — rather than waiting for the row; the answer is remembered
             * there, so the next meal never asks.
             */
            if (
              selected &&
              props.listBridge.groceriesState === 'ask' &&
              !details.ingredients.some((row) => row.selected)
            ) {
              props.listBridge.onChangeDestination('groceries');
            }
          }}
          destinationTitle={props.listBridge.groceriesTitle}
          destinationState={props.listBridge.groceriesState}
          onChangeDestination={() => props.listBridge.onChangeDestination('groceries')}
          lead={spec.label}
          testID="compose-ingredient-destination"
        />
      );

    case 'alsoAddTo':
      return (
        <WatchListDestination
          enabled={props.listBridge.alsoAddToList}
          onEnabledChange={props.listBridge.onAlsoAddToListChange}
          destinationTitle={props.listBridge.watchTitle}
          destinationState={props.listBridge.watchState}
          onChangeDestination={() => props.listBridge.onChangeDestination('watch')}
        />
      );

    case 'slot':
      return (
        <SlotControl
          value={details.mealSlot}
          onChange={(mealSlot) => {
            props.onDetailsChange({ mealSlot });
            /**
             * Slot → time, unless the user set the time themselves (§4.2).
             *
             * Written through `onSlotTimeChange`, which marks the value as the app's guess, so
             * that the **next** slot change may replace it. Sending it through the user's own
             * setter is what made the first slot's time permanent.
             */
            const next = timeForSlot(mealSlot, schedule.time, schedule.timeFromSlot);
            if (next !== schedule.time) props.onSlotTimeChange(next);
          }}
        />
      );

    case 'ingredients':
      return (
        <IngredientsControl
          rows={details.ingredients}
          onChange={(ingredients) => props.onDetailsChange({ ingredients })}
        />
      );

    case 'recipeUrl':
      return (
        <Field
          label="Recipe link"
          value={details.recipeUrl}
          onChangeText={(recipeUrl) => props.onDetailsChange({ recipeUrl })}
          keyboardType="url"
          testID="compose-recipe-url"
          {...(fieldErrors.recipeUrl === undefined
            ? {}
            : { error: fieldErrors.recipeUrl })}
        />
      );

    case 'kind':
      return (
        <KindControl
          value={kind}
          onChange={(mediaKind) => props.onDetailsChange({ mediaKind })}
        />
      );

    case 'season':
      return (
        <Field
          label="Season"
          value={details.season}
          onChangeText={(season) => props.onDetailsChange({ season })}
          keyboardType="number-pad"
          maxLength={2}
          testID="compose-season"
        />
      );

    case 'episode':
      return (
        <Field
          label="Episode"
          value={details.episode}
          onChangeText={(episode) => props.onDetailsChange({ episode })}
          keyboardType="number-pad"
          maxLength={3}
          testID="compose-episode"
        />
      );

    case 'episodeTitle':
      return (
        <Field
          label="Episode title"
          value={details.episodeTitle}
          onChangeText={(episodeTitle) => props.onDetailsChange({ episodeTitle })}
          maxLength={120}
          testID="compose-episode-title"
        />
      );

    case 'service':
      /** Free text by design: there is no catalogue and no provider list (§4.3). */
      return (
        <Field
          label="Streaming service"
          value={details.service}
          onChangeText={(service) => props.onDetailsChange({ service })}
          maxLength={120}
          testID="compose-service"
        />
      );

    case 'location':
      return (
        <LocationControl
          label={props.location.label}
          address={props.location.address}
          onChange={props.onLocationChange}
        />
      );

    case 'description':
      /** Distinct from `notes`: description is public on the invite page, notes never are. */
      return (
        <Field
          label="Description"
          value={details.description}
          onChangeText={(description) => props.onDetailsChange({ description })}
          multiline
          maxLength={4000}
          hint="Shown to anyone you invite."
          testID="compose-description"
        />
      );

    case 'ticketsAndDetails':
      return (
        <TicketsAndDetailsControl
          price={details.price}
          ticketUrl={details.ticketUrl}
          organiser={details.organiser}
          onChange={props.onDetailsChange}
          fieldErrors={fieldErrors}
        />
      );

    case 'sourceImageLink':
      return (
        <CaptureRow
          sourceUrl={props.sourceUrl}
          onSourceUrlChange={props.onSourceUrlChange}
          attachments={props.attachments}
        />
      );

    case 'reservation':
      return (
        <ReservationControl
          value={details.reservation}
          onChange={(patch: Partial<DraftReservation>) =>
            props.onDetailsChange({ reservation: { ...details.reservation, ...patch } })
          }
        />
      );

    case 'notes':
      return (
        <NotesControl
          value={props.notes}
          onChange={props.onNotesChange}
          {...(fieldErrors.notes === undefined ? {} : { error: fieldErrors.notes })}
        />
      );
  }
}
