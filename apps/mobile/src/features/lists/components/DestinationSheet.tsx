import type { DefaultSlot, List } from '@od/shared/types';
import { Button, RowGroup, SettingRow, Sheet, Text, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { NewListSheet } from '@/features/lists/components/NewListSheet';
import { useDestination } from '@/hooks/useDestination';
import { describeApiFailure } from '@/lib/apiFailure';
import { capabilityFor } from '@/lib/destinationCapability';
import { destinationRememberedMessage, NEW_LIST } from '@/lib/destinationCopy';
import { useToast } from '@/stores/toast';

/**
 * The destination picker behind every add-to flow's `▾` (P3-43; flattened by Option B1,
 * `docs/reports/destination-flow-simplification-20260916.md`):
 *
 * - **One flat list.** Every capable list the viewer holds, in server order — no slot-only
 *   candidate tier, no `Choose another list` escape, because there is nothing left to escape
 *   from: the rows shown are already every list this write could go to.
 * - **No ceremony.** Picking a list is the whole interaction. There is no one-time question
 *   and no `Remember this choice` checkbox; the first pick while no default is stored
 *   silently becomes the default, confirmed with one named, non-blocking toast. A user who
 *   wants a different default from then on changes it from this same picker, or from the
 *   list's own settings (`plans-and-lists.md` §5.5).
 * - **`New list`** opens P3-33's catalogue, limited to the styles capable of this write —
 *   unchanged from `cf71244`.
 *
 * Composed at the routes (features may not import each other); the flows receive the chosen
 * `listId` back and show it before any write.
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

  const rows: readonly List[] = destination.lists;
  const title = rows.length === 0 ? 'Choose or create a list' : 'Choose a list';

  function close() {
    // An ordinary dismissal must not leave a create pending for the next time this opens.
    setCreateRequested(false);
    onClose();
  }

  async function choose(list: List) {
    const shouldRemember = !destination.hasDefault;
    onChoose(list.listId);
    close();
    if (!shouldRemember) return;
    // The pick already stands, one-off, regardless of what follows: a default is a
    // convenience for next time, never a condition of this write.
    try {
      await destination.remember(list.listId);
      useToast
        .getState()
        .show({ message: destinationRememberedMessage(slot, list.title) });
    } catch (error: unknown) {
      const failure = describeApiFailure(error, "Couldn't remember that choice.");
      useToast.getState().show({
        message: failure.message,
        tone: 'error',
        ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
      });
    }
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
              No list is set up for this yet.
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
