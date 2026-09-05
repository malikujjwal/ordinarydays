import type { AgendaItem } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { agendaRowIntentState } from '@/hooks/pendingIntentState';
import { SwipeableRowWithState } from './SwipeableRow.js';

const gesture = vi.hoisted(() => ({ translation: -400 }));
vi.mock('react-native-reanimated', () => ({
  ReduceMotion: { System: 'system' },
  useSharedValue: (value: boolean) => ({ value }),
  runOnJS: (callback: () => void) => callback,
  useAnimatedReaction: (prepare: () => boolean, react: (value: boolean) => void) =>
    react(prepare()),
}));
vi.mock('react-native-gesture-handler/ReanimatedSwipeable', () => ({
  default: ({
    children,
    renderLeftActions,
    renderRightActions,
  }: {
    children: ReactNode;
    renderLeftActions: (
      progress: object,
      translation: object,
      methods: object,
    ) => ReactNode;
    renderRightActions: (
      progress: object,
      translation: object,
      methods: object,
    ) => ReactNode;
  }) => (
    <>
      {children}
      {renderLeftActions({}, { value: gesture.translation }, { close: () => {} })}
      {renderRightActions({}, { value: gesture.translation }, { close: () => {} })}
    </>
  ),
}));
vi.mock('./AgendaRow', () => ({ AgendaRowWithIntentState: () => null }));

it.each([
  [-400, ['snooze']],
  [400, ['complete']],
  [-100, []],
  [100, []],
] as const)(
  'dispatches only the matching side after a %s point gesture',
  (translation, expected) => {
    gesture.translation = translation;
    const onAction = vi.fn();
    const item: AgendaItem = {
      activityId: 'act_01J8PANA000000000000000000',
      title: 'Daily task',
      type: 'task',
      status: 'scheduled',
      isRecurring: true,
      isSnoozed: false,
      hasCheckbox: true,
      occurrenceDate: '2026-09-04',
      participantAvatars: [],
      participantCount: 0,
      isPast: false,
      capabilities: { complete: true, skip: true, snooze: true },
    };
    render(
      <ThemeProvider>
        <SwipeableRowWithState
          item={item}
          onOpen={() => {}}
          onAction={onAction}
          intentState={agendaRowIntentState([], item.activityId)}
          completion={{ locked: false, checkedOverride: undefined }}
        />
      </ThemeProvider>,
    );
    expect(onAction.mock.calls.map((call) => call[1].name)).toEqual(expected);
  },
);
