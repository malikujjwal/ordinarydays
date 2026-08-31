import type {
  DefaultSlot,
  ItemStateMode,
  ListFeatureConfig,
  ProgressFeatureConfig,
  SubItemsFeatureConfig,
} from '@od/shared/types';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { ListSettingsSheet } from '@/features/lists/components/ListSettingsSheet';
import type { ListSettings } from '@/features/lists/hooks/useListSettings';
import { SETTINGS_LIST } from './fixtures';

/** Stateful production settings sheet used by the contract gallery. */
export function SettingsFixture() {
  const [list, setList] = useState(SETTINGS_LIST);
  const settings = useMemo<ListSettings>(
    () => ({
      view: list,
      rename: (title: string) => setList((current) => ({ ...current, title })),
      setStateMode: (itemStateMode: ItemStateMode) =>
        setList((current) => ({ ...current, itemStateMode })),
      setFeatureEnabled: (feature: keyof ListFeatureConfig, enabled: boolean) =>
        setList((current) => {
          const previous = current.featureConfig[feature];
          const next =
            feature === 'progress'
              ? { ...(previous ?? { kind: 'text' }), enabled }
              : feature === 'place'
                ? { enabled }
                : {
                    ...(previous ?? {
                      sectionLabel: 'Sub-items',
                      singularLabel: 'Sub-item',
                    }),
                    enabled,
                  };
          return {
            ...current,
            featureConfig: { ...current.featureConfig, [feature]: next },
          };
        }),
      setProgressKind: (kind: ProgressFeatureConfig['kind']) =>
        setList((current) => ({
          ...current,
          featureConfig: { ...current.featureConfig, progress: { enabled: true, kind } },
        })),
      setSubItemLabels: (
        labels: Pick<
          SubItemsFeatureConfig,
          'sectionLabel' | 'singularLabel' | 'secondaryLabel'
        >,
      ) =>
        setList((current) => ({
          ...current,
          featureConfig: {
            ...current.featureConfig,
            subItems: {
              ...(current.featureConfig.subItems ?? {
                enabled: true,
                sectionLabel: 'Sub-items',
                singularLabel: 'Sub-item',
              }),
              ...labels,
            },
          },
        })),
      setSlot: (slot: DefaultSlot | null) => setList((current) => ({ ...current, slot })),
      busy: false,
    }),
    [list],
  );

  return (
    <View style={{ flex: 1 }}>
      <ListSettingsSheet open onClose={() => {}} list={list} settings={settings} />
    </View>
  );
}
