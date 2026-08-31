import {
  EmptyState,
  IconButton,
  MoreHorizontal,
  SectionHeader,
  Skeleton,
  Text,
  Touchable,
  useTheme,
} from '@od/ui';
import { View } from 'react-native';
import { TabScreen } from '@/components/TabScreen';
import { ListCardGrid } from '@/features/lists/components/ListCardGrid';
import { ListsIndexScroll } from '@/features/lists/components/ListsIndexScroll';
import { SwipeableListCard } from '@/features/lists/components/SwipeableListCard';
import { LIST_ID, NOW, PRESET_LISTS, preset, STAGED_LIST, TIMEZONE } from './fixtures';

export interface IndexChromeFixtureProps {
  state: 'populated' | 'empty' | 'loading';
}

/** Production Lists tab chrome with bounded active, archived, loading and empty states. */
export function IndexChromeFixture({ state }: IndexChromeFixtureProps) {
  const theme = useTheme();
  const active = [
    ...PRESET_LISTS,
    { ...STAGED_LIST, title: 'Workshop materials' },
    { ...STAGED_LIST, listId: `${LIST_ID.slice(0, -1)}8`, title: 'Road trip stops' },
  ];
  const archived = {
    ...preset(2),
    listId: `${LIST_ID.slice(0, -1)}9`,
    title: 'Archived reading list',
    archived: true,
  };

  return (
    <TabScreen
      title="Lists"
      testID="lists-contract-tab"
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
      <ListsIndexScroll testID="lists-contract-index-scroll">
        {state === 'loading' ? (
          <View testID="lists-contract-loading" style={{ paddingTop: theme.space[5] }}>
            <Skeleton shape="row" count={5} />
          </View>
        ) : state === 'empty' ? (
          <EmptyState
            heading="No lists yet"
            body="Keep things you want to remember, track, or organise together."
            action={{ label: 'New list', onPress: () => {} }}
          />
        ) : (
          <View style={{ gap: theme.space[6] }}>
            <ListCardGrid>
              {active.map((list) => (
                <SwipeableListCard
                  key={list.listId}
                  list={list}
                  now={NOW}
                  timezone={TIMEZONE}
                  onPress={() => {}}
                  actions={[]}
                  onAction={() => {}}
                />
              ))}
            </ListCardGrid>
            <View style={{ gap: theme.space[2] }}>
              <SectionHeader title="Archived" count={1} />
              <ListCardGrid>
                <View>
                  <SwipeableListCard
                    list={archived}
                    now={NOW}
                    timezone={TIMEZONE}
                    onPress={() => {}}
                    dimmed
                    actions={[]}
                    onAction={() => {}}
                  />
                  <Touchable
                    accessibilityRole="button"
                    accessibilityLabel="Restore Archived reading list"
                    onPress={() => {}}
                    style={{ paddingHorizontal: theme.space[4] }}
                  >
                    <Text variant="footnoteStrong" color="textAction">
                      Restore
                    </Text>
                  </Touchable>
                </View>
              </ListCardGrid>
            </View>
          </View>
        )}
      </ListsIndexScroll>
    </TabScreen>
  );
}
