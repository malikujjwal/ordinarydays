import type { CreationTarget } from '@od/shared/client';
import { MAX_TITLE_LEN } from '@od/shared/constants';
import { Button, Close, Field, IconButton, ScreenShell, Text, useTheme } from '@od/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type ScrollView, View } from 'react-native';
import { AudienceChooser } from '@/features/compose/components/AudienceChooser';
import { ComposeForm, ComposeSaveBar } from '@/features/compose/components/ComposeForm';
import { DiscardPrompt } from '@/features/compose/components/DiscardPrompt';
import { ListStyleChooser } from '@/features/compose/components/ListStyleChooser';
import { ObjectChooser } from '@/features/compose/components/ObjectChooser';
import { PlanKindChooser } from '@/features/compose/components/PlanKindChooser';
import { scrollRevealedSectionIntoView } from '@/features/compose/components/scrollRevealedSection';
import { TypedFields } from '@/features/compose/forms/TypedFields';
import { useCreateActivity } from '@/features/compose/hooks/useCreateActivity';
import { useListBridge } from '@/features/compose/hooks/useListBridge';
import { useScheduleListItem } from '@/features/compose/hooks/useScheduleListItem';
import { titleLabel } from '@/features/compose/model/fields';
import type { ObjectChoice } from '@/features/compose/model/targets';
import { createLabel, successToast } from '@/features/compose/model/targets';
import { useAttachmentUpload } from '@/hooks/useAttachmentUpload';
import { useDestination } from '@/hooks/useDestination';
import {
  savePlanAndAddItemsLabel,
  savePlanAndAddTitleLabel,
} from '@/lib/destinationCopy';
import {
  type EventDraftDefaults,
  hasContent,
  useComposeDraft,
} from '@/stores/composeDraft';
import { useToast } from '@/stores/toast';

/**
 * The modal Add flow, end to end (P1-24).
 *
 * Global Add is one sheet: title, then Task / Plan / Add list, then the relevant controls
 * inline. Contextual entries still skip the chooser. List items are created only from their
 * owning List.
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
  /** Global Add's List write, supplied by the route so this feature does not import lists. */
  listWriter?: {
    save: (templateKey: string, title: string) => Promise<string | undefined>;
    isCreating: boolean;
    errorMessage: string | undefined;
    errorRequestId: string | undefined;
  };
  /** P3-43: opens the route-composed destination picker for one of the form's slots. */
  onChooseDestination?: (slot: 'groceries' | 'watch') => void;
}

