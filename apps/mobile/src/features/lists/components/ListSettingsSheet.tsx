import type { DefaultSlot, ItemStateMode, List } from '@od/shared/types';
import {
  Button,
  Field,
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

const SLOTS: readonly DefaultSlot[] = ['groceries', 'watch', 'meals'];
const MODES: readonly ItemStateMode['mode'][] = ['none', 'checkbox', 'stages'];

export function ListSettingsSheet({
  open,
  onClose,
  list,
  settings,
  testID = 'list-settings',
}: ListSettingsSheetProps) {
  const theme = useTheme();
  const [namingOpen, setNamingOpen] = useState(false);
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
  useEffect(() => {
    setSectionLabel(list.featureConfig.subItems?.sectionLabel ?? 'Sub-items');
    setSingularLabel(list.featureConfig.subItems?.singularLabel ?? 'Sub-item');
    setSecondaryLabel(list.featureConfig.subItems?.secondaryLabel ?? '');
  }, [list.featureConfig.subItems]);
  useEffect(() => {
    if (!open) setNamingOpen(false);
  }, [open]);
  const saveNaming = () => {
    settings.setSubItemLabels({
      sectionLabel: sectionLabel.trim() || 'Sub-items',
      singularLabel: singularLabel.trim() || 'Sub-item',
      ...(secondaryLabel.trim() === '' ? {} : { secondaryLabel: secondaryLabel.trim() }),
    });
    setNamingOpen(false);
  };

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (namingOpen) setNamingOpen(false);
        else onClose();
      }}
      title={namingOpen ? 'Sub-item naming' : 'List settings'}
      detent={namingOpen ? 'fit' : 'large'}
      testID={namingOpen ? 'sub-item-naming-sheet' : testID}
    >
      {namingOpen ? (
        <View style={{ gap: theme.space[3] }}>
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
          <Button
            label="Save naming"
            disabled={settings.busy}
            onPress={saveNaming}
            testID="sub-item-naming-save"
          />
        </View>
      ) : (
        <View style={{ gap: theme.space[5] }}>
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
            <View testID="list-settings-stage-options">
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
                if (enabling) setNamingOpen(true);
              }}
              testID="list-settings-feature-sub-items"
            />
            {list.featureConfig.subItems?.enabled !== true ? null : (
              <SettingRow
                label={`${list.featureConfig.subItems.sectionLabel}${list.featureConfig.subItems.secondaryLabel === undefined ? '' : ` · ${list.featureConfig.subItems.secondaryLabel}`}`}
                value="Edit"
                opens
                disabled={settings.busy}
                onPress={() => setNamingOpen(true)}
                testID="list-settings-sub-item-naming"
              />
            )}
          </RowGroup>

          <View style={{ gap: theme.space[2] }}>
            <RowGroup label="Default destination" testID="list-settings-slot">
              {SLOTS.map((slot) => (
                <SettingRow
                  key={slot}
                  label={SLOT_LABELS[slot]}
                  summary={SLOT_MEANINGS[slot]}
                  selected={list.slot === slot}
                  disabled={settings.busy}
                  onPress={() => settings.setSlot(slot)}
                />
              ))}
              <SettingRow
                label={NO_SLOT_LABEL}
                selected={list.slot === null}
                disabled={settings.busy}
                onPress={() => settings.setSlot(null)}
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
