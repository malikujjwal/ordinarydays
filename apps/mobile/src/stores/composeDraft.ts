import { changeActivityKind } from '@od/shared';
import type { CreationTarget } from '@od/shared/client';
import type { PlanType } from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import { create } from 'zustand';
import {
  type DraftDetails,
  type DraftLocation,
  type DraftSchedule,
  EMPTY_DETAILS,
  EMPTY_LOCATION,
  EMPTY_SCHEDULE,
  fromActivityDetails,
  toActivityDetails,
} from '@/features/compose/model/draft';
import { reconcileReminder } from '@/features/compose/model/reminders';
import type { ObjectChoice } from '@/features/compose/model/targets';

/**
 * The compose draft (P1-24).
 *
 * **Client state, so Zustand and not Query** (`tech-stack.md` §2.2, ADR-012). A half-filled
 * form would be meaningless to persist server-side, and no value in this store ever came from
 * the API — the created Activity goes into Query's cache and the draft is reset.
 *
 * ## The invariant this store exists to hold
 *
 * `target` is `undefined` until the user taps a row, and **there is no action that sets it
 * from anything but a tap**. `setTitle` cannot reach it. Neither can a capture result: the
 * capture actions write `title`, `notes` and `sourceUrl` and nothing else, by construction
 * rather than by filtering. The store is small enough to read in one sitting for exactly this
 * reason — the rule is only as strong as the reader's ability to confirm it
 * (`CLAUDE.md` rule 2).
 */

/** Which screen of the modal is showing. `object` is always where it opens. */
export type ComposeStep = 'object' | 'planKind' | 'form';

/**
 * The store's own field types are **present-and-possibly-undefined**, not optional.
 *
 * `CommonDraftFields.sourceUrl` is `?: string`, and under `exactOptionalPropertyTypes` those
 * are genuinely different types: an optional property may be *absent*, which a store slice
 * built by `set()` never is. Declaring them here rather than extending that interface is what
 * keeps `set({ sourceUrl: undefined })` — "the user cleared it" — expressible.
 */
export interface ComposeDraftState {
  title: string;
  notes: string;
  sourceUrl: string | undefined;
  step: ComposeStep;
  /**
   * The fixed target, or `undefined` while the user is still choosing.
   *
   * `listItem` needs a `listId` it cannot get in Phase 1, so choosing `List item` moves to
   * the Phase 3 placeholder and leaves this `undefined` rather than inventing one.
   */
  target: CreationTarget | undefined;
  /** A locally picked image. Phase 3 uploads it; Phase 1 shows it and blocks save with it. */
  attachmentUri: string | undefined;
  /**
   * Generated once at `onMutate` and reused on every retry, cleared whenever the draft
   * changes (`api-contract.md` §1). Clearing on change is what stops an edited-then-resaved
   * draft from being deduplicated against the previous body.
   */
  idempotencyKey: string | undefined;

  /** `activities.md` §4's Date / Time / End time, for every type that has them. */
  schedule: DraftSchedule;
  location: DraftLocation;
  /** `undefined` is `Off`. Only Task, Event and General show the control at all. */
  reminderOffset: number | undefined;
  details: DraftDetails;

  open: () => void;
  chooseObject: (choice: ObjectChoice) => void;
  choosePlanKind: (type: PlanType, eventReservationName?: string) => void;
  back: () => void;
  setTitle: (title: string) => void;
  setNotes: (notes: string) => void;
  setSourceUrl: (url: string) => void;
  attachImage: (uri: string) => void;
  clearAttachment: () => void;
  setDate: (date: string | undefined) => void;
  setTime: (time: string | undefined) => void;
  /** The time a Meal slot implies, recorded as the app's guess rather than the user's. */
  setTimeFromSlot: (time: string | undefined) => void;
  setEndTime: (endTime: string | undefined) => void;
  setLocation: (patch: Partial<DraftLocation>) => void;
  setReminderOffset: (offsetMinutes: number | undefined) => void;
  setDetails: (patch: Partial<DraftDetails>) => void;
  /** Returns the key for this attempt, generating one if the draft has changed since the last. */
  takeIdempotencyKey: () => string;
  reset: () => void;
}

const EMPTY = {
  step: 'object',
  target: undefined,
  title: '',
  notes: '',
  sourceUrl: undefined,
  attachmentUri: undefined,
  idempotencyKey: undefined,
  schedule: EMPTY_SCHEDULE,
  location: EMPTY_LOCATION,
  reminderOffset: undefined,
  details: EMPTY_DETAILS,
} satisfies Omit<
  ComposeDraftState,
  | 'open'
  | 'chooseObject'
  | 'choosePlanKind'
  | 'back'
  | 'setTitle'
  | 'setNotes'
  | 'setSourceUrl'
  | 'attachImage'
  | 'clearAttachment'
  | 'setDate'
  | 'setTime'
  | 'setTimeFromSlot'
  | 'setEndTime'
  | 'setLocation'
  | 'setReminderOffset'
  | 'setDetails'
  | 'takeIdempotencyKey'
  | 'reset'