export function ComposeScreen({
  onClose,
  today,
  timezone,
  loadEventDefaults,
  listWriter,
  onChooseDestination,
}: ComposeScreenProps) {
  const theme = useTheme();
  const draft = useComposeDraft();
  const showToast = useToast((s) => s.show);
  const create = useCreateActivity();
  const bridge = useScheduleListItem();
  const [discardOpen, setDiscardOpen] = useState(false);
  const bodyScrollRef = useRef<ScrollView>(null);
  const revealedSectionRef = useRef<View>(null);
  /** Invalidates an in-flight Event-default load when the user names a later intent. */
  const intentGeneration = useRef(0);
  /** The `Plan this item` flow saves through the bridge endpoint; everything else creates. */
  const writer = draft.bridge === undefined ? create : bridge;

  function chooseObject(choice: ObjectChoice) {
    intentGeneration.current += 1;
    draft.chooseObject(choice);
  }

  function choosePlanKind(type: Parameters<typeof draft.choosePlanKind>[0]) {
    intentGeneration.current += 1;
    const generation = intentGeneration.current;
    if (type !== 'event' || loadEventDefaults === undefined) {
      draft.choosePlanKind(type);
      return;
    }

    // The route starts `/me` eagerly. Awaiting it here closes the cold-cache race without
    // copying query data into draft state from an effect after the form is already visible.
    void loadEventDefaults()
      .then((defaults) => {
        if (generation !== intentGeneration.current) return;
        draft.choosePlanKind(type, defaults);
      })
      .catch(() => {
        if (generation !== intentGeneration.current) return;
        draft.choosePlanKind(type);
      });
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

  /**
   * The form's photo uploads (P3-41). Owned here rather than in the capture row so a kind
   * change — which remounts the typed fields — cannot lose an upload in flight. The draft
   * mirrors the ids and the flags so the save gate and the discard prompt see them.
   */
  const attachments = useAttachmentUpload();
  const attachmentsFailed = attachments.uploads.some(
    (upload) => upload.status === 'failed',
  );
  const setAttachments = draft.setAttachments;
  useEffect(() => {
    setAttachments({
      ids: attachments.attachmentIds,
      busy: attachments.busy,
      failed: attachmentsFailed,
    });
  }, [setAttachments, attachments.attachmentIds, attachments.busy, attachmentsFailed]);
  useEffect(
    () => () => {
      intentGeneration.current += 1;
    },
    [],
  );

  /**
   * The list bridges (P3-43): the Meal's ingredient destination and the Watch form's
   * `Also add a list item to…`. Resolved here — the field table stays free of queries — and
   * the combined writes run after the plan's own save, each named on the button.
   */
  const mealForm = draft.target?.objectKind === 'plan' && draft.target.type === 'meal';
  const watchForm = draft.target?.objectKind === 'plan' && draft.target.type === 'watch';
  const groceries = useDestination('groceries', draft.destinations.groceries, mealForm);
  const watchList = useDestination(
    'watch',
    draft.destinations.watch,
    watchForm && draft.alsoAddToList,
  );
  const listBridge = useListBridge();
  const selectedIngredientIds = draft.details.ingredients
    .filter((row) => row.selected && row.name.trim() !== '')
    .map((row) => row.id);
  const mealBridge =
    draft.target?.objectKind === 'plan' &&
    draft.target.type === 'meal' &&
    selectedIngredientIds.length > 0 &&
    groceries.list !== undefined
      ? { listId: groceries.list.listId, listTitle: groceries.list.title }
      : undefined;
  const watchBridge =
    draft.target?.objectKind === 'plan' &&
    draft.target.type === 'watch' &&
    draft.alsoAddToList &&
    watchList.list !== undefined
      ? { list: watchList.list }
      : undefined;

  async function saveList() {
    if (draft.listTemplateKey === undefined || listWriter === undefined) return;
    const listId = await listWriter.save(draft.listTemplateKey, draft.title.trim());
    if (listId === undefined) return;
    draft.reset();
    onClose();
  }

  async function save() {
    if (draft.objectChoice === 'list') {
      await saveList();
      return;
    }
    if (draft.target === undefined) return;
    const target = draft.target;
    const fields = {
      title: draft.title,
      notes: draft.notes,
      ...(draft.sourceUrl === undefined ? {} : { sourceUrl: draft.sourceUrl }),
      schedule: draft.schedule,
      location: draft.location,
      reminderOffset: draft.reminderOffset,
      ...(draft.recurrence === undefined ? {} : { recurrence: draft.recurrence }),
      details: draft.details,
      ...(draft.parentActivityId === undefined
        ? {}
        : { parentActivityId: draft.parentActivityId }),
      attachmentIds: attachments.attachmentIds,
    };
    /**
     * `Save plan and add <title> to <list>` (P3-43, §8.1): the item is written first, then
     * the reviewed Plan goes through P3-13's bridge from it, with `audience: just_me`
     * supplied by this caller. The item outlives a failed bridge as an ordinary saved item.
     */
    if (watchBridge !== undefined) {
      const saved = await listBridge.saveWatchItemAndPlan(
        target,
        fields,
        timezone,
        watchBridge,
      );
      if (!saved) return;
    } else {
      const saved = await writer.save(target, fields, timezone);
      if (!saved) return; // The banner is already showing; the draft stays put.
      /**
       * `Save plan and add n items to <list>` (§9.2 step 4): the meal first, then P3-17. The
       * meal exists either way, so the form still closes — but a refused or failed add keeps
       * the bridge's own error toast ("The meal was saved, but …") rather than replacing it
       * with a success it did not have. The ingredients stay addable from the meal's detail.
       */
      if (mealBridge !== undefined) {
        const added = await listBridge.addIngredients(
          draft.takeActivityId(),
          mealBridge.listId,
          selectedIngredientIds,
        );
        if (!added) {
          draft.reset();
          onClose();
          return;
        }
      }
    }

    // §2.5's order: the form dismisses, then the toast names where it landed.
    draft.reset();
    onClose();
    showToast({ message: successToast(target, draft.schedule, today) });
  }

  const globalInline = !draft.intentLocked;
  const revealIdentity =
    draft.target === undefined
      ? draft.objectChoice
      : `${draft.objectChoice}:${draft.target.objectKind}:${'type' in draft.target ? draft.target.type : ''}`;
  useLayoutEffect(() => {
    void revealIdentity;
    if (!globalInline || draft.objectChoice === undefined) return;
    const frame = requestAnimationFrame(() => {
      scrollRevealedSectionIntoView(bodyScrollRef.current, revealedSectionRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [draft.objectChoice, globalInline, revealIdentity]);
  // The bridge enters at the kind step, so that step has nowhere back to go (P3-34).
  const showBack =
    !globalInline &&
    draft.step !== 'object' &&
    !(draft.bridge !== undefined && draft.step === 'planKind');
  /** Every step with a fixed target to write, and so the steps that have a footer. */
  const activityForm =
    draft.objectChoice !== 'list' &&
    draft.target !== undefined &&
    draft.target.objectKind !== 'listItem' &&
    (globalInline || draft.step === 'form');
  const titleReady = draft.title.trim() !== '';
  const writeEnabled =
    draft.objectChoice === undefined
      ? false
      : draft.objectChoice === 'list'
        ? titleReady && draft.listTemplateKey !== undefined
        : activityForm && titleReady;
  const writeLabel = globalInline
    ? draft.objectChoice === undefined
      ? 'Choose a category'
      : createLabel(draft.objectChoice)
    : undefined;
  const showFooter = globalInline || activityForm;
  const footer = showFooter ? (
    <ComposeSaveBar
      {...(draft.target === undefined || draft.objectChoice === 'list'
        ? {}
        : { target: draft.target })}
      {...(writeLabel === undefined ? {} : { label: writeLabel })}
      saveEnabled={writeEnabled}
      attachments={{ busy: attachments.busy, failed: attachmentsFailed }}
      {...(mealBridge === undefined
        ? watchBridge === undefined
          ? {}
          : {
              bridgeLabel: savePlanAndAddTitleLabel(
                draft.title.trim() || 'this',
                watchBridge.list.title,
              ),
            }
        : {
            bridgeLabel: savePlanAndAddItemsLabel(
              selectedIngredientIds.length,
              mealBridge.listTitle,
            ),
          })}
      onSave={() => void save()}
      isSaving={
        draft.objectChoice === 'list'
          ? (listWriter?.isCreating ?? false)
          : writer.isSaving
      }
    />
  ) : undefined;

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
        bodyScrollRef={bodyScrollRef}
        alwaysBounceVertical={false}
        {...(footer === undefined ? {} : { footer })}
      >
        <View style={{ gap: theme.space[5] }}>
          {globalInline ? (
            <>
              <Field
                label={globalTitleLabel(draft)}
                value={draft.title}
                onChangeText={draft.setTitle}
                required
                autoFocus
                maxLength={MAX_TITLE_LEN}
                testID="compose-title"
                {...(writer.fieldErrors.title === undefined
                  ? {}
                  : { error: writer.fieldErrors.title })}
              />
              <ObjectChooser
                selected={draft.objectChoice}
                onChoose={chooseObject}
                disabled={!titleReady}
              />
              {draft.objectChoice === 'plan' ? (
                <View
                  collapsable={false}
                  {...(draft.target === undefined ? { ref: revealedSectionRef } : {})}
                >
                  <PlanKindChooser
                    variant="select"
                    {...(draft.target?.objectKind === 'plan'
                      ? { selected: draft.target.type }
                      : {})}
                    onChoose={choosePlanKind}
                  />
                </View>
              ) : null}
              {draft.objectChoice === 'list' ? (
                <View ref={revealedSectionRef} collapsable={false}>
                  <ListStyleChooser
                    selectedKey={draft.listTemplateKey}
                    onChoose={(choice) => draft.chooseListStyle(choice.templateKey)}
                  />
                </View>
              ) : null}
              {draft.objectChoice === 'list' && listWriter?.errorMessage !== undefined ? (
                <View
                  accessibilityRole="alert"
                  accessibilityLiveRegion="polite"
                  testID="compose-error"
                  style={{
                    gap: theme.space[2],
                    padding: theme.space[5],
                    borderRadius: theme.radius.md,
                    backgroundColor: theme.colors.surfaceSunken,
                  }}
                >
                  <Text variant="subhead" color="danger">
                    {listWriter.errorMessage}
                  </Text>
                  {listWriter.errorRequestId === undefined ? null : (
                    <Text variant="footnote" color="textSecondary" selectable>
                      {listWriter.errorRequestId}
                    </Text>
                  )}
                </View>
              ) : null}
            </>
          ) : draft.step === 'planKind' ? (
            <PlanKindChooser onChoose={choosePlanKind} />
          ) : draft.step === 'audience' ? (
            <AudienceChooser onChoose={draft.chooseAudience} />
          ) : null}
          {activityForm &&
          draft.target !== undefined &&
          draft.target.objectKind !== 'listItem' ? (
            <View
              collapsable={false}
              {...(draft.objectChoice === 'task' ||
              (draft.objectChoice === 'plan' && draft.target !== undefined)
                ? { ref: revealedSectionRef }
                : {})}
            >
              <ComposeForm
                target={draft.target}
                fields={{
                  title: draft.title,
                  notes: draft.notes,
                  ...(draft.sourceUrl === undefined
                    ? {}
                    : { sourceUrl: draft.sourceUrl }),
                }}
                titleLabel={titleLabel(draft.target.type)}
                hideTitle={globalInline}
                hideChange={globalInline}
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
                    attachments={attachments}
                    listBridge={{
                      groceriesTitle: groceries.list?.title,
                      groceriesState: groceries.resolution?.kind,
                      watchTitle: watchList.list?.title,
                      watchState: watchList.resolution?.kind,
                      alsoAddToList: draft.alsoAddToList,
                      onAlsoAddToListChange: draft.setAlsoAddToList,
                      onChangeDestination: (slot) => onChooseDestination?.(slot),
                    }}
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
                    fieldErrors={writer.fieldErrors}
                  />
                }
                onTitleChange={draft.setTitle}
                onChangeTarget={() => {
                  draft.back();
                  // In the bridge flow the chooser that produced the target is the kind step,
                  // two steps back — the audience answer between them is dropped on the way
                  // through, so the user re-answers it after re-choosing (P3-34).
                  if (draft.bridge !== undefined) draft.back();
                }}
                errorMessage={writer.errorMessage}
                errorRequestId={writer.errorRequestId}
                fieldErrors={writer.fieldErrors}
              />
            </View>
          ) : null}
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

function globalTitleLabel(draft: {
  objectChoice: ObjectChoice | undefined;
  target: CreationTarget | undefined;
}): string {
  if (draft.objectChoice === 'list') return 'List name';
  if (draft.target !== undefined && draft.target.objectKind !== 'listItem') {
    return titleLabel(draft.target.type);
  }
  return 'What would you like to add?';
}
