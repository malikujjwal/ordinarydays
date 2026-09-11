import { MAX_ADDRESS_LEN, MAX_FREE_TEXT_LEN, MAX_NOTES_LEN } from '@od/shared/constants';
import { formatMinorUnits, parseMinorUnits } from '@od/shared/money';
import {
  activityDetailsInput,
  activityLocation,
  hhmm,
  type PatchActivityInput,
  watchEpisode,
  watchSeason,
} from '@od/shared/schemas';
import type { Activity, ActivityDetails, ActivityLocation } from '@od/shared/types';
import { Button, Field, SegmentedControl, Sheet, Text, useTheme } from '@od/ui';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Keyboard, View } from 'react-native';
import {
  buildDetailsPatch,
  type DetailsEdits,
} from '@/features/activity/model/buildDetailsPatch';
import { IngredientsControl } from '@/features/compose/controls/FormControls';
import type { DraftIngredient } from '@/features/compose/model/draft';
import type { PendingActivity } from '@/lib/pendingActivity';
import { DiscardChangesPrompt } from './DiscardChangesPrompt';

type DisplayActivity = Activity | PendingActivity;

const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
const WATCH_KINDS = ['movie', 'show'] as const;

/**
 * `type` is the Meal / Watch / Event sheet; `common` is the Task / General one, which holds
 * only the fields every kind shares — Place, Address and Link.
 */
export type TypeDetailsSheetMode = 'type' | 'common';

export interface TypeDetailsSheetProps {
  open: boolean;
  mode: TypeDetailsSheetMode;
  activity: DisplayActivity;
  onClose: () => void;
  onSave: (input: PatchActivityInput) => Promise<boolean>;
  busy?: boolean;
  error?: string;
}

interface Draft {
  mealSlot: (typeof MEAL_SLOTS)[number] | undefined;
  recipeUrl: string;
  /** Existing rows keep their stored `ing_` id; only a row added here mints one. */
  ingredients: DraftIngredient[];
  mediaKind: 'movie' | 'show' | undefined;
  season: string;
  episode: string;
  episodeTitle: string;
  service: string;
  description: string;
  priceText: string;
  currency: string;
  ticketUrl: string;
  organiser: string;
  reservationName: string;
  reservationTime: string;
  partySize: string;
  reservationReference: string;
  placeLabel: string;
  placeAddress: string;
  sourceUrl: string;
}

const EMPTY_DRAFT: Draft = {
  mealSlot: undefined,
  recipeUrl: '',
  ingredients: [],
  mediaKind: undefined,
  season: '',
  episode: '',
  episodeTitle: '',
  service: '',
  description: '',
  priceText: '',
  currency: '',
  ticketUrl: '',
  organiser: '',
  reservationName: '',
  reservationTime: '',
  partySize: '',
  reservationReference: '',
  placeLabel: '',
  placeAddress: '',
  sourceUrl: '',
};

function draftFrom(activity: DisplayActivity): Draft {
  const { details } = activity;
  const next: Draft = {
    ...EMPTY_DRAFT,
    placeLabel: activity.location?.label ?? '',
    placeAddress: activity.location?.address ?? '',
    sourceUrl: activity.sourceUrl ?? '',
  };
  if (details.kind === 'meal') {
    next.mealSlot = details.mealSlot;
    next.recipeUrl = details.recipeUrl ?? '';
    next.ingredients = (details.ingredients ?? []).map((row) => ({
      id: row.ingredientId,
      name: row.name,
      quantity: row.quantity ?? '',
      selected: false,
    }));
  }
  if (details.kind === 'watch') {
    next.mediaKind = details.mediaKind;
    next.season = details.season === undefined ? '' : String(details.season);
    next.episode = details.episode === undefined ? '' : String(details.episode);
    next.episodeTitle = details.episodeTitle ?? '';
    next.service = details.service ?? '';
  }
  if (details.kind === 'event') {
    next.description = details.description ?? '';
    next.priceText =
      details.priceCents === undefined ? '' : formatMinorUnits(details.priceCents);
    next.currency = details.currency ?? '';
    next.ticketUrl = details.ticketUrl ?? '';
    next.organiser = details.organiser ?? '';
    next.reservationName = details.reservation?.name ?? '';
    next.reservationTime = details.reservation?.time ?? '';
    next.partySize =
      details.reservation?.partySize === undefined
        ? ''
        : String(details.reservation.partySize);
    next.reservationReference = details.reservation?.reference ?? '';
  }
  return next;
}