>;

/**
 * Every content edit clears the pending key.
 *
 * Folded into one helper so no individual setter can forget it. A setter that kept the key
 * would let a user fix a typo, save again, and get the *original* title back from the
 * idempotency cache — a bug that only appears on a retry and is close to unfindable.
 */
const edited = (patch: Partial<ComposeDraftState>) => ({
  ...patch,
  idempotencyKey: undefined,
});

export const useComposeDraft = create<ComposeDraftState>()((set, get) => ({
  ...EMPTY,

  /** Always opens on the object step with nothing selected. Explicit intent costs one tap, every time. */
  open: () => set({ ...EMPTY }),

  /**
   * The one place `target` can become a Task.
   *
   * `plan` deliberately does **not** set a target: it advances to the second required chooser
   * and leaves the target unfixed, so a user who backs out of the Plan-kind step has chosen
   * nothing. `General` is chosen there, never defaulted here.
   */
  chooseObject: (choice) => {
    if (choice === 'task') {
      set({ step: 'form', target: { objectKind: 'task', type: 'task' } });
      return;
    }
    if (choice === 'plan') {
      set({ step: 'planKind', target: undefined });
      return;
    }
    // `List item` keeps the mental model stable and routes to the Phase 3 placeholder.
    set({ step: 'form', target: undefined });
  },

  /**
   * The one place `target` can become a Plan, and where re-choosing a kind runs **P1-17's
   * mapping in memory, before any write**.
   *
   * Title, notes and the source URL are common to every type in `activities.md` §4, so they
   * always survive and no confirmation is owed for them (`interaction-contract.md` §1a.1,
   * "Changing a Plan's kind, nothing dropped" → additive).
   *
   * `changeActivityKind` is the same pure function the server runs for a real conversion, so
   * a draft and a stored Activity cannot disagree about which fields survive a Watch becoming
   * an Event. The counts it reads are all zero here by construction — a draft has no
   * participants, expenses or prep children — so it can never return a blocker, and the
   * `dropped` list it returns is the *reason* the Season field vanishes from the form rather
   * than lurking in the store.
   */
  choosePlanKind: (type, eventReservationName) => {
    const { target, title, details } = get();
    const previousType = target?.objectKind === 'plan' ? target.type : 'task';

    if (previousType === type) {
      set(
        edited({
          step: 'form',
          target: { objectKind: 'plan', type },
          ...(type === 'event' && details.reservation.name === '' && eventReservationName
            ? {
                details: {
                  ...details,
                  reservation: { ...details.reservation, name: eventReservationName },
                },
              }
            : {}),
        }),
      );
      return;
    }

    const mapped = changeActivityKind(
      {
        title,
        // `listItem` never reaches here — the store leaves `target` undefined for it — and
        // the mapping's source is Task or Plan by type, so the fallback is Task.
        objectKind: target?.objectKind === 'plan' ? 'plan' : 'task',
        type: previousType,
        details: toActivityDetails(previousType, details, title),
        participantCount: 0,
        expenseTotalCents: 0,
        childCount: 0,
      },
      { objectKind: 'plan', type },
    );

    const mappedDetails = fromActivityDetails(mapped.details);
    const nextDetails =
      type === 'event' && mappedDetails.reservation.name === '' && eventReservationName
        ? {
            ...mappedDetails,
            reservation: { ...mappedDetails.reservation, name: eventReservationName },
          }
        : mappedDetails;

    set(
      edited({
        step: 'form',
        target: { objectKind: 'plan', type },
        details: nextDetails,
      }),
    );
  },

  /**
   * Back never writes and never clears compatible fields.
   *
   * From the form it returns to whichever chooser produced the target — the Plan-kind step
   * for a plan, the object step for a task — and **unfixes the target**, because a form the
   * user has stepped back out of no longer has an answered destination.
   */
  back: () => {
    const { step, target } = get();
    if (step === 'planKind') {
      set({ step: 'object', target: undefined });
      return;
    }
    if (step === 'form') {
      set({
        step: target?.objectKind === 'plan' ? 'planKind' : 'object',
        target: undefined,
      });
    }
  },

  setTitle: (title) => set(edited({ title })),
  setNotes: (notes) => set(edited({ notes })),
  setSourceUrl: (sourceUrl) => set(edited({ sourceUrl })),
  attachImage: (attachmentUri) => set(edited({ attachmentUri })),
  clearAttachment: () => set(edited({ attachmentUri: undefined })),

  /**
   * Clearing the date clears the time with it, and the reminder after that.
   *
   * `activities.md` §3.4: a time "requires a date", and a reminder "requires a date". Leaving
   * a 19:30 behind on a cleared date would be a value the form cannot show and the schema
   * would reject — the kind of state that surfaces as a `400` naming a field the user cannot
   * see.
   */
  setDate: (date) =>
    set((state) =>
      edited({
        schedule: date === undefined ? EMPTY_SCHEDULE : { ...state.schedule, date },
        ...(date === undefined &&
        state.target?.objectKind === 'plan' &&
        state.target.type === 'event' &&
        state.details.reservation.time === state.schedule.time
          ? {
              details: {
                ...state.details,
                reservation: { ...state.details.reservation, time: '' },
              },
            }
          : {}),
        ...(date === undefined ? { reminderOffset: undefined } : {}),
      }),
    ),

  /**
   * The user's own choice of time, from the picker or the clear affordance.
   *
   * `timeFromSlot: false` is the whole difference between this and {@link setTimeFromSlot}:
   * once the user has named a time, a later slot change must not move it (§4.2).
   */
  setTime: (time) =>
    set((state) =>
      edited({
        schedule: {
          ...state.schedule,
          time,
          timeFromSlot: false,
          // An end time needs a start time (§3 rule 4).
          ...(time === undefined ? { endTime: undefined } : {}),
        },
        ...(state.target?.objectKind === 'plan' && state.target.type === 'event'
          ? {
              details: {
                ...state.details,
                reservation: {
                  ...state.details.reservation,
                  ...(state.details.reservation.time === '' ||
                  state.details.reservation.time === state.schedule.time
                    ? { time: time ?? '' }
                    : {}),
                },
              },
            }
          : {}),
        // The two pickers offer different lists; keep only an offset the new one shows.
        reminderOffset: reconcileReminder(state.reminderOffset, time !== undefined),
      }),
    ),

  /**
   * The time a Meal slot implies — the app's guess, marked as one.
   *
   * Identical to {@link setTime} but for the flag, and separate rather than a boolean
   * parameter because the two call sites mean different things: one is the user speaking and
   * the other is the form filling in. A parameter would let a caller pass the wrong one
   * without the code reading wrongly.
   */
  setTimeFromSlot: (time) =>
    set((state) =>
      edited({
        schedule: {
          ...state.schedule,
          time,
          timeFromSlot: time !== undefined,
          ...(time === undefined ? { endTime: undefined } : {}),
        },
        reminderOffset: reconcileReminder(state.reminderOffset, time !== undefined),
      }),
    ),

  setEndTime: (endTime) =>
    set((state) => edited({ schedule: { ...state.schedule, endTime } })),

  setLocation: (patch) =>
    set((state) => edited({ location: { ...state.location, ...patch } })),

  setReminderOffset: (reminderOffset) => set(edited({ reminderOffset })),

  setDetails: (patch) =>
    set((state) => edited({ details: { ...state.details, ...patch } })),

  takeIdempotencyKey: () => {
    const existing = get().idempotencyKey;
    if (existing !== undefined) return existing;
    // `expo-crypto`, not `crypto.randomUUID` — the latter is absent from Hermes' global
    // scope on some SDK versions, and an idempotency key is the wrong place to find out.
    const key = randomUUID();
    set({ idempotencyKey: key });
    return key;
  },

  reset: () => set({ ...EMPTY }),
}));

