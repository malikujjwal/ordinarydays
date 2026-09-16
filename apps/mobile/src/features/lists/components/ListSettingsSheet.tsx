import type { DefaultSlot, ItemStateMode, List } from '@od/shared/types';
import {
  Button,
  Field,
  GripVertical,
  MoreHorizontal,
  RowGroup,
  SegmentedControl,
  SettingRow,
  Sheet,
  Text,
  useTheme,
} from '@od/ui';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { ListSettings } from '../hooks/useListSettings';
import {
  NO_SLOT_LABEL,
  SELECTABLE_SLOTS,
  SLOT_CLEARS_PROFILE_DEFAULT,
  SLOT_LABELS,
  SLOT_MEANINGS,
  STATE_MODE_LABELS,
  stageMode,
} from '../model/listSettings';

export interface ListSettingsSheetProps {
  open: boolean;
  onClose: () => void;
  list: List;
  settings: ListSettings;
  testID?: string;
}

const MODES: readonly ItemStateMode['mode'][] = ['none', 'checkbox', 'stages'];
type SettingsEditor = 'main' | 'subItems' | 'stages' | 'slot';

export function ListSettingsSheet({
  open,
  onClose,
  list,
  settings,
  testID = 'list-settings',
}: ListSettingsSheetProps) {
  const theme = useTheme();
  const [editor, setEditor] = useState<SettingsEditor>('main');
  const [sectionLabel, setSectionLabel] = useState(
    list.featureConfig.subItems?.sectionLabel ?? 'Sub-items',
  );
  const [singularLabel, setSingularLabel] = useState(
    list.featureConfig.subItems?.singularLabel ?? 'Sub-item',
  );
  const [secondaryLabel, setSecondaryLabel] = useState(
    list.featureConfig.subItems?.secondaryLabel ?? '',
  );

  const stages = list.itemStateMode.mode === 'stages' ? list.itemStateMode : undefined;
  const [stageLabels, setStageLabels] = useState(
    stages?.labels ?? { open: 'Saved', active: 'In progress', done: 'Done' },
  );
  const [selectedSlot, setSelectedSlot] = useState<DefaultSlot | null>(list.slot);
  useEffect(() => {
    setSectionLabel(list.featureConfig.subItems?.sectionLabel ?? 'Sub-items');
    setSingularLabel(list.featureConfig.subItems?.singularLabel ?? 'Sub-item');
    setSecondaryLabel(list.featureConfig.subItems?.secondaryLabel ?? '');
  }, [list.featureConfig.subItems]);
  useEffect(() => {
    if (stages !== undefined) setStageLabels(stages.labels);
  }, [stages]);
  useEffect(() => {
    setSelectedSlot(list.slot);
  }, [list.slot]);
  useEffect(() => {
    if (!open) setEditor('main');
  }, [open]);
  const saveNaming = () => {
    settings.setSubItemLabels({
      sectionLabel: sectionLabel.trim() || 'Sub-items',
      singularLabel: singularLabel.trim() || 'Sub-item',
      ...(secondaryLabel.trim() === '' ? {} : { secondaryLabel: secondaryLabel.trim() }),
    });
    setEditor('main');
  };
  const saveStageLabels = () => {
    if (stages === undefined) return;
    settings.setStateMode({
      ...stages,
      labels: {
        open: stageLabels.open.trim() || stages.labels.open,
        active: stageLabels.active.trim() || stages.labels.active,
        done: stageLabels.done.trim() || stages.labels.done,
      },
    });
  };
  const subItems = list.featureConfig.subItems;
  const mealIntegration = subItems?.integration === 'mealIngredients';
  const sheetTitle =
    editor === 'subItems'
      ? 'Sub-item settings'
      : editor === 'stages'
        ? 'Stage labels'
        : editor === 'slot'
          ? 'Default destination'
          : 'List settings';

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (editor !== 'main') setEditor('main');
        else onClose();
      }}
      title={sheetTitle}
      detent={editor === 'main' ? 'large' : 'fit'}
      testID={editor === 'subItems' ? 'sub-item-settings-sheet' : testID}
      {...(editor === 'subItems'
        ? {
            actions: (
              <Button
                label="Save naming"
                fullWidth
                size="lg"
                disabled={settings.busy}
                onPress={saveNaming}
                testID="sub-item-naming-save"
              />
            ),
          }
        : {})}
    >
      {editor === 'subItems' ? (
        <View style={{ gap: theme.space[4] }}>
          <Text variant="subhead" color="textSecondary">
            Use familiar words for the small list shown inside every item.
          </Text>
          <Field
            label="Section label"
            value={sectionLabel}
            onChangeText={setSectionLabel}
          />
          <Field
            label="Singular label"
            value={singularLabel}
            onChangeText={setSingularLabel}
          />
          <Field
            label="Secondary field label"
            value={secondaryLabel}
            onChangeText={setSecondaryLabel}
          />
          <Text variant="footnote" color="textSecondary">
            {mealIntegration
              ? 'Used as ingredients when creating Meal plans. Labels alone never activate this integration.'
              : 'Generic Sub-items stay inside each List item and do not create another collection.'}
          </Text>
          <View style={{ gap: theme.space[2] }}>
            <Text variant="sectionLabel" color="textSecondary">
              Preview
            </Text>
            <View
              testID="sub-item-settings-preview"
              style={{
                gap: theme.space[2],
                padding: theme.space[4],
                borderRadius: theme.radius.lg,
                backgroundColor: theme.colors.surfaceRaised,
              }}
            >
              <Text variant="sectionLabel" color="textSecondary">
                {sectionLabel.trim() || 'Sub-items'}
              </Text>
              <View
                style={{
                  minHeight: theme.layout.hitTarget,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.space[3],
                }}
              >
                <View aria-hidden>
                  <GripVertical size={18} color={theme.colors.textSecondary} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text variant="bodyStrong">
                    Example {singularLabel.trim() || 'Sub-item'}
                  </Text>
                  {secondaryLabel.trim() === '' ? null : (
                    <Text variant="footnote" color="textSecondary">
                      {secondaryLabel.trim()}
                    </Text>
                  )}
                </View>
                <View aria-hidden>
                  <MoreHorizontal size={18} color={theme.colors.textSecondary} />
                </View>
              </View>
            </View>
          </View>
        </View>
      ) : editor === 'stages' && stages !== undefined ? (
        <View style={{ gap: theme.space[4] }}>
          <Text variant="subhead" color="textSecondary">
            Use short labels that describe the three intrinsic item states.
          </Text>
          <Field
            label="First stage"
            value={stageLabels.open}
            onChangeText={(open) => setStageLabels((current) => ({ ...current, open }))}
            onBlur={saveStageLabels}
          />
          <Field
            label="Active stage"
            value={stageLabels.active}
            onChangeText={(active) =>
              setStageLabels((current) => ({ ...current, active }))
            }
            onBlur={saveStageLabels}
          />
          <Field
            label="Done stage"
            value={stageLabels.done}
            onChangeText={(done) => setStageLabels((current) => ({ ...current, done }))}
            onBlur={saveStageLabels}
          />
        </View>
      ) : editor === 'slot' ? (
        <View style={{ gap: theme.space[4] }}>
          <RowGroup label="Default destination">
            {SELECTABLE_SLOTS.map((slot) => (
              <SettingRow
                key={slot}
                label={SLOT_LABELS[slot]}
                summary={SLOT_MEANINGS[slot]}
                selected={selectedSlot === slot}
                disabled={settings.busy}
                onPress={() => {
                  setSelectedSlot(slot);
                  settings.setSlot(slot);
                }}
              />
            ))}
            <SettingRow
              label={NO_SLOT_LABEL}
              selected={selectedSlot === null}
              disabled={settings.busy}
              onPress={() => {
                setSelectedSlot(null);
                settings.setSlot(null);
              }}
            />
          </RowGroup>
          <Text variant="footnote" color="textSecondary">
            {SLOT_CLEARS_PROFILE_DEFAULT}
          </Text>
        </View>
      ) : (
        <View style={{ gap: theme.space[5] }}>
          <Text variant="subhead" color="textSecondary">
            Choose how items behave and which optional details are available. Existing
            values are kept when a detail is turned off.
          </Text>
          <RowGroup label="Item state" testID="list-settings-item-state">
            <SegmentedControl
              segments={MODES.map((mode) => ({ label: STATE_MODE_LABELS[mode] }))}
              selectedIndex={MODES.indexOf(list.itemStateMode.mode)}
              onChange={(index) => {
                const mode = MODES[index];
                if (mode === undefined || settings.busy) return;
                settings.setStateMode(mode === 'stages' ? stageMode(stages) : { mode });
              }}
              testID="list-settings-state-mode"
            />
          </RowGroup>

          {stages === undefined ? null : (
            <View style={{ gap: theme.space[4] }} testID="list-settings-stage-options">
              <SettingRow
                label="Group by stage"
                summary="Show a section for each populated stage"
                role="switch"
                switchValue={stages.groupByState}
                disabled={settings.busy}
                onPress={() =>
                  settings.setStateMode({ ...stages, groupByState: !stages.groupByState })
                }
                testID="list-settings-group-by-state"
              />
              <SettingRow
                label="Stage labels"
                summary={`${stageLabels.open} · ${stageLabels.active} · ${stageLabels.done}`}
                opens
                disabled={settings.busy}
                onPress={() => setEditor('stages')}
                testID="list-settings-stage-labels"
              />
            </View>
          )}

          <RowGroup label="Item details" testID="list-settings-features">
            <SettingRow
              label="Progress"
              summary="One optional line on each item"
              role="switch"
              switchValue={list.featureConfig.progress?.enabled === true}
              disabled={settings.busy}
              onPress={() =>
                settings.setFeatureEnabled(
                  'progress',
                  list.featureConfig.progress?.enabled !== true,
                )
              }
              testID="list-settings-feature-progress"
            />
            <SettingRow
              label="Places"
              summary="Place and address on each item"
              role="switch"
              switchValue={list.featureConfig.place?.enabled === true}
              disabled={settings.busy}
              onPress={() =>
                settings.setFeatureEnabled(
                  'place',
                  list.featureConfig.place?.enabled !== true,
                )
              }
              testID="list-settings-feature-place"
            />
            <SettingRow
              label="Sub-items"
              summary="Add a short list inside each item"
              role="switch"
              switchValue={list.featureConfig.subItems?.enabled === true}
              disabled={settings.busy}
              onPress={() => {
                const enabling = list.featureConfig.subItems?.enabled !== true;
                settings.setFeatureEnabled('subItems', enabling);
                if (enabling) setEditor('subItems');
              }}
              testID="list-settings-feature-sub-items"
            />
            {list.featureConfig.subItems?.enabled !== true ? null : (
              <SettingRow
                label={`${list.featureConfig.subItems.sectionLabel}${list.featureConfig.subItems.secondaryLabel === undefined ? '' : ` · ${list.featureConfig.subItems.secondaryLabel}`}`}
                value="Edit"
                opens
                disabled={settings.busy}
                onPress={() => setEditor('subItems')}
                testID="list-settings-sub-item-naming"
              />
            )}
          </RowGroup>

          <View style={{ gap: theme.space[2] }}>
            <RowGroup label="Planning" testID="list-settings-slot">
              <SettingRow
                label="Default destination"
                value={selectedSlot === null ? NO_SLOT_LABEL : SLOT_LABELS[selectedSlot]}
                opens
                disabled={settings.busy}
                onPress={() => setEditor('slot')}
              />
            </RowGroup>
            <Text variant="footnote" color="textSecondary">
              {SLOT_CLEARS_PROFILE_DEFAULT}
            </Text>
          </View>
        </View>
      )}
    </Sheet>
  );
}