function sheetTitle(mode: TypeDetailsSheetMode, kind: ActivityDetails['kind']): string {
  if (mode === 'common') return 'Details';
  if (kind === 'meal') return 'Meal details';
  if (kind === 'watch') return 'Watch details';
  if (kind === 'event') return 'Event details';
  return 'Details';
}

/**
 * One sheet per type (`meal`, `watch`, `event`) plus the common `Details` sheet a Task or
 * General plan opens. Save sends the wholesale `details` replacement (on the type sheet)
 * through the same `detail.patch` owner as every other field. Failed saves keep the draft;
 * dirty cancel uses the notes confirmation (`activities.md` §6.1).
 *
 * **One Edit edits every detail** (2026-09-10): the type sheet ends with the same `Link`
 * field, so the Details group's single `Edit` reaches the source link too. It rides in the
 * same PATCH as `details`, and only when it changed (`null` clears it).
 *
 * **Place is editable after creation** (founder, 2026-09-11): every sheet carries `Place` and
 * `Address` above `Link`. `location` rides in the same PATCH only when it changed, is
 * validated only then (the stored-link rule), and is built through the shared
 * `activityLocation` schema. Clearing both fields sends `location: null`; an address with no
 * place is a field error, because a location without a label identifies nothing and the
 * header would never show it. Capture's pin (`lat`/`lng`/`mapUrl`) survives a rename and is
 * dropped when the address changes, since it would point at the old one.
 */