/**
 * Whether closing should prompt `Discard this?`.
 *
 * Content only. Having *chosen* Task is not content — a user who taps `+`, taps `Task` and
 * changes their mind has typed nothing and is owed no dialog. A confirmation for an empty
 * form is the kind of friction that teaches people to dismiss dialogs without reading them.
 */
export function hasContent(
  state: Pick<
    ComposeDraftState,
    | 'title'
    | 'notes'
    | 'sourceUrl'
    | 'attachmentUri'
    | 'schedule'
    | 'location'
    | 'details'
  >,
): boolean {
  return (
    state.title.trim() !== '' ||
    state.notes.trim() !== '' ||
    (state.sourceUrl ?? '') !== '' ||
    state.attachmentUri !== undefined ||
    // A chosen date is content. Backing out of a form after picking Saturday and losing it
    // without being asked is the discard this prompt exists to prevent.
    state.schedule.date !== undefined ||
    state.location.label.trim() !== '' ||
    state.location.address.trim() !== '' ||
    hasDetailContent(state.details)
  );
}

/** Whether any type-specific field carries something the user typed or chose. */
function hasDetailContent(details: ComposeDraftState['details']): boolean {
  return (
    details.mealSlot !== undefined ||
    details.mediaKind !== undefined ||
    details.ingredients.some((row) => row.name.trim() !== '') ||
    [
      details.recipeUrl,
      details.season,
      details.episode,
      details.episodeTitle,
      details.service,
      details.description,
      details.price,
      details.ticketUrl,
      details.organiser,
      details.reservation.name,
      details.reservation.time,
      details.reservation.partySize,
      details.reservation.reference,
    ].some((value) => value.trim() !== '')
  );
}
