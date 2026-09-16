import type { DefaultSlot, List } from '@od/shared/types';
import { Button, RowGroup, SettingRow, Sheet, Text, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { NewListSheet } from '@/features/lists/components/NewListSheet';
import { useDestination } from '@/hooks/useDestination';
import { describeApiFailure } from '@/lib/apiFailure';
import { capabilityFor } from '@/lib/destinationCapability';
import {
  CHOOSE_ANOTHER_LIST,
  destinationQuestion,
  NEW_LIST,
  REMEMBER_THIS_CHOICE,
} from '@/lib/destinationCopy';
import { useToast } from '@/stores/toast';

/**
 * The destination picker behind every add-to flow's `▾` (P3-43, `plans-and-lists.md`
 * §5.8, P3-12's four-step rule):
 *
 * - **`ask`** — several eligible lists and no default: the picker opens listing them with
 *   `Remember this choice` **checked by default**; unchecking makes the choice one-off. A
 *   user with two grocery lists is asked once, which is the point of storing the answer.
 * - **`use`** — a one-off change from the row's `▾`: the same rows, **no `Remember`
 *   control at all** — changing the destination from the `use` case never writes the
 *   default.
 * - **`none`** — `New list` opens P3-33's seven-type catalogue with nothing selected (or,
 *   for the Watch destination, the one `Watch Later` type, still unselected). After
 *   `Create list` the caller's flow returns with the new list named and still requires
 *   its own named confirmation — creating the destination never also adds anything.
 *
 * `Choose another list` escapes to every capable list in the index: a user may put
 * ingredients in a checkbox list that is not marked as a groceries destination, but can
 * never choose a list the API would refuse. Composed at the routes (features may not import
 * each other); the flows receive the chosen `listId` back and show it before any write.
 */
export interface DestinationSheetProps {
  open: boolean;
  slot: DefaultSlot;
  /** This operation's current one-off choice, if any. */
  current: string | undefined;
  onChoose: (listId: string) => void;
  onClose: () => void;
  testID?: string;
}

export function DestinationSheet({
  open,
  slot,
  current,
  onChoose,
  onClose,
  testID = 'destination-sheet',
}: DestinationSheetProps) {
  const theme = useTheme();
  const destination = useDestination(slot, current);
  const templatePredicate = capabilityFor(slot);
  const [remember, setRemember] = useState(true);
  const [showAll, setShowAll] = useState(false);
  /**
   * `New list` is a **request**, not the open itself.
   *
   * `Sheet` keeps its modal mounted through the exit animation (it is the only state in which
   * the modal unmounts), so opening the create sheet the moment the button is tapped mounts a
   * second modal over one that is still leaving — which is invisible and swallows every tap.
   * The request closes this sheet; `onClosed` — the signal that the exit finished and the modal
   * unmounted — is what opens the child. Same shape as `AddListToPlanSheet`.
   */
  const [createRequested, setCreateRequested] = useState(false);
  const [creating, setCreating] = useState(false);

  const asking = destination.resolution?.kind === 'ask' && current === undefined;
  const none = destination.resolution?.kind === 'none';
  const rows: readonly List[] = showAll ? destination.all : destination.candidates;
  const title = asking
    ? destinationQuestion(slot)
    : none && !showAll
      ? 'Choose or create a list'
      : 'Choose a list';

  function close() {
    setShowAll(false);
    setRemember(true);
    // An ordinary dismissal must not leave a create pending for the next time this opens.
    setCreateRequested(false);
    onClose();
  }

  async function choose(list: List) {
    // Remembering is the one profile write here, and only the `ask` case offers it. It is
    // secondary to the choice: a failed default leaves the choice standing, one-off, and says so.
    if (asking && remember) {
      try {
        await destination.remember(list.listId);
      } catch (error: unknown) {
        const failure = describeApiFailure(error, "Couldn't remember that choice.");
        useToast.getState().show({
          message: failure.message,
          tone: 'error',
          ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
        });
      }
    }
    onChoose(list.listId);
    close();
  }

  return (
    <>
      <Sheet
        open={open && !createRequested && !creating}
        onClose={close}
        onClosed={() => {
          if (!createRequested) return;
          setCreateRequested(false);
          setCreating(true);
        }}
        title={title}
        detent="medium"
        testID={testID}
        actions={
          <Button
            label={NEW_LIST}
            variant="secondary"
            fullWidth
            onPress={() => setCreateRequested(true)}
            testID={`${testID}-new-list`}
          />
        }
      >
        <View style={{ gap: theme.space[4] }}>
          {rows.length === 0 ? (
            <Text variant="body" color="textSecondary" testID={`${testID}-empty`}>
              {showAll ? 'No lists yet.' : 'No list is set up for this yet.'}
            </Text>
          ) : (
            <RowGroup>
              {rows.map((list) => (
                <SettingRow
                  key={list.listId}
                  label={list.title}
                  selected={list.listId === (current ?? destination.list?.listId)}
                  onPress={() => void choose(list)}
                  testID={`${testID}-list-${list.listId}`}
                />
              ))}
            </RowGroup>
          )}

          {asking ? (
            <SettingRow
              label={REMEMBER_THIS_CHOICE}
              role="checkbox"
              selected={remember}
              onPress={() => setRemember((value) => !value)}
              testID={`${testID}-remember`}
            />
          ) : null}

          {showAll || destination.all.length === destination.candidates.length ? null : (
            <Button
              label={CHOOSE_ANOTHER_LIST}
              variant="ghost"
              onPress={() => setShowAll(true)}
              testID={`${testID}-choose-another`}
            />
          )}
        </View>
      </Sheet>
      <NewListSheet
        open={creating}
        {...(slot === 'watch' ? { constrainTo: 'watch-later' as const } : {})}
        {...(templatePredicate === undefined ? {} : { templatePredicate })}
        onClose={() => setCreating(false)}
        onCreated={({ listId }) => {
          // The new list is this operation's destination; nothing is added to it here.
          setCreating(false);
          onChoose(listId);
          close();
        }}
      />
    </>
  );
}
