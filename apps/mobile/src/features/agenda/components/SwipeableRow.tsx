import { Text, Touchable, useMotion, useTheme } from '@od/ui';
import { useCallback } from 'react';
import { View } from 'react-native';
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import {
  ReduceMotion,
  runOnJS,
  type SharedValue,
  useAnimatedReaction,
  useSharedValue,
} from 'react-native-reanimated';
import {
  type CompletionCommitState,
  useCompletionCommitState,
} from '@/features/agenda/hooks/useCompletionCommitLock';
import {
  type AgendaSwipeAction,
  agendaAccessibilityActions,
  agendaSwipeActions,
  allAgendaSwipeActions,
} from '@/features/agenda/model/swipeActions';
import {
  type AgendaRowIntentState,
  useAgendaRowIntentState,
} from '@/hooks/usePendingIntents';
import { type AgendaRowProps, AgendaRowWithIntentState } from './AgendaRow';

const ACTION_WIDTH = 88;
const FULL_SWIPE_OVERSHOOT = 72;

export interface SwipeableRowProps extends AgendaRowProps {
  onAction?: (item: AgendaRowProps['item'], action: AgendaSwipeAction) => void;
}

export interface SwipeableRowWithStateProps extends SwipeableRowProps {
  intentState: AgendaRowIntentState;
  completion: CompletionCommitState;
}

interface ActionPanelProps {
  actions: AgendaSwipeAction[];
  translation: SharedValue<number>;
  methods: SwipeableMethods;
  side: 'positive' | 'secondary';
  onAction: (action: AgendaSwipeAction) => void;
}

function ActionPanel({
  actions,
  translation,
  methods,
  side,
  onAction,
}: ActionPanelProps) {
  const theme = useTheme();
  const fullSwipeArmed = useSharedValue(false);
  const first = actions[0];
  const mayCommitFull = first !== undefined && !first.destructive;
  const fullSwipeDistance = actions.length * ACTION_WIDTH + FULL_SWIPE_OVERSHOOT;

  const commit = useCallback(
    (selected: AgendaSwipeAction) => {
      methods.close();
      onAction(selected);
    },
    [methods, onAction],
  );

  useAnimatedReaction(
    () =>
      mayCommitFull &&
      (side === 'positive' ? translation.value : -translation.value) >= fullSwipeDistance,
    (pastThreshold) => {
      if (pastThreshold && !fullSwipeArmed.value && first !== undefined) {
        fullSwipeArmed.value = true;
        runOnJS(commit)(first);
      } else if (!pastThreshold) {
        fullSwipeArmed.value = false;
      }
    },
    [commit, first, fullSwipeDistance, mayCommitFull],
  );

  return (
    <View
      style={{
        minHeight: '100%',
        flexDirection: side === 'secondary' ? 'row-reverse' : 'row',
        alignItems: 'stretch',
      }}
    >
      {actions.map((selected) => (
        <Touchable
          key={selected.name}
          accessibilityRole="button"
          accessibilityLabel={selected.label}
          onPress={() => commit(selected)}
          testID={`agenda-swipe-${selected.name}`}
          style={{
            width: ACTION_WIDTH,
            minHeight: theme.layout.rowMinHeight,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: theme.space[2],
            backgroundColor: selected.destructive
              ? theme.colors.danger
              : side === 'positive'
                ? theme.colors.success
                : theme.colors.accentDeep,
          }}
        >
          <Text variant="footnoteStrong" color="inverse" align="center">
            {selected.label}
          </Text>
        </Touchable>
      ))}
    </View>
  );
}

/** Native agenda gestures. The web-equivalent controls live in SwipeableRow.web.tsx. */
export function SwipeableRow({ item, onAction, ...rowProps }: SwipeableRowProps) {
  const intentState = useAgendaRowIntentState(item.activityId, item.occurrenceDate);
  const completion = useCompletionCommitState(
    item,
    intentState.failedCompletionIntentIds,
  );
  return (
    <SwipeableRowWithState
      {...rowProps}
      item={item}
      {...(onAction === undefined ? {} : { onAction })}
      intentState={intentState}
      completion={completion}
    />
  );
}

/** Gesture presentation for a parent that already owns this row's keyed state. */
export function SwipeableRowWithState({
  item,
  onAction,
  intentState,
  completion,
  ...rowProps
}: SwipeableRowWithStateProps) {
  const motion = useMotion();
  const { mutationInert: inert } = intentState;
  const completionLocked = rowProps.completionLocked ?? completion.locked;
  const actions =
    inert || completionLocked
      ? { positive: [] as AgendaSwipeAction[], secondary: [] as AgendaSwipeAction[] }
      : agendaSwipeActions(item);
  const accessibilityActions = agendaAccessibilityActions(actions);
  const dispatch = useCallback(
    (selected: AgendaSwipeAction) => onAction?.(item, selected),
    [item, onAction],
  );

  return (
    <ReanimatedSwipeable
      enabled={!inert && !completionLocked}
      testID={`swipeable-row-${item.activityId}`}
      friction={1}
      overshootFriction={1}
      overshootLeft={actions.positive[0]?.destructive === false}
      overshootRight={actions.secondary[0]?.destructive === false}
      animationOptions={{ ...motion.spring, reduceMotion: ReduceMotion.System }}
      {...(actions.positive.length === 0
        ? {}
        : {
            renderLeftActions: (
              _progress: SharedValue<number>,
              translation: SharedValue<number>,
              methods: SwipeableMethods,
            ) => (
              <ActionPanel
                actions={actions.positive}
                translation={translation}
                methods={methods}
                side="positive"
                onAction={dispatch}
              />
            ),
          })}
      {...(actions.secondary.length === 0
        ? {}
        : {
            renderRightActions: (
              _progress: SharedValue<number>,
              translation: SharedValue<number>,
              methods: SwipeableMethods,
            ) => (
              <ActionPanel
                actions={actions.secondary}
                translation={translation}
                methods={methods}
                side="secondary"
                onAction={dispatch}
              />
            ),
          })}
    >
      <AgendaRowWithIntentState
        {...rowProps}
        item={item}
        completionLocked={completionLocked}
        {...(completion.checkedOverride === undefined
          ? {}
          : { completionCheckedOverride: completion.checkedOverride })}
        intentState={intentState}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={({ nativeEvent }) => {
          const selected = allAgendaSwipeActions(actions).find(
            ({ name }) => name === nativeEvent.actionName,
          );
          if (selected !== undefined) dispatch(selected);
        }}
      />
    </ReanimatedSwipeable>
  );
}
