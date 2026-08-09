import type {
  Activity,
  ActivityDetails,
  ActivityLocation,
  ActivityType,
  PlanType,
} from '../types/index.js';

/**
 * Changing an Activity's object kind or Plan kind — the one place the mapping lives (P1-17).
 *
 * Implements the **exhaustive table** in
 * [`activities.md` §6.3](../../../../docs/01-product/activities.md) point 5. It is in
 * `packages/shared` rather than in the API because both sides need the *identical* answer:
 * the server applies it, and the client renders the "this will remove" confirmation
 * **before** calling (`interaction-contract.md` §1a.1). Two implementations would mean a
 * user confirming the loss of one set of fields and losing another.
 *
 * ## Pure, and that is load-bearing
 *
 * No clock, no I/O, no `process.env`, and the input is never mutated. That is what lets the
 * client run it to render a preview of a write that has not happened, and it is asserted
 * rather than assumed — `changeActivityKind.test.ts` runs the same input twice and
 * deep-compares both the output and the untouched input.
 *
 * ## What it does not decide
 *
 * The **target**. `target` arrives as a complete, valid pair from the user's explicit choice
 * — the Plan-kind chooser, or `Change to Task` — and this function never derives one from a
 * title, a date, or the source kind (`CLAUDE.md` rule 2). It also never decides *whether* to
 * apply the change: a caller with blockers must refuse, and a caller with drops must confirm
 * first. This returns the answer; acting on it is the caller's.
 */

/** The complete, valid target pair. Never constructible from title text. */
export type ChangeTarget =
  | { objectKind: 'task'; type: 'task' }
  | { objectKind: 'plan'; type: PlanType };

/**
 * One field the change would discard, with copy the confirmation renders directly.
 *
 * The label carries the value — `Season and episode (S2 E4)` — because §6.3's example shows
 * the user what they are about to lose rather than which field name holds it. Generating it
 * here is what stops the copy being hand-written once per pair; there are 30 lossy pairs.
 */
export interface DroppedField {
  /** Stable across releases, so a client may key off it. Never shown to a user. */
  key: string;
  /** User-facing, and complete: `Streaming service (Netflix)`. */
  label: string;
}

/**
 * A reason a Plan → Task conversion is refused, with the count that must reach zero.
 *
 * Named sections rather than field names, because §6.3 point 3 requires the message to say
 * what to remove and where: `Remove 2 people and 1 expense before changing this to a Task.`
 */
export interface ChangeBlocker {
  section: 'people' | 'expenses' | 'prep';
  count: number;
  label: string;
}

export interface ChangeResult {
  objectKind: 'task' | 'plan';
  type: ActivityType;
  details: ActivityDetails;
  /** Absent when the source had none and the change added none. */
  notes?: string;
  location?: ActivityLocation;
  dropped: DroppedField[];
  /** Non-empty means the change must not be applied. Only Plan → Task can produce these. */
  blockers: ChangeBlocker[];
}

/** The subset this function reads. Taking the whole `Activity` would work; naming it is honest. */
export type ChangeSource = Pick<
  Activity,
  | 'title'
  | 'notes'
  | 'location'
  | 'objectKind'
  | 'type'
  | 'details'
  | 'participantCount'
  | 'expenseTotalCents'
  | 'childCount'
>;

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * Blockers, from the three stored counts (§6.3 point 3).
 *
 * **Only Plan → Task is ever blocked.** A Plan-kind change never is: moving a Watch to an
 * Outing keeps every participant, expense and prep task, so there is nothing coordinated to
 * lose. Task → Plan cannot be blocked either — a Task has none of these by construction.
 *
 * The counts are read, never written: the conversion "never deletes coordinated data as a
 * side effect", so this reports what the user must remove rather than removing it.
 */
function blockersFor(source: ChangeSource, target: ChangeTarget): ChangeBlocker[] {
  if (target.objectKind !== 'task' || source.objectKind !== 'plan') return [];

  const blockers: ChangeBlocker[] = [];

  if (source.participantCount > 0) {
    blockers.push({
      section: 'people',
      count: source.participantCount,
      label: plural(source.participantCount, 'person', 'people'),
    });
  }
  if (source.expenseTotalCents !== 0) {
    // The count of expenses is not stored — only their total — so this names the section
    // without inventing a number. `expenses.md` owns the drill-down that shows them.
    blockers.push({ section: 'expenses', count: 1, label: 'the expenses on it' });
  }
  if (source.childCount > 0) {
    blockers.push({
      section: 'prep',
      count: source.childCount,
      label: plural(source.childCount, 'prep task', 'prep tasks'),
    });
  }

  return blockers;
}

/** `Season and episode (S2 E4)` — the season/episode pair reads as one thing to a user. */
function seasonEpisodeLabel(season?: number, episode?: number): string {
  const parts = [
    season === undefined ? undefined : `S${season}`,
    episode === undefined ? undefined : `E${episode}`,
  ].filter((part): part is string => part !== undefined);

  return `Season and episode (${parts.join(' ')})`;
}

