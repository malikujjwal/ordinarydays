import type { ActivityListItem } from '@od/shared/types';
import { Chip, EmptyState, Repeat, Row, Skeleton, useTheme } from '@od/ui';
import { FlatList, View } from 'react-native';
import { TabScreen } from '@/components/TabScreen';
import { usePlans } from '@/features/plans/hooks/usePlans';
import { rowLabel, rowState, rowSubtitle } from '@/features/plans/model/rows';

/**
 * The Plans tab: the flat activity list from P1-16 (P1-23).
 *
 * `upcoming` — one GSI1 bucket, date ascending — because that is the stage a flat list can
 * honestly be. The three-stage tab with its `Needs a date · Upcoming · Past` switcher is
 * `GET /v1/plans` and Phase 3 (P3-14), and building a switcher over three separate flat calls
 * now would be that screen with a worse data source.
 *
 * All four states from `interaction-contract.md` §5 are here: skeleton rows on first load,
 * §5.2's empty copy, §5.3's screen-level failure with `Try again`, and the foot skeleton while
 * a further page is fetched. Rows obey U1 — tapping one opens its detail and mutates nothing.
 */
export interface PlansScreenProps {
  onOpen: (activityId: string) => void;
  /** The global Add action. The empty state's own action is this one (§5.2). */
  onAdd: () => void;
}

export function PlansScreen({ onOpen, onAdd }: PlansScreenProps) {
  const theme = useTheme();
  const plans = usePlans('upcoming');

  return (
    <TabScreen title="Plans" testID="plans-screen">
      {plans.status === 'pending' ? (
        // Skeleton rows matching the real layout's shape and count, no spinner (§5.1).
        <View testID="plans-loading">
          <Skeleton shape="row" count={5} />
        </View>
      ) : plans.status === 'error' ? (
        <View testID="plans-error">
          <EmptyState
            heading={plans.message ?? "Couldn't load this."}
            {...(plans.requestId === undefined ? {} : { body: plans.requestId })}
            action={{ label: 'Try again', onPress: plans.refetch }}
          />
        </View>
      ) : plans.items.length === 0 ? (
        <View testID="plans-empty">
          {/* §5.2, verbatim. `Add` is the global Add action — the screen an empty state sits
              on does not choose the object. */}
          <EmptyState
            heading="No upcoming plans"
            body="Anything with a date shows up here."
            action={{ label: 'Add', onPress: onAdd }}
          />
        </View>
      ) : (
        <FlatList
          testID="plans-list"
          data={plans.items}
          keyExtractor={(item: ActivityListItem) => item.activityId}
          initialNumToRender={12}
          windowSize={7}
          // Auto-fetch at 80 % scroll depth (§5.1).
          onEndReachedThreshold={0.2}
          onEndReached={plans.loadMore}
          renderItem={({ item }: { item: ActivityListItem }) => {
            const state = rowState(item);
            const subtitle = rowSubtitle(item);

            return (
              <Row
                title={item.title}
                {...(subtitle === undefined ? {} : { subtitle })}
                accent={item.type}
                dimmed={state.dimmed}
                struck={state.struck}
                accessibilityLabel={rowLabel(item)}
                onPress={() => onOpen(item.activityId)}
                {...(item.isRecurring
                  ? {
                      trailing: (
                        <Chip label="Repeats" icon={Repeat} testID="row-repeats" />
                      ),
                    }
                  : {})}
              />
            );
          }}
          ListFooterComponent={
            plans.isLoadingMore ? (
              // A single skeleton row at the list's foot (§5.1).
              <View testID="plans-loading-more" style={{ paddingTop: theme.space[3] }}>
                <Skeleton shape="row" count={1} />
              </View>
            ) : null
          }
        />
      )}
    </TabScreen>
  );
}
