import type { ActivityType } from '@od/shared/types';
import { Field } from '@od/ui';
import { Fragment } from 'react';
import { CaptureRow } from '@/features/compose/components/CaptureRow';
import {
  ComingSoonControl,
  DateControl,
  IngredientsControl,
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
  type FieldSpec,
  fieldsByType,
  isFieldVisible,
  slotForTime,
  timeForSlot,
  watchKind,
} from '@/features/compose/model/fields';

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
 * The phase file names one file per kind. This implementation keeps the same five forms in
 * one renderer, and the fixture test it
 * asks for reads the same module the screen does.
 */
export interface TypedFieldsProps {
  type: ActivityType;
  title: string;
  schedule: DraftSchedule;
  location: DraftLocation;
  reminderOffset: number | undefined;
  details: DraftDetails;
  notes: string;
  sourceUrl: string | undefined;
  attachmentUri: string | undefined;
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
  onDetailsChange: (patch: Partial<DraftDetails>) => void;
  onNotesChange: (notes: string) => void;
  onSourceUrlChange: (url: string) => void;
  onAttach: (uri: string) => void;
  onClearAttachment: () => void;
  fieldErrors: Record<string, string>;
}

/** The copy each deferred field carries, naming what fills it rather than going quiet. */
const COMING_SOON = {
  people: 'Adding people arrives in Phase 6.',
  repeat: 'Repeating activities arrive in Phase 2.',
  relatedPlan: 'Linking to a plan arrives in Phase 3.',
  lists: 'Lists are coming soon.',
} as const;

export function TypedFields(props: TypedFieldsProps) {
  const specs = fieldsByType[props.type];
  const kind = watchKind(
    props.details.mediaKind,
    props.details.season,
    props.details.episode,
  );

  return (
    <>
      {specs
        .filter((spec) => spec.key !== 'title')
        .filter((spec) =>
          isFieldVisible(spec.key, props.type === 'watch' ? kind : undefined),
        )
        .map((spec) => (
          <Fragment key={spec.key}>{renderField(spec, props, kind)}</Fragment>
        ))}
      {specs.some((spec) => spec.key === 'sourceImageLink') ? null : (
        <CaptureRow
          sourceUrl={props.sourceUrl}
          onSourceUrlChange={props.onSourceUrlChange}
          attachmentUri={props.attachmentUri}
          onAttach={props.onAttach}
          onClearAttachment={props.onClearAttachment}
        />
      )}
    </>
  );
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
          date={schedule.date}
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
      return schedule.time === undefined ? null : (
        <TimeControl
          label="End time"
          value={schedule.endTime}
          date={schedule.date}
          onChange={props.onEndTimeChange}
          testID="compose-end-time"
        />
      );

    case 'reminder':
      return (
        <ReminderControl
          value={props.reminderOffset}
          onChange={props.onReminderChange}
          date={schedule.date}
          time={schedule.time}
        />
      );

    case 'repeat':
      return (
        <ComingSoonControl
          label="Repeat"
          hint={COMING_SOON.repeat}
          testID="compose-repeat"
        />
      );

    case 'relatedPlan':
      return (
        <ComingSoonControl
          label="Related plan"
          hint={COMING_SOON.relatedPlan}
          testID="compose-related-plan"
        />
      );

    case 'people':
      return (
        <ComingSoonControl
          label="People"
          hint={COMING_SOON.people}
          testID="compose-people"
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

    case 'addIngredientsTo':
    case 'alsoAddTo':
      /**
       * **Off in every context**, and in Phase 1 not even switchable. §4.3 is emphatic that
       * nothing — a date, a title, a Watch kind, a capture result — turns this on; Phase 3
       * resolves and visibly names a destination only after the user does.
       */
      return (
        <ComingSoonControl
          label={spec.label}
          hint={COMING_SOON.lists}
          testID={`compose-${spec.key}`}
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
          attachmentUri={props.attachmentUri}
          onAttach={props.onAttach}
          onClearAttachment={props.onClearAttachment}
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
