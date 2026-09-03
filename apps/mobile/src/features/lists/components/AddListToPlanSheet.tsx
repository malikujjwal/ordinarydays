import {
  Button,
  RowGroup,
  SettingRow,
  Sheet,
  type SheetVirtualizedBodyProps,
  Text,
  useTheme,
} from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { useAttachListToPlan } from '../hooks/useAttachListToPlan';
import { useLists } from '../hooks/useLists';
import { ExistingListPicker, listAttachDisabledReason } from './ExistingListPicker';
import { NewListSheet } from './NewListSheet';

export interface AddListToPlanSheetProps {
  readonly open: boolean;
  readonly source: { readonly activityId: string; readonly planTitle: string };
  readonly onClose: () => void;
}

type Step = 'start' | 'existing';

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
  const [createRequested, setCreateRequested] = useState(false);
  const [creating, setCreating] = useState(false);
  const active = lists.lists.filter((list) => !list.archived);
  const selected = active.find((list) => list.listId === selectedId);
  const selectedIsEligible =
    selected !== undefined &&
    listAttachDisabledReason(selected, source.activityId, lists.viewerUserId) ===
      undefined;

  function reset() {
    setStep('start');
    setSelectedId(undefined);
    setCreateRequested(false);
    attach.dismissError();
  }

  function close() {
    reset();
    onClose();
  }

  async function confirm() {
    if (selected === undefined || !selectedIsEligible) return;
    if (await attach.attach(selected, source.activityId)) close();
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
        title={step === 'start' ? 'Add list' : 'Choose existing list'}
        detent={step === 'start' ? 'fit' : 'large'}
        testID="add-list-to-plan-sheet"
        {...(step === 'existing'
          ? {
              virtualizedBody: (sheetScroll: SheetVirtualizedBodyProps) => (
                <ExistingListPicker
                  lists={lists}
                  active={active}
                  sourceActivityId={source.activityId}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  attachError={attach.errorMessage}
                  attachRequestId={attach.errorRequestId}
                  sheetScroll={sheetScroll}
                />
              ),
            }
          : {
              children: (
                <View style={{ gap: theme.space[4] }}>
                  <Text variant="subhead" color="textSecondary">
                    For {source.planTitle}
                  </Text>
                  <RowGroup>
                    <SettingRow
                      label="Create new list"
                      opens
                      onPress={() => setCreateRequested(true)}
                    />
                    <SettingRow
                      label="Choose existing list"
                      opens
                      onPress={() => setStep('existing')}
                    />
                  </RowGroup>
                </View>
              ),
            })}
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
                  disabled={!selectedIsEligible}
                  loading={attach.isAttaching}
                  fullWidth
                />
              </View>
            </View>
          ) : undefined
        }
      />

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
