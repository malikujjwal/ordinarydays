import { MAX_FREE_TEXT_LEN, MAX_NOTES_LEN } from '@od/shared/constants';
import { formatMinorUnits, parseMinorUnits } from '@od/shared/money';
import {
  activityDetailsInput,
  hhmm,
  type PatchActivityInput,
  watchEpisode,
  watchSeason,
} from '@od/shared/schemas';
import type { Activity, ActivityDetails } from '@od/shared/types';
import { Button, Field, SegmentedControl, Sheet, Text, useTheme } from '@od/ui';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Keyboard, View } from 'react-native';
import {
  buildDetailsPatch,
  type DetailsEdits,
} from '@/features/activity/model/buildDetailsPatch';
import type { PendingActivity } from '@/lib/pendingActivity';
import { DiscardChangesPrompt } from './DiscardChangesPrompt';

type DisplayActivity = Activity | PendingActivity;

const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
const WATCH_KINDS = ['movie', 'show'] as const;

export type TypeDetailsSheetMode = 'type' | 'link';

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
  sourceUrl: string;
}

const EMPTY_DRAFT: Draft = {
  mealSlot: undefined,
  recipeUrl: '',
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
  sourceUrl: '',
};

function draftFrom(activity: DisplayActivity): Draft {
  const { details } = activity;
  const next: Draft = {
    ...EMPTY_DRAFT,
    sourceUrl: activity.sourceUrl ?? '',
  };
  if (details.kind === 'meal') {
    next.mealSlot = details.mealSlot;
    next.recipeUrl = details.recipeUrl ?? '';
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
  if (mode === 'link') return 'Link';
  if (kind === 'meal') return 'Meal details';
  if (kind === 'watch') return 'Watch details';
  if (kind === 'event') return 'Event details';
  return 'Details';
}

/**
 * One sheet per type (`meal`, `watch`, `event`) plus LINK. Save sends the wholesale
 * `details` replacement (or `sourceUrl` alone on LINK) through the same `detail.patch`
 * owner as every other field. Failed saves keep the draft; dirty cancel uses the notes
 * confirmation (`activities.md` §6.1).
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
    if (mode === 'link') {
      const parsed = parseOptionalUrl(draft.sourceUrl);
      if (!parsed.ok) {
        setFieldErrors({ sourceUrl: 'Enter a valid link.' });
        return;
      }
      await persist({
        sourceUrl: parsed.value === undefined ? null : parsed.value,
      });
      return;
    }

    const edits = editsFromDraft(activity.details.kind, draft, setFieldErrors);
    if (edits === undefined) return;
    const details = buildDetailsPatch(activity.details, edits);
    const parsed = activityDetailsInput.safeParse(details);
    if (!parsed.success) {
      setFieldErrors({ form: parsed.error.issues[0]?.message ?? 'Check the details.' });
      return;
    }
    await persist({ details: parsed.data });
  }

  const kind = activity.details.kind;
  const title = sheetTitle(mode, kind);
  const showMovieProgress = draft.mediaKind !== 'movie';

  return (
    <>
      <Sheet
        open={open}
        onClose={requestLeave}
        dirty={dirty}
        onDiscardRequest={requestLeave}
        title={title}
        detent={mode === 'link' || kind === 'meal' ? 'fit' : 'large'}
        testID={mode === 'link' ? 'link-sheet' : 'type-details-sheet'}
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
                testID={mode === 'link' ? 'link-save' : 'type-details-save'}
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
        {mode === 'link' ? (
          <Field
            label="Link"
            value={draft.sourceUrl}
            onChangeText={(sourceUrl) => patchDraft({ sourceUrl })}
            keyboardType="url"
            placeholder="https://"
            hint="Where this came from. Clear it to remove the link."
            testID="type-details-source-url"
            {...(fieldErrors.sourceUrl === undefined
              ? {}
              : { error: fieldErrors.sourceUrl })}
          />
        ) : kind === 'meal' ? (
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
      </Sheet>
      <DiscardChangesPrompt
        open={confirming}
        message={
          mode === 'link'
            ? 'Your link has unsaved changes.'
            : 'Your details have unsaved changes.'
        }
        onKeepEditing={() => setConfirming(false)}
        onDiscard={close}
      />
    </>
  );
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
    return {
      kind: 'meal',
      ...(draft.mealSlot === undefined ? {} : { mealSlot: draft.mealSlot }),
      ...(recipeUrl.value === undefined ? {} : { recipeUrl: recipeUrl.value }),
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
    return {
      kind: 'watch',
      ...(draft.mediaKind === undefined ? {} : { mediaKind: draft.mediaKind }),
      ...(season.value === undefined ? {} : { season: season.value }),
      ...(episode.value === undefined ? {} : { episode: episode.value }),
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
    const reservation = {
      ...(trimmed(draft.reservationName) === undefined
        ? {}
        : { name: draft.reservationName.trim() }),
      ...(time === '' ? {} : { time }),
      ...(partySize.value === undefined ? {} : { partySize: partySize.value }),
      ...(trimmed(draft.reservationReference) === undefined
        ? {}
        : { reference: draft.reservationReference.trim() }),
    };
    return {
      kind: 'event',
      ...(trimmed(draft.description) === undefined
        ? {}
        : { description: draft.description.trim() }),
      ...(price.value === undefined ? {} : { priceCents: price.value }),
      ...(currency === '' ? {} : { currency }),
      ...(ticketUrl.value === undefined ? {} : { ticketUrl: ticketUrl.value }),
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
  return (Object.keys(EMPTY_DRAFT) as Array<keyof Draft>).every(
    (key) => left[key] === right[key],
  );
}
