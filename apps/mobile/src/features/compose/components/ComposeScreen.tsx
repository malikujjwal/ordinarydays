import { MAX_NOTES_LEN } from '@od/shared/constants';
import { Button, Close, Field, IconButton, ScreenShell, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { CaptureRow } from '@/features/compose/components/CaptureRow';
import { ComposeForm, ComposeSaveBar } from '@/features/compose/components/ComposeForm';
import { DiscardPrompt } from '@/features/compose/components/DiscardPrompt';
import {
  type ListDestination,
  ListDestinationChooser,
} from '@/features/compose/components/ListDestinationChooser';
import { ObjectChooser } from '@/features/compose/components/ObjectChooser';
import { PlanKindChooser } from '@/features/compose/components/PlanKindChooser';
import { TypedFields } from '@/features/compose/forms/TypedFields';
import { useCreateActivity } from '@/features/compose/hooks/useCreateActivity';
import { titleLabel } from '@/features/compose/model/fields';
import { canSave, successToast } from '@/features/compose/model/targets';
import { useAddListItem } from '@/hooks/useAddListItem';
import {
  type EventDraftDefaults,
  hasContent,
  useComposeDraft,
} from '@/stores/composeDraft';
import { useToast } from '@/stores/toast';

/**
 * The modal Add flow, end to end (P1-24).
 *
 * `object` → (`planKind`) → `form`, and **the sequence is the product rule**: there is no
 * branch here that reaches `form` with a target the user did not tap for, and no branch that
 * reaches a writable title field before one. The store holds `target` as `undefined` until a
 * tap sets it, so "not chosen yet" is a state this component can render rather than a state
 * it has to avoid producing.
 *
 * Nothing is written to the server before the named write button. `onSave` is the only call
 * site of the mutation in this feature.
 */
export interface ComposeScreenProps {
  /** Dismisses the modal. Supplied by the route so this component never navigates itself. */
  onClose: () => void;
  /**
   * The user's today and zone, resolved at the route (P1-25).
   *
   * Both are injected for the reason `coding-standards.md` §4.3 gives: a component that read
   * the clock could not be tested across a date boundary, and `This weekend` would mean
   * something different in a test than on a device. The route is the edge; this is not.
   */
  today: string;
  timezone: string;
  /** Resolves the profile-backed defaults only when the user chooses Event. */
  loadEventDefaults?: () => Promise<EventDraftDefaults | undefined>;
  /**
   * The lists `List item` may be added to, supplied by the route (P3-27).
   *
   * Injected for the same reason `loadEventDefaults` is, plus one this feature cannot get
   * around: the lists belong to another feature slice, and `no-cross-feature-imports` makes
   * the route the one place allowed to see both. It is server pointer order, unfiltered —
   * nothing here re-sorts it, and there is no default to fall back to (criterion 33).
   */
  listDestinations?: {
    readonly lists: readonly ListDestination[];
    readonly status: 'pending' | 'success' | 'error';
    readonly refetch: () => void;
  };
  /** Opens P3-26's creation sheet; the route wires its `onCreated` back to `chooseList`. */
  onCreateList?: () => void;
}

export function ComposeScreen({
  onClose,
  today,
  timezone,
  loadEventDefaults,
  listDestinations,
  onCreateList,
}: ComposeScreenProps) {
  const theme = useTheme();
  const draft = useComposeDraft();
  const showToast = useToast((s) => s.show);
  const create = useCreateActivity();
  const addItem = useAddListItem();
  const [discardOpen, setDiscardOpen] = useState(false);
  const itemTarget = draft.target?.objectKind === 'listItem' ? draft.target : undefined;
  const destinationTitle =
    itemTarget === undefined
      ? undefined
      : listDestinations?.lists.find((list) => list.listId === itemTarget.listId)?.title;

  function choosePlanKind(type: Parameters<typeof draft.choosePlanKind>[0]) {
    if (type !== 'event' || loadEventDefaults === undefined) {
      draft.choosePlanKind(type);
      return;
    }

    // The route starts `/me` eagerly. Awaiting it here closes the cold-cache race without
    // copying query data into draft state from an effect after the form is already visible.
    void loadEventDefaults()
      .then((defaults) => draft.choosePlanKind(type, defaults))
      .catch(() => draft.choosePlanKind(type));
  }

  /** Closing with content asks first; closing an empty draft just closes (§2.2). */
  function requestClose() {
    if (hasContent(draft)) {
      setDiscardOpen(true);
      return;
    }
    draft.reset();
    onClose();
  }

  async function save() {
    if (draft.target === undefined) return;
    const target = draft.target;
    const saved = await create.save(
      target,
      {
        title: draft.title,
        notes: draft.notes,
        ...(draft.sourceUrl === undefined ? {} : { sourceUrl: draft.sourceUrl }),
        schedule: draft.schedule,
        location: draft.location,
        reminderOffset: draft.reminderOffset,
        ...(draft.recurrence === undefined ? {} : { recurrence: draft.recurrence }),
        details: draft.details,
      },
      timezone,
    );
    if (!saved) return; // The banner is already showing; the draft stays put.

    // §2.5's order: the form dismisses, then the toast names where it landed.
    draft.reset();
    onClose();
    showToast({ message: successToast(target, draft.schedule, today) });
  }

  /**
   * Adds the item and closes, the same shape `save` has.
   *
   * The path id is the list on the button, and it comes from the target the user chose —
   * there is no branch here that could reach a default or a recent destination.
   */
  async function addToList() {
    if (itemTarget === undefined) return;
    const note = draft.notes.trim();
    const added = await addItem.add(itemTarget.listId, {
      title: draft.title.trim(),
      ...(note === '' ? {} : { note }),
    });
    if (!added) return;
    draft.reset();
    onClose();
    showToast({ message: `Added to ${destinationTitle ?? 'list'}` });
  }

  const showBack = draft.step !== 'object';
  /** Every step with a fixed target to write, and so the steps that have a footer. */
  const activityForm =
    draft.step === 'form' &&
    draft.target !== undefined &&
    draft.target.objectKind !== 'listItem';
  const itemForm = draft.step === 'form' && draft.target?.objectKind === 'listItem';

  const header = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingBottom: theme.space[3],
      }}
    >
      {/*
          `Back` on the later steps, and **nothing** on the first one.

          The first step used to carry a `Cancel` beside the `✕`, and the two called the same
          handler — two controls, one behaviour, which is a thing to hunt for rather than a
          choice. `Back` and `✕` on the later steps are genuinely different actions (previous
          step versus leave), so both stay: without the `✕` the only way out of a deep form
          would be to step backwards through every screen of it.

          The empty `View` holds the layout: this row is `space-between`, and dropping the
          child entirely would pull the close button to the left edge.
        */}
      {showBack ? (
        <Button
          label="Back"
          variant="ghost"
          flush
          onPress={() => draft.back()}
          testID="compose-back"
        />
      ) : (
        <View />
      )}
      <IconButton
        icon={Close}
        label="Close"
        onPress={requestClose}
        testID="compose-close"
      />
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      {/**
       * `ScreenShell` owns the gutters, the centred column, the safe area, the keyboard inset
       * and — since P2-43 — the pinned footer the named write sits in. This screen used to
       * answer all five for itself, and answered the last one by letting `Save plan` scroll
       * away below an Event form.
       */}
      <ScreenShell
        header={header}
        measure="reading"
        {...(draft.target !== undefined && (activityForm || itemForm)
          ? {
              footer: (
                <ComposeSaveBar
                  target={draft.target}
                  saveEnabled={canSave({ title: draft.title, notes: draft.notes })}
                  attachmentUri={draft.attachmentUri}
                  onSave={() => void (itemForm ? addToList() : save())}
                  isSaving={itemForm ? addItem.isAdding : create.isSaving}
                  {...(destinationTitle === undefined
                    ? {}
                    : { listName: destinationTitle })}
                />
              ),
            }
          : {})}
      >
        <View style={{ gap: theme.space[5] }}>
          {draft.step === 'object' ? (
            <ObjectChooser onChoose={draft.chooseObject} />
          ) : draft.step === 'planKind' ? (
            <PlanKindChooser onChoose={choosePlanKind} />
          ) : draft.step === 'listPicker' ? (
            /*
             * `List item`'s required destination, before any field exists (criterion 33).
             * With no injected source there is nothing to choose from, so the step says so
             * rather than inventing one.
             */
            <ListDestinationChooser
              lists={listDestinations?.lists ?? []}
              status={listDestinations?.status ?? 'pending'}
              onChoose={draft.chooseList}
              onCreateList={() => onCreateList?.()}
              onRetry={() => listDestinations?.refetch()}
            />
          ) : draft.target === undefined ? null : draft.target.objectKind ===
            'listItem' ? (
            /*
             * The item form: title, note and the capture stubs — which receive the chosen
             * `listId` and can never return a different one (`activities.md` §2.3).
             * Location and the typed per-behaviour fields are P3-29's.
             */
            <ComposeForm
              target={draft.target}
              fields={{ title: draft.title, notes: draft.notes }}
              titleLabel="Item"
              typedFields={
                <View style={{ gap: theme.space[6] }}>
                  {/* §5.7's one optional field for every behaviour. */}
                  <Field
                    label="Note"
                    value={draft.notes}
                    onChangeText={draft.setNotes}
                    multiline
                    maxLength={MAX_NOTES_LEN}
                    testID="compose-item-note"
                  />
                  <CaptureRow
                    sourceUrl={draft.sourceUrl}
                    onSourceUrlChange={draft.setSourceUrl}
                    attachmentUri={draft.attachmentUri}
                    onAttach={draft.attachImage}
                    onClearAttachment={draft.clearAttachment}
                  />
                </View>
              }
              onTitleChange={draft.setTitle}
              onChangeTarget={() => draft.back()}
              errorMessage={addItem.errorMessage}
              errorRequestId={undefined}
              fieldErrors={{}}
            />
          ) : (
            <ComposeForm
              target={draft.target}
              fields={{
                title: draft.title,
                notes: draft.notes,
                ...(draft.sourceUrl === undefined ? {} : { sourceUrl: draft.sourceUrl }),
              }}
              titleLabel={titleLabel(draft.target.type)}
              typedFields={
                <TypedFields
                  type={draft.target.type}
                  title={draft.title}
                  schedule={draft.schedule}
                  location={draft.location}
                  reminderOffset={draft.reminderOffset}
                  {...(draft.recurrence === undefined
                    ? {}
                    : { recurrence: draft.recurrence })}
                  details={draft.details}
                  notes={draft.notes}
                  sourceUrl={draft.sourceUrl}
                  attachmentUri={draft.attachmentUri}
                  today={today}
                  onDateChange={draft.setDate}
                  onTimeChange={draft.setTime}
                  onSlotTimeChange={draft.setTimeFromSlot}
                  onEndTimeChange={draft.setEndTime}
                  onLocationChange={draft.setLocation}
                  onReminderChange={draft.setReminderOffset}
                  onRecurrenceChange={draft.setRecurrence}
                  onDetailsChange={draft.setDetails}
                  onNotesChange={draft.setNotes}
                  onSourceUrlChange={draft.setSourceUrl}
                  onAttach={draft.attachImage}
                  onClearAttachment={draft.clearAttachment}
                  fieldErrors={create.fieldErrors}
                />
              }
              onTitleChange={draft.setTitle}
              onChangeTarget={() => draft.back()}
              errorMessage={create.errorMessage}
              errorRequestId={create.errorRequestId}
              fieldErrors={create.fieldErrors}
            />
          )}
        </View>
      </ScreenShell>

      <DiscardPrompt
        open={discardOpen}
        onKeepEditing={() => setDiscardOpen(false)}
        onDiscard={() => {
          setDiscardOpen(false);
          draft.reset();
          onClose();
        }}
      />
    </View>
  );
}
