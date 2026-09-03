import {
  IconButton,
  MoreHorizontal,
  SectionHeader,
  Text,
  Touchable,
  useTheme,
} from '@od/ui';
import { View } from 'react-native';
import { TabScreen } from '@/components/TabScreen';
import { ListCardGrid } from '@/features/lists/components/ListCardGrid';
import { ListIndexRow } from '@/features/lists/components/ListIndexRow';
import { ListsIndexScroll } from '@/features/lists/components/ListsIndexScroll';
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
  const lists = [...PRESET_LISTS, ...generic];
  return (
    <TabScreen
      title="Lists"
      caption={`${String(lists.length)} LISTS`}
      testID="lists-contract-overview"
      bleedBody
      headerAction={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}>
          <Touchable
            accessibilityRole="button"
            accessibilityLabel="New list"
            onPress={() => {}}
          >
            <Text variant="footnoteStrong" color="textAction">
              + New list
            </Text>
          </Touchable>
          <IconButton icon={MoreHorizontal} label="More" onPress={() => {}} />
        </View>
      }
    >
      <ListsIndexScroll>
        <View style={{ marginTop: theme.space[8] }}>
          <SectionHeader title="Recent" count={lists.length} variant="sectionLabel" />
          <ListCardGrid>
            {lists.map((list) => (
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
        </View>
      </ListsIndexScroll>
    </TabScreen>
  );
}