export function TypeDetailsSheet({
  open,
  mode,
  activity,
  onClose,
  onSave,
  busy = false,
  error,
}: TypeDetailsSheetProps) {
  const theme = useTheme();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const original = useRef<Draft>(EMPTY_DRAFT);
  const inFlight = useRef(false);
  const seed = open ? `${activity.activityId}:${mode}` : '';
  const blocked = busy || saving;
  const dirty = open && !sameDraft(draft, original.current);

  // Seed on open / identity / mode only. A 409 refetch moves `updatedAt` and must not
  // wipe the typed draft the user is about to retry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed captures identity + mode
  useEffect(() => {
    if (!open) {
      setConfirming(false);
      setSaving(false);
      return;
    }
    const next = draftFrom(activity);
    original.current = next;
    setDraft(next);
    setFieldErrors({});
    setConfirming(false);
  }, [open, seed]);

  const statusMessage = blocked ? 'Saving…' : (error ?? fieldErrors.form);
  useEffect(() => {
    if (statusMessage !== undefined) {
      AccessibilityInfo.announceForAccessibility(statusMessage);
    }
  }, [statusMessage]);

  function close() {
    Keyboard.dismiss();
    setConfirming(false);
    onClose();
  }

  function requestLeave() {
    if (inFlight.current || blocked) return;
    if (dirty) {
      Keyboard.dismiss();
      setConfirming(true);
      return;
    }
    close();
  }

  function patchDraft(patch: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function persist(input: PatchActivityInput) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      if (await onSave(input)) close();
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  async function save() {
    if (inFlight.current || blocked) return;
    setFieldErrors({});
    /**
     * The stored link is validated only once the user changes it. The server accepts any
     * scheme (`z.url()`), so a stored `mailto:` would otherwise block every save of a field
     * the user never touched — and the only way past it would be deleting their link.
     */
    const linkChanged = draft.sourceUrl.trim() !== (activity.sourceUrl ?? '');
    const link: ReturnType<typeof parseOptionalUrl> = linkChanged
      ? parseOptionalUrl(draft.sourceUrl)
      : { ok: true };
    const place = placeFromDraft(draft, activity.location);
    const commonErrors: Record<string, string> = {
      ...(link.ok ? {} : { sourceUrl: 'Enter a valid link.' }),
      ...(place.ok ? {} : place.errors),
    };
    const common: PatchActivityInput = {
      ...(link.ok && linkChanged ? { sourceUrl: link.value ?? null } : {}),
      ...(place.ok && place.change !== undefined ? { location: place.change } : {}),
    };
    if (mode === 'common') {
      if (hasKeys(commonErrors)) {
        setFieldErrors(commonErrors);
        return;
      }
      if (!hasKeys(common)) {
        close();
        return;
      }
      await persist(common);
      return;
    }

    const edits = editsFromDraft(activity.details.kind, draft, setFieldErrors);
    if (hasKeys(commonErrors)) {
      setFieldErrors((current) => ({ ...current, ...commonErrors }));
      return;
    }
    if (edits === undefined) return;
    const details = buildDetailsPatch(activity.details, edits);
    const parsed = activityDetailsInput.safeParse(details);
    if (!parsed.success) {
      setFieldErrors({ form: parsed.error.issues[0]?.message ?? 'Check the details.' });
      return;
    }
    await persist({ details: parsed.data, ...common });
  }

  const kind = activity.details.kind;
  const title = sheetTitle(mode, kind);
  const showMovieProgress = draft.mediaKind !== 'movie';
  const storedIngredientCount =
    activity.details.kind === 'meal' ? (activity.details.ingredients?.length ?? 0) : 0;
  const placeFields = (
    <PlaceFields draft={draft} fieldErrors={fieldErrors} onChange={patchDraft} />
  );
  const linkField = (
    <Field
      label="Link"
      value={draft.sourceUrl}
      onChangeText={(sourceUrl) => patchDraft({ sourceUrl })}
      keyboardType="url"
      placeholder="https://"
      hint="Where this came from. Clear it to remove the link."
      testID="type-details-source-url"
      {...(fieldErrors.sourceUrl === undefined ? {} : { error: fieldErrors.sourceUrl })}
    />
  );

  return (
    <>
      <Sheet
        open={open}
        onClose={requestLeave}
        dirty={dirty}
        onDiscardRequest={requestLeave}
        title={title}
        // Sized from the stored rows, not the draft, so adding the first ingredient does not
        // jump the sheet from `fit` to `large` mid-edit; `fit` grows with its content anyway.
        detent={
          mode === 'common' || (kind === 'meal' && storedIngredientCount === 0)
            ? 'fit'
            : 'large'
        }
        testID={mode === 'common' ? 'details-sheet' : 'type-details-sheet'}
        actions={
          <View style={{ flexDirection: 'row', gap: theme.space[3] }}>
            <Button
              label="Cancel"
              variant="ghost"
              disabled={blocked}
              onPress={requestLeave}
              testID="type-details-cancel"
            />
            <View style={{ flex: 1 }}>
              <Button
                label="Save"
                fullWidth
                loading={blocked}
                onPress={() => void save()}
                testID={mode === 'common' ? 'details-save' : 'type-details-save'}
              />
            </View>
          </View>
        }
      >
        {statusMessage === undefined ? null : (
          <Text
            variant="footnote"
            color={blocked ? 'textSecondary' : 'danger'}
            numberOfLines={0}
            accessibilityLiveRegion="polite"
          >
            {statusMessage}
          </Text>
        )}
        {mode === 'common' ? (
          <View style={{ gap: theme.space[6] }}>
            {placeFields}
            {linkField}
          </View>
        ) : (
          <View style={{ gap: theme.space[6] }}>
            {kind === 'meal' ? (
              <MealFields draft={draft} fieldErrors={fieldErrors} onChange={patchDraft} />
            ) : kind === 'watch' ? (
              <WatchFields
                draft={draft}
                showProgress={showMovieProgress}
                fieldErrors={fieldErrors}
                onChange={patchDraft}
              />
            ) : kind === 'event' ? (
              <EventFields
                draft={draft}
                shared={activity.visibility === 'shared'}
                fieldErrors={fieldErrors}
                onChange={patchDraft}
              />
            ) : null}
            {placeFields}
            {linkField}
          </View>
        )}
      </Sheet>
      <DiscardChangesPrompt
        open={confirming}
        message="Your details have unsaved changes."
        onKeepEditing={() => setConfirming(false)}
        onDiscard={close}
      />
    </>
  );
}

/**
 * `Place` and `Address`, on every kind's sheet (founder, 2026-09-11). The label is marked
 * required as soon as an address is typed, the creation form's `LocationControl` rule.
 */
function PlaceFields({
  draft,
  fieldErrors,
  onChange,
}: {
  draft: Draft;
  fieldErrors: Record<string, string>;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const theme = useTheme();
  const addressTyped = draft.placeAddress.trim() !== '';
  return (
    <View style={{ gap: theme.space[6] }}>
      <Field
        label="Place"
        value={draft.placeLabel}
        onChangeText={(placeLabel) => onChange({ placeLabel })}
        maxLength={MAX_FREE_TEXT_LEN}
        required={addressTyped}
        hint="Clear it, and the address, to remove the place."
        testID="type-details-place"
        {...(fieldErrors.placeLabel === undefined
          ? {}
          : { error: fieldErrors.placeLabel })}
      />
      <Field
        label="Address"
        value={draft.placeAddress}
        onChangeText={(placeAddress) => onChange({ placeAddress })}
        maxLength={MAX_ADDRESS_LEN}
        optional
        testID="type-details-address"
        {...(fieldErrors.placeAddress === undefined
          ? {}
          : { error: fieldErrors.placeAddress })}
      />
    </View>
  );
}

/** The shared schema's own output shape, so the PATCH carries exactly what it parsed. */
type PlaceChange = NonNullable<PatchActivityInput['location']>;

const PLACE_NEEDS_LABEL = 'Name the place so the address has something to belong to.';

/**
 * The `location` change, if any. `change` absent is "leave it alone"; `null` clears it.
 * Compared trimmed, so re-typing the same place is not an edit.
 */
function placeFromDraft(
  draft: Draft,
  stored: ActivityLocation | undefined,
):
  | { ok: true; change?: PlaceChange | null }
  | { ok: false; errors: Record<string, string> } {
  const label = draft.placeLabel.trim();
  const address = draft.placeAddress.trim();
  const storedAddress = stored?.address?.trim() ?? '';
  if (label === (stored?.label.trim() ?? '') && address === storedAddress) {
    return { ok: true };
  }
  if (label === '') {
    if (address !== '') return { ok: false, errors: { placeLabel: PLACE_NEEDS_LABEL } };
    return stored === undefined ? { ok: true } : { ok: true, change: null };
  }
  const keepPin = stored !== undefined && address === storedAddress;
  const parsed = activityLocation.safeParse({
    label,
    ...(address === '' ? {} : { address }),
    ...(keepPin && stored.lat !== undefined ? { lat: stored.lat } : {}),
    ...(keepPin && stored.lng !== undefined ? { lng: stored.lng } : {}),
    ...(keepPin && stored.mapUrl !== undefined ? { mapUrl: stored.mapUrl } : {}),
  });
  if (!parsed.success) {
    const onAddress = parsed.error.issues.some((issue) => issue.path[0] === 'address');
    return {
      ok: false,
      errors: onAddress
        ? { placeAddress: `Use ${String(MAX_ADDRESS_LEN)} characters or fewer.` }
        : { placeLabel: `Use ${String(MAX_FREE_TEXT_LEN)} characters or fewer.` },
    };
  }
  return { ok: true, change: parsed.data };
}

function MealFields({
  draft,
  fieldErrors,
  onChange,
}: {
  draft: Draft;
  fieldErrors: Record<string, string>;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const theme = useTheme();
  const selected = draft.mealSlot === undefined ? -1 : MEAL_SLOTS.indexOf(draft.mealSlot);
  return (
    <View style={{ gap: theme.space[6] }}>
      <View style={{ gap: theme.space[2] }} testID="type-details-slot">
        <Text variant="footnoteStrong" color="textSecondary">
          Slot
        </Text>
        <SegmentedControl
          segments={MEAL_SLOTS.map((slot) => ({
            label: slot.charAt(0).toUpperCase() + slot.slice(1),
          }))}
          selectedIndex={selected}
          onChange={(index) => {
            const slot = MEAL_SLOTS[index];
            if (slot === undefined) return;
            onChange({ mealSlot: draft.mealSlot === slot ? undefined : slot });
          }}
        />
      </View>
      {/**
       * The compose control, reused rather than rebuilt (2026-09-10): the same rows, the same
       * cap at `MAX_INGREDIENTS`, the same `newIngredient()` minting for a new row. A row
       * loaded from the meal keeps its stored id, so the server can carry its `Added` marker.
       */}
      <IngredientsControl
        rows={draft.ingredients}
        onChange={(ingredients) => onChange({ ingredients })}
      />
      <Field
        label="Recipe link"
        value={draft.recipeUrl}
        onChangeText={(recipeUrl) => onChange({ recipeUrl })}
        keyboardType="url"
        placeholder="https://"
        testID="type-details-recipe-url"
        {...(fieldErrors.recipeUrl === undefined ? {} : { error: fieldErrors.recipeUrl })}
      />
    </View>
  );
}

function WatchFields({
  draft,
  showProgress,
  fieldErrors,
  onChange,
}: {
  draft: Draft;
  showProgress: boolean;
  fieldErrors: Record<string, string>;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const theme = useTheme();
  const selected =
    draft.mediaKind === undefined ? -1 : WATCH_KINDS.indexOf(draft.mediaKind);
  return (
    <View style={{ gap: theme.space[6] }}>
      <View style={{ gap: theme.space[2] }} testID="type-details-kind">
        <Text variant="footnoteStrong" color="textSecondary">
          Movie or show
        </Text>
        <SegmentedControl
          segments={[{ label: 'Movie' }, { label: 'Show' }]}
          selectedIndex={selected}
          onChange={(index) => {
            const mediaKind = WATCH_KINDS[index];
            if (mediaKind === undefined) return;
            onChange({ mediaKind });
          }}
        />
      </View>
      {showProgress ? (
        <>
          <Field
            label="Season"
            value={draft.season}
            onChangeText={(season) => onChange({ season })}
            keyboardType="number-pad"
            maxLength={4}
            testID="type-details-season"
            {...(fieldErrors.season === undefined ? {} : { error: fieldErrors.season })}
          />
          <Field
            label="Episode"
            value={draft.episode}
            onChangeText={(episode) => onChange({ episode })}
            keyboardType="number-pad"
            maxLength={5}
            testID="type-details-episode"
            {...(fieldErrors.episode === undefined ? {} : { error: fieldErrors.episode })}
          />
          <Field
            label="Episode title"
            value={draft.episodeTitle}
            onChangeText={(episodeTitle) => onChange({ episodeTitle })}
            maxLength={MAX_FREE_TEXT_LEN}
            testID="type-details-episode-title"
          />
        </>
      ) : (
        <Text variant="footnote" color="textSecondary">
          Season and episode are not shown for a movie.
        </Text>
      )}
      <Field
        label="Streaming service"
        value={draft.service}
        onChangeText={(service) => onChange({ service })}
        maxLength={MAX_FREE_TEXT_LEN}
        placeholder="Netflix, Apple TV+…"
        hint="Free text — there is no provider list."
        testID="type-details-service"
      />
    </View>
  );
}

function EventFields({
  draft,
  shared,
  fieldErrors,
  onChange,
}: {
  draft: Draft;
  shared: boolean;
  fieldErrors: Record<string, string>;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[6] }}>
      <Field
        label="Description"
        value={draft.description}
        onChangeText={(description) => onChange({ description })}
        multiline
        maxLength={MAX_NOTES_LEN}
        hint={
          shared
            ? 'Everyone you invite can read this.'
            : 'Shown on the invite page if you share this.'
        }
        testID="type-details-description"
      />
      <Field
        label="Reservation name"
        value={draft.reservationName}
        onChangeText={(reservationName) => onChange({ reservationName })}
        maxLength={MAX_FREE_TEXT_LEN}
        testID="type-details-reservation-name"
      />
      <Field
        label="Reservation time"
        value={draft.reservationTime}
        onChangeText={(reservationTime) => onChange({ reservationTime })}
        placeholder="19:30"
        maxLength={5}
        testID="type-details-reservation-time"
        {...(fieldErrors.reservationTime === undefined
          ? {}
          : { error: fieldErrors.reservationTime })}
      />
      <Field
        label="Party size"
        value={draft.partySize}
        onChangeText={(partySize) => onChange({ partySize })}
        keyboardType="number-pad"
        maxLength={2}
        testID="type-details-party-size"
        {...(fieldErrors.partySize === undefined ? {} : { error: fieldErrors.partySize })}
      />
      <Field
        label="Reservation reference"
        value={draft.reservationReference}
        onChangeText={(reservationReference) => onChange({ reservationReference })}
        maxLength={MAX_FREE_TEXT_LEN}
        testID="type-details-reservation-reference"
      />
      <Field
        label="Price"
        value={draft.priceText}
        onChangeText={(priceText) => onChange({ priceText })}
        keyboardType="number-pad"
        placeholder="0.00"
        testID="type-details-price"
        {...(fieldErrors.price === undefined ? {} : { error: fieldErrors.price })}
      />
      <Field
        label="Currency"
        value={draft.currency}
        onChangeText={(currency) => onChange({ currency })}
        maxLength={3}
        placeholder="GBP"
        testID="type-details-currency"
        {...(fieldErrors.currency === undefined ? {} : { error: fieldErrors.currency })}
      />
      <Field
        label="Ticket link"
        value={draft.ticketUrl}
        onChangeText={(ticketUrl) => onChange({ ticketUrl })}
        keyboardType="url"
        placeholder="https://"
        testID="type-details-ticket-url"
        {...(fieldErrors.ticketUrl === undefined ? {} : { error: fieldErrors.ticketUrl })}
      />
      <Field
        label="Organiser"
        value={draft.organiser}
        onChangeText={(organiser) => onChange({ organiser })}
        maxLength={MAX_FREE_TEXT_LEN}
        testID="type-details-organiser"
      />
    </View>
  );
}

function editsFromDraft(
  kind: ActivityDetails['kind'],
  draft: Draft,
  setFieldErrors: (errors: Record<string, string>) => void,
): DetailsEdits | undefined {
  const errors: Record<string, string> = {};
  if (kind === 'meal') {
    const recipeUrl = parseOptionalUrl(draft.recipeUrl);
    if (!recipeUrl.ok) errors.recipeUrl = 'Enter a valid link.';
    if (hasKeys(errors)) {
      setFieldErrors(errors);
      return undefined;
    }
    const recipe = recipeUrl.ok ? recipeUrl.value : undefined;
    return {
      kind: 'meal',
      ...(draft.mealSlot === undefined ? {} : { mealSlot: draft.mealSlot }),
      ...(recipe === undefined ? {} : { recipeUrl: recipe }),
      ingredients: draft.ingredients.map((row) => ({
        ingredientId: row.id,
        name: row.name,
        quantity: row.quantity,
      })),
    };
  }
  if (kind === 'watch') {
    const season = parseOptionalBounded(draft.season, watchSeason);
    const episode = parseOptionalBounded(draft.episode, watchEpisode);
    if (!season.ok) errors.season = 'Enter a whole number from 0 to 1000.';
    if (!episode.ok) errors.episode = 'Enter a whole number from 0 to 10000.';
    if (hasKeys(errors)) {
      setFieldErrors(errors);
      return undefined;
    }
    const seasonNumber = season.ok ? season.value : undefined;
    const episodeNumber = episode.ok ? episode.value : undefined;
    return {
      kind: 'watch',
      ...(draft.mediaKind === undefined ? {} : { mediaKind: draft.mediaKind }),
      ...(seasonNumber === undefined ? {} : { season: seasonNumber }),
      ...(episodeNumber === undefined ? {} : { episode: episodeNumber }),
      ...(trimmed(draft.episodeTitle) === undefined
        ? {}
        : { episodeTitle: draft.episodeTitle.trim() }),
      ...(trimmed(draft.service) === undefined ? {} : { service: draft.service.trim() }),
    };
  }
  if (kind === 'event') {
    const ticketUrl = parseOptionalUrl(draft.ticketUrl);
    if (!ticketUrl.ok) errors.ticketUrl = 'Enter a valid link.';
    const price = parseOptionalPrice(draft.priceText);
    if (!price.ok) errors.price = 'Enter a price with at most two decimal places.';
    const currency = draft.currency.trim().toUpperCase();
    if (currency !== '' && currency.length !== 3) {
      errors.currency = 'Use a 3-letter currency code.';
    }
    const time = draft.reservationTime.trim();
    if (time !== '' && !hhmm.safeParse(time).success) {
      errors.reservationTime = 'Use 24-hour time, for example 19:30.';
    }
    const partySize = parseOptionalPartySize(draft.partySize);
    if (!partySize.ok) errors.partySize = 'Enter a whole number from 1 to 99.';
    if (hasKeys(errors)) {
      setFieldErrors(errors);
      return undefined;
    }
    const party = partySize.ok ? partySize.value : undefined;
    const priceCents = price.ok ? price.value : undefined;
    const ticket = ticketUrl.ok ? ticketUrl.value : undefined;
    const reservation = {
      ...(trimmed(draft.reservationName) === undefined
        ? {}
        : { name: draft.reservationName.trim() }),
      ...(time === '' ? {} : { time }),
      ...(party === undefined ? {} : { partySize: party }),
      ...(trimmed(draft.reservationReference) === undefined
        ? {}
        : { reference: draft.reservationReference.trim() }),
    };
    return {
      kind: 'event',
      ...(trimmed(draft.description) === undefined
        ? {}
        : { description: draft.description.trim() }),
      ...(priceCents === undefined ? {} : { priceCents }),
      ...(currency === '' ? {} : { currency }),
      ...(ticket === undefined ? {} : { ticketUrl: ticket }),
      ...(trimmed(draft.organiser) === undefined
        ? {}
        : { organiser: draft.organiser.trim() }),
      ...(hasKeys(reservation) ? { reservation } : {}),
    };
  }
  setFieldErrors({ form: 'This plan has no type details to edit.' });
  return undefined;
}

function parseOptionalUrl(text: string): { ok: true; value?: string } | { ok: false } {
  const raw = text.trim();
  if (raw === '') return { ok: true };
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false };
    return { ok: true, value: raw };
  } catch {
    return { ok: false };
  }
}