/**
 * Every field the source `details` carries that the target cannot, with its confirmation copy.
 *
 * Transcribed from the table rather than derived, because the table is the contract and a
 * clever derivation would silently disagree with it the first time a field is added. A field
 * that is **absent** on the source is not dropped — there is nothing to lose — so the
 * confirmation never lists a field the user never filled in.
 */
function droppedFrom(details: ActivityDetails, placeNameMoved: boolean): DroppedField[] {
  const dropped: DroppedField[] = [];
  const add = (key: string, label: string | undefined) => {
    if (label !== undefined) dropped.push({ key, label });
  };

  switch (details.kind) {
    case 'watch': {
      // `watch → any`: the whole payload. `mediaTitle` is not listed — it was copied from
      // `title` on the way in and `title` survives, so naming it would report a loss that
      // did not happen.
      if (details.season !== undefined || details.episode !== undefined) {
        add('watch.seasonEpisode', seasonEpisodeLabel(details.season, details.episode));
      }
      add(
        'watch.episodeTitle',
        details.episodeTitle === undefined
          ? undefined
          : `Episode title (${details.episodeTitle})`,
      );
      add(
        'watch.mediaKind',
        details.mediaKind === undefined
          ? undefined
          : `Movie or show (${details.mediaKind})`,
      );
      add(
        'watch.service',
        details.service === undefined
          ? undefined
          : `Streaming service (${details.service})`,
      );
      break;
    }

    case 'meal': {
      add(
        'meal.mealSlot',
        details.mealSlot === undefined ? undefined : `Meal slot (${details.mealSlot})`,
      );
      add('meal.recipeUrl', details.recipeUrl === undefined ? undefined : 'Recipe link');
      // Dropped, but any grocery items already created from it keep their provenance —
      // §6.3's table says so explicitly, and the copy should not imply otherwise.
      add(
        'meal.ingredients',
        details.ingredients === undefined || details.ingredients.length === 0
          ? undefined
          : `${plural(details.ingredients.length, 'ingredient', 'ingredients')} (any grocery items already added stay)`,
      );
      break;
    }

    case 'event': {
      // `description` is not dropped — it is appended to `notes` for **every** target, so it
      // is carried rather than lost. See {@link notesFor}.
      add(
        'event.price',
        details.priceCents === undefined
          ? undefined
          : `Price (${formatPrice(details.priceCents, details.currency)})`,
      );
      add('event.ticketUrl', details.ticketUrl === undefined ? undefined : 'Ticket link');
      add(
        'event.organiser',
        details.organiser === undefined ? undefined : `Organiser (${details.organiser})`,
      );
      break;
    }

    case 'outing': {
      /**
       * `placeName` moves into `location.label` **only if** that label is empty (§6.3). When
       * the activity already has a location, the place name has nowhere to go and is a real
       * loss — so whether it is dropped depends on the location, not on the field alone.
       * {@link changeActivityKind} makes that decision once and passes the answer here,
       * rather than this re-deriving it and the two disagreeing.
       */
      if (details.placeName !== undefined && !placeNameMoved) {
        add('outing.placeName', `Place (${details.placeName})`);
      }
      // `reservation` is folded into `notes` as one formatted line, so it is carried.
      break;
    }

    case 'custom':
    case 'task':
      // Neither carries user-visible type-specific data. `shortcutId` is reserved and not
      // built in v1, so nothing here is a loss the user would recognise.
      break;
  }

  return dropped;
}

/**
 * Whether `placeName` survives as `location.label`.
 *
 * §6.3: `outing → event` moves it "**only if** `location.label` is empty", and the row for
 * `outing → any other` says "same as above" — so the condition is the label being free, not
 * the target being `event` specifically.
 *
 * The single source of truth for both halves of the answer: {@link locationFor} fills the
 * label when this is true, and {@link droppedFrom} reports a loss when it is false.
 */
function movesPlaceName(source: ChangeSource): boolean {
  if (source.details.kind !== 'outing') return false;
  if (source.details.placeName === undefined) return false;

  const label = source.location?.label;
  return label === undefined || label === '';
}

function formatPrice(cents: number, currency?: string): string {
  const amount = (cents / 100).toFixed(2);
  return currency === undefined ? amount : `${amount} ${currency}`;
}

/**
 * A reservation as one line of notes: `Reservation: Luca, 19:30, party of 4, ref ABC123`.
 *
 * One formatted line, per §6.3's `outing →` rows, and only the parts that exist — a
 * reservation with just a time should not read `Reservation: , 19:30, party of , ref`.
 */
function reservationLine(reservation: {
  name?: string;
  time?: string;
  partySize?: number;
  reference?: string;
}): string | undefined {
  const parts = [
    reservation.name,
    reservation.time,
    reservation.partySize === undefined ? undefined : `party of ${reservation.partySize}`,
    reservation.reference === undefined ? undefined : `ref ${reservation.reference}`,
  ].filter((part): part is string => part !== undefined && part !== '');

  return parts.length === 0 ? undefined : `Reservation: ${parts.join(', ')}`;
}

