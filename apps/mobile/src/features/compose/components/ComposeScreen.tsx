import { Button, Close, IconButton, useTheme } from '@od/ui';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ComposeForm } from '@/features/compose/components/ComposeForm';
import { DiscardPrompt } from '@/features/compose/components/DiscardPrompt';
import { ListItemPlaceholder } from '@/features/compose/components/ListItemPlaceholder';
import { ObjectChooser } from '@/features/compose/components/ObjectChooser';
import { PlanKindChooser } from '@/features/compose/components/PlanKindChooser';
import { TypedFields } from '@/features/compose/forms/TypedFields';
import { useCreateActivity } from '@/features/compose/hooks/useCreateActivity';
import { outingLocationLabel } from '@/features/compose/model/fields';
import { canSave, successToast } from '@/features/compose/model/targets';
import { hasContent, useComposeDraft } from '@/stores/composeDraft';
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
}

export function ComposeScreen({ onClose, today, timezone }: ComposeScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const draft = useComposeDraft();
  const showToast = useToast((s) => s.show);
  const create = useCreateActivity();
  const [discardOpen, setDiscardOpen] = useState(false);

  /**
   * An Outing's `Location` **pre-fills** from Place, and only pre-fills (`activities.md` §4.5).
   *
   * `details.placeName` is the other half of that rule and needs nothing here: it is derived
   * from the title at submit time, so the two are identical by construction rather than by two
   * setters agreeing. The label is different — once the user has typed one of their own, the
   * Place stops overwriting it, because a venue and its address line are not always the same
   * words.
   */
  function setTitleAndMirror(next: string) {
    if (draft.target?.objectKind === 'plan' && draft.target.type === 'outing') {
      draft.setLocation({
        label: outingLocationLabel(next, draft.location.label, draft.title),
      });
    }
    draft.setTitle(next);
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
        details: draft.details,
      },
      timezone,
    );
    if (saved === undefined) return; // The banner is already showing; the draft stays put.

    // §2.5's order: the form dismisses, then the toast names where it landed.
    draft.reset();
    onClose();
    showToast({ message: successToast(target, draft.schedule, today) });
  }

  const showBack = draft.step !== 'object';

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: insets.top + theme.space[3],
          paddingHorizontal: theme.space[5],
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

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: theme.space[5],
          paddingBottom: insets.bottom + theme.space[8],
          gap: theme.space[5],
        }}
      >
        {draft.step === 'object' ? (
          <ObjectChooser onChoose={draft.chooseObject} />
        ) : draft.step === 'planKind' ? (
          <PlanKindChooser onChoose={draft.choosePlanKind} />
        ) : draft.target === undefined || draft.target.objectKind === 'listItem' ? (
          // `form` with no Activity target is reachable by exactly one route: `List item`,
          // which has no destination to fix in Phase 1. The store leaves `target` undefined
          // there; the `listItem` arm is named as well so the narrowing below is the
          // compiler's rather than a comment's.
          <ListItemPlaceholder onBack={() => draft.back()} />
        ) : (
          <ComposeForm
            target={draft.target}
            fields={{
              title: draft.title,
              notes: draft.notes,
              ...(draft.sourceUrl === undefined ? {} : { sourceUrl: draft.sourceUrl }),
            }}
            saveEnabled={canSave({ title: draft.title, notes: draft.notes })}
            typedFields={
              <TypedFields
                type={draft.target.type}
                title={draft.title}
                schedule={draft.schedule}
                location={draft.location}
                reminderOffset={draft.reminderOffset}
                details={draft.details}
                notes={draft.notes}
                today={today}
                onDateChange={draft.setDate}
                onTimeChange={draft.setTime}
                onSlotTimeChange={draft.setTimeFromSlot}
                onEndTimeChange={draft.setEndTime}
                onLocationChange={draft.setLocation}
                onReminderChange={draft.setReminderOffset}
                onDetailsChange={draft.setDetails}
                onNotesChange={draft.setNotes}
                fieldErrors={create.fieldErrors}
              />
            }
            attachmentUri={draft.attachmentUri}
            onTitleChange={setTitleAndMirror}
            onSourceUrlChange={draft.setSourceUrl}
            onAttach={draft.attachImage}
            onClearAttachment={draft.clearAttachment}
            onChangeTarget={() => draft.back()}
            onSave={() => void save()}
            isSaving={create.isSaving}
            errorMessage={create.errorMessage}
            errorRequestId={create.errorRequestId}
            fieldErrors={create.fieldErrors}
          />
        )}
      </ScrollView>

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