function parseOptionalPrice(text: string): { ok: true; value?: number } | { ok: false } {
  if (text.trim() === '') return { ok: true };
  const value = parseMinorUnits(text);
  if (value === undefined) return { ok: false };
  return { ok: true, value };
}

function parseOptionalPartySize(
  text: string,
): { ok: true; value?: number } | { ok: false } {
  const raw = text.trim();
  if (raw === '') return { ok: true };
  if (!/^\d+$/.test(raw)) return { ok: false };
  let value = 0;
  for (const ch of raw) {
    value = value * 10 + (ch.charCodeAt(0) - 48);
  }
  if (value < 1 || value > 99) return { ok: false };
  return { ok: true, value };
}

function parseOptionalBounded(
  text: string,
  schema: typeof watchSeason | typeof watchEpisode,
): { ok: true; value?: number } | { ok: false } {
  const raw = text.trim();
  if (raw === '') return { ok: true };
  if (!/^\d+$/.test(raw)) return { ok: false };
  let value = 0;
  for (const ch of raw) {
    value = value * 10 + (ch.charCodeAt(0) - 48);
    if (!Number.isSafeInteger(value)) return { ok: false };
  }
  if (!schema.safeParse(value).success) return { ok: false };
  return { ok: true, value };
}

function trimmed(value: string): string | undefined {
  const next = value.trim();
  return next === '' ? undefined : next;
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}

function sameDraft(left: Draft, right: Draft): boolean {
  return (Object.keys(EMPTY_DRAFT) as Array<keyof Draft>).every((key) =>
    key === 'ingredients'
      ? sameIngredients(left.ingredients, right.ingredients)
      : left[key] === right[key],
  );
}

/**
 * Compared as they would be saved: a blank row is dropped on save, so adding one and leaving
 * it empty is not an unsaved change worth a discard prompt.
 */
function sameIngredients(left: DraftIngredient[], right: DraftIngredient[]): boolean {
  const saved = (rows: DraftIngredient[]) =>
    rows
      .filter((row) => row.name.trim() !== '')
      .map((row) => [row.id, row.name.trim(), row.quantity.trim()]);
  return JSON.stringify(saved(left)) === JSON.stringify(saved(right));
}