/**
 * `notes` after the change: the source notes, plus whatever the table appends to them.
 *
 * The append rule is stated once and applies to both appenders: separated by a **blank
 * line**, and only when `notes` is non-empty. An empty source means the appended text
 * becomes the notes, with no leading blank line — which is what "if `notes` is non-empty"
 * means read literally, and what looks right on screen.
 */
function notesFor(source: ChangeSource): string | undefined {
  const appended =
    source.details.kind === 'event'
      ? source.details.description
      : source.details.kind === 'outing' && source.details.reservation !== undefined
        ? reservationLine(source.details.reservation)
        : undefined;

  if (appended === undefined || appended === '') return source.notes;
  if (source.notes === undefined || source.notes === '') return appended;

  return `${source.notes}\n\n${appended}`;
}

/** `location` after the change: the source's, unless `placeName` has a free label to fill. */
function locationFor(source: ChangeSource): ActivityLocation | undefined {
  if (!movesPlaceName(source)) return source.location;

  // Narrowed by `movesPlaceName`, which the compiler cannot see through a function boundary.
  const placeName = (source.details as { placeName: string }).placeName;

  return { ...source.location, label: placeName };
}

/**
 * The target's `details`, carrying across only what the table says survives.
 *
 * Every target starts from its **empty** variant rather than from the source, which is what
 * makes "a meal with watch fields" unrepresentable in the result as well as in storage. The
 * two carries are `any → watch` and `any → outing`, both of which seed a field from `title`.
 */
function detailsFor(source: ChangeSource, target: ChangeTarget): ActivityDetails {
  switch (target.type) {
    case 'watch':
      // `mediaTitle` is required on a watch, so this is not merely a nicety — a watch with
      // no media title is not a representable value.
      return { kind: 'watch', mediaTitle: source.title };
    case 'outing':
      return { kind: 'outing', placeName: source.title };
    case 'meal':
      return { kind: 'meal' };
    case 'event':
      return { kind: 'event' };
    case 'custom':
      return { kind: 'custom' };
    case 'task':
      return { kind: 'task' };
  }
}

/**
 * Applies a target to an activity, and reports what it costs.
 *
 * **Returns the answer; it does not decide to act on it.** A non-empty `blockers` means the
 * caller must refuse — the server with `409`, the client by disabling the action and naming
 * the counts. A non-empty `dropped` means the caller must confirm first
 * (`interaction-contract.md` §1a.1). An empty `dropped` is an additive change and shows no
 * confirmation at all (§6.3 point 6).
 *
 * `status`, `completedAt` and `outcome` are absent from the result on purpose: **no
 * conversion changes them** (§6.3 point 8). An `event` that was attended and becomes an
 * `outing` stays completed with `outcome: 'attended'`. Leaving them out means a caller
 * cannot pass them through by accident.
 */
export function changeActivityKind(
  source: ChangeSource,
  target: ChangeTarget,
): ChangeResult {
  /**
   * **An identity change is a no-op, and nothing is dropped.**
   *
   * Read literally, the table's `watch → any` row includes `watch → watch`, which would
   * report the season and episode as lost and return an emptied `details` — destroying a
   * user's data for a request that changed nothing. §6.3's own rule gives the right answer
   * without needing a new row: "Changing type keeps `details` fields that still apply and
   * drops the rest", and every field on a Watch still applies to a Watch. The table's rows
   * are shorthand for the cross-kind cases; *changing* type presupposes the type changed.
   *
   * This is not hypothetical. `PATCH /v1/activities/:id` accepts `objectKind` and `type` as a
   * pair, and a client re-sending the current values alongside a title edit is an ordinary
   * thing for a form to do.
   */
  if (source.objectKind === target.objectKind && source.type === target.type) {
    return {
      objectKind: source.objectKind,
      type: source.type,
      details: structuredClone(source.details),
      ...(source.notes === undefined ? {} : { notes: source.notes }),
      ...(source.location === undefined ? {} : { location: { ...source.location } }),
      dropped: [],
      blockers: [],
    };
  }

  const notes = notesFor(source);
  const location = locationFor(source);

  return {
    objectKind: target.objectKind,
    type: target.type,
    details: detailsFor(source, target),
    ...(notes === undefined ? {} : { notes }),
    ...(location === undefined ? {} : { location }),
    dropped: droppedFrom(source.details, movesPlaceName(source)),
    blockers: blockersFor(source, target),
  };
}

/**
 * The sentence §6.3 point 3 specifies:
 * `Remove 2 people and 1 expense before changing this to a Task.`
 *
 * Built here rather than in the client so the server's `409` and the client's disabled-action
 * copy are the same words. Returns `undefined` when nothing blocks.
 */
export function blockerMessage(blockers: readonly ChangeBlocker[]): string | undefined {
  if (blockers.length === 0) return undefined;

  const labels = blockers.map((blocker) => blocker.label);
  const list =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;

  return `Remove ${list} before changing this to a Task.`;
}
