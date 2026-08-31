import { ScreenShell, Text, useTheme } from '@od/ui';
import { ScrollView, View } from 'react-native';
import { ListCardGrid } from '@/features/lists/components/ListCardGrid';
import { ListIndexRow } from '@/features/lists/components/ListIndexRow';
import { LIST_ID, NOW, PRESET_LISTS, STAGED_LIST, TIMEZONE } from './fixtures';

/** Coloured index collection used by the production visual gallery. */
export function OverviewFixture() {
  const theme = useTheme();
  const generic = [
    {
      ...STAGED_LIST,
      listId: `${LIST_ID.slice(0, -1)}7`,
      title: 'Workshop materials',
    },
    {
      ...STAGED_LIST,
      title: 'Road trip stops',
      featureConfig: {
        subItems: {
          enabled: true,
          sectionLabel: 'Stops',
          singularLabel: 'Stop',
          secondaryLabel: 'Duration',
        },
      },
    },
  ];
  return (
    <ScreenShell measure="standard">
      <ScrollView
        contentContainerStyle={{ gap: theme.space[6], paddingBottom: theme.space[10] }}
      >
        <Text variant="title">Lists contract gallery</Text>
        <ListCardGrid>
          {[...PRESET_LISTS, ...generic].map((list) => (
            <View key={list.title}>
              <ListIndexRow
                list={list}
                now={NOW}
                timezone={TIMEZONE}
                onPress={() => {}}
              />
            </View>
          ))}
        </ListCardGrid>
      </ScrollView>
    </ScreenShell>
  );
}
