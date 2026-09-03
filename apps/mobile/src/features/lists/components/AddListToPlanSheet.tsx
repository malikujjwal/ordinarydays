import type { List } from '@od/shared/types';
import { Button, RowGroup, SettingRow, Sheet, Text, useTheme } from '@od/ui';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useAttachListToPlan } from '../hooks/useAttachListToPlan';
import { useLists } from '../hooks/useLists';
import { NewListSheet } from './NewListSheet';

export interface AddListToPlanSheetProps {
  readonly open: boolean;
  readonly source: { readonly activityId: string; readonly planTitle: string };
  readonly onClose: () => void;
}

type Step = 'start' | 'existing';

function countLabel(list: List): string {
  return `${String(list.itemCount)} ${list.itemCount === 1 ? 'item' : 'items'}`;
}

/**
 * The Plan `Add list` flow. Creation remains the established seven-style flow; this sheet
 * adds the explicit first decision and the attach-only picker for Lists that already exist.
 */
export function AddListToPlanSheet({ open, source, onClose }: AddListToPlanSheetProps) {
  const theme = useTheme();
  const lists = useLists();
  const attach = useAttachListToPlan();
  const [step, setStep] = useState<Step>('start');
  const [selectedId, setSelectedId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const active = lists.lists.filter((list) => !list.archived);
  const selected = active.find((list) => list.listId === selectedId);

  useEffect(() => {
    if (open && step === 'existing' && lists.hasMore && !lists.isLoadingMore) {
      lists.loadMore();
    }
  }, [lists.hasMore, lists.isLoadingMore, lists.loadMore, open, step]);

  function reset() {
    setStep('start');
    setSelectedId(undefined);
    attach.dismissError();
  }

  function close() {
    reset();
    onClose();
  }

  function reason(list: List): string | undefined {
    if (list.sourceActivityId === source.activityId) return 'Already added';
    if (list.sourceActivityId !== undefined) return 'Already connected to a plan';
    if (list.ownerId !== lists.viewerUserId) return 'Only the owner can add this list';
    return undefined;
  }

  async function confirm() {
    if (selected === undefined || reason(selected) !== undefined) return;
    if (await attach.attach(selected, source.activityId)) close();
  }

  return (
    <>
      <Sheet
        open={open && !creating}
        onClose={close}
        title={step === 'start' ? 'Add list' : 'Choose existing list'}
        detent={step === 'start' ? 'fit' : 'large'}
        testID="add-list-to-plan-sheet"
        actions={
          step === 'existing' ? (
            <View style={{ flexDirection: 'row', gap: theme.space[3] }}>
              <Button
                label="Back"
                variant="ghost"
                onPress={() => {
                  setStep('start');
                  setSelectedId(undefined);
                  attach.dismissError();
                }}
              />
              <View style={{ flex: 1 }}>
                <Button
                  label="Add to plan"
                  onPress={() => void confirm()}
                  disabled={selected === undefined}
                  loading={attach.isAttaching}
                  fullWidth
                />
              </View>
            </View>
          ) : undefined
        }
      >
        {attach.errorMessage === undefined ? null : (
          <View accessibilityRole="alert" style={{ gap: theme.space[1] }}>
            <Text variant="footnote" color="danger">
              {attach.errorMessage}
            </Text>
            {attach.errorRequestId === undefined ? null : (
              <Text variant="footnote" color="textSecondary" selectable>
                {attach.errorRequestId}
              </Text>
            )}
          </View>
        )}

        {step === 'start' ? (
          <View style={{ gap: theme.space[4] }}>
            <Text variant="subhead" color="textSecondary">
              For {source.planTitle}
            </Text>
            <RowGroup>
              <SettingRow
                label="Create new list"
                opens
                onPress={() => setCreating(true)}
              />
              <SettingRow
                label="Choose existing list"
                opens
                onPress={() => setStep('existing')}
              />
            </RowGroup>
          </View>
        ) : lists.status === 'pending' && active.length === 0 ? (
          <Text variant="body" color="textSecondary">
            Loading lists…
          </Text>
        ) : lists.status === 'error' && active.length === 0 ? (
          <View style={{ gap: theme.space[3] }}>
            <Text variant="body" color="danger">
              {lists.message ?? "Couldn't load lists."}
            </Text>
            <Button label="Retry" variant="secondary" onPress={lists.refetch} />
          </View>
        ) : active.length === 0 ? (
          <Text variant="body" color="textSecondary">
            No active lists yet.
          </Text>
        ) : (
          <RowGroup>
            {active.map((list) => {
              const disabledReason = reason(list);
              const eligible = disabledReason === undefined;
              return (
                <SettingRow
                  key={list.listId}
                  label={list.title}
                  summary={disabledReason ?? countLabel(list)}
                  accessibilityLabel={`${list.title}. ${disabledReason ?? countLabel(list)}`}
                  {...(eligible ? { selected: list.listId === selectedId } : {})}
                  disabled={!eligible}
                  onPress={eligible ? () => setSelectedId(list.listId) : () => undefined}
                  testID={`plan-list-choice-${list.listId}`}
                />
              );
            })}
          </RowGroup>
        )}
      </Sheet>

      <NewListSheet
        open={creating}
        source={source}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          close();
        }}
      />
    </>
  );
}
