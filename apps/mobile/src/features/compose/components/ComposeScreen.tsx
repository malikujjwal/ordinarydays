import { Button, Close, IconButton, useTheme } from '@od/ui';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ComposeForm } from '@/features/compose/components/ComposeForm';
import { DiscardPrompt } from '@/features/compose/components/DiscardPrompt';
import { ListItemPlaceholder } from '@/features/compose/components/ListItemPlaceholder';
import { ObjectChooser } from '@/features/compose/components/ObjectChooser';
import { PlanKindChooser } from '@/features/compose/components/PlanKindChooser';
import { useCreateActivity } from '@/features/compose/hooks/useCreateActivity';
import { successToast } from '@/features/compose/model/targets';
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
}

export function ComposeScreen({ onClose }: ComposeScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const draft = useComposeDraft();
  const showToast = useToast((s) => s.show);
  const create = useCreateActivity();
  const [discardOpen, setDiscardOpen] = useState(false);

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
    const saved = await create.save(target, {
      title: draft.title,
      notes: draft.notes,
      ...(draft.sourceUrl === undefined ? {} : { sourceUrl: draft.sourceUrl }),
    });
    if (saved === undefined) return; // The banner is already showing; the draft stays put.

    // §2.5's order: the form dismisses, then the toast names where it landed.
    draft.reset();
    onClose();
    showToast({ message: successToast(target) });
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
        {showBack ? (
          <Button
            label="Back"
            variant="ghost"
            onPress={() => draft.back()}
            testID="compose-back"
          />
        ) : (
          <Button
            label="Cancel"
            variant="ghost"
            onPress={requestClose}
            testID="compose-cancel"
          />
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
        ) : draft.target === undefined ? (
          // `form` with no target is reachable by exactly one route: `List item`, which has
          // no destination to fix in Phase 1.
          <ListItemPlaceholder onBack={() => draft.back()} />
        ) : (
          <ComposeForm
            target={draft.target}
            fields={{
              title: draft.title,
              notes: draft.notes,
              ...(draft.sourceUrl === undefined ? {} : { sourceUrl: draft.sourceUrl }),
            }}
            attachmentUri={draft.attachmentUri}
            onTitleChange={draft.setTitle}
            onNotesChange={draft.setNotes}
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
