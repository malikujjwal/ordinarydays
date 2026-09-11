import type { Reminder } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WhenWhereBlock } from './WhenWhereBlock';

/**
 * React Native Web drops `hitSlop` before the DOM, so the props each `Pressable` is handed are
 * recorded at the component boundary, and `Platform.OS` is steerable per test.
 */
const rn = vi.hoisted(() => ({
  os: 'ios' as string,
  pressables: new Map<string, Record<string, unknown>>(),
}));
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>();
  const { createElement, forwardRef } = await import('react');
  const Pressable = forwardRef<unknown, Record<string, unknown>>((props, ref) => {
    if (typeof props.testID === 'string') rn.pressables.set(props.testID, props);
    return createElement(actual.Pressable as React.ElementType, { ...props, ref });
  });
  const Platform = {
    ...actual.Platform,
    get OS() {
      return rn.os;
    },
  };
  return { ...actual, Platform, Pressable };
});

beforeEach(() => {
  rn.pressables.clear();
});

function block(props: Partial<Parameters<typeof WhenWhereBlock>[0]> = {}) {
  return render(
    <ThemeProvider scheme="light">
      <WhenWhereBlock
        schedule={{ date: '2026-09-12', time: '12:30' }}
        location={{ label: 'Noble Rot' }}
        reminders={[]}
        today="2026-09-11"
        onPressDate={() => undefined}
        onPressAddress={() => undefined}
        {...props}
      />
    </ThemeProvider>,
  );
}

const slop = (testID: string) => rn.pressables.get(testID)?.hitSlop;

describe('WhenWhereBlock targets (device report, 2026-09-11)', () => {
  it('on native, sizes rows to their text and makes 44 pt up with hitSlop', () => {
    rn.os = 'ios';
    block();
    // Date: 21 line + 2 inset + 1 underline = 24, so 10 above and below.
    expect(slop('when-where-date')).toEqual({ top: 10, bottom: 10 });
    // Place, label only: 21 line, so 12 above and below (rounded up).
    expect(slop('when-where-location')).toEqual({ top: 12, bottom: 12 });
    expect(getComputedStyle(screen.getByTestId('when-where-location')).minHeight).toBe(
      '0px',
    );
    // The block's own box contains every slop, and gives the room back as margin.
    const root = getComputedStyle(screen.getByTestId('when-where'));
    expect(root.paddingTop).toBe('12px');
    expect(root.marginTop).toBe('-12px');
    expect(root.paddingBottom).toBe('12px');
    expect(root.marginBottom).toBe('-12px');
  });

  it('needs no slop where the content already reaches 44 pt', () => {
    rn.os = 'ios';
    block({
      reminders: [
        {
          reminderId: 'rem_1',
          activityId: 'act_1',
          userId: 'usr_1' as Reminder['userId'],
          offsetMinutes: -60,
          channel: 'push',
        },
      ],
      location: { label: 'Noble Rot', address: '51 Lamb’s Conduit St' },
    });
    // Date + summary: 24 + 4 + 18 = 46.
    expect(slop('when-where-date')).toEqual({ top: 0, bottom: 0 });
    // Label + address: 21 + 18 = 39, so 3 each side.
    expect(slop('when-where-location')).toEqual({ top: 3, bottom: 3 });
  });

  it('keeps 44 pt of layout on web, where hitSlop does not exist', () => {
    rn.os = 'web';
    block();
    expect(slop('when-where-location')).toEqual({ top: 0, bottom: 0 });
    expect(getComputedStyle(screen.getByTestId('when-where-location')).minHeight).toBe(
      '44px',
    );
    expect(getComputedStyle(screen.getByTestId('when-where')).paddingTop).toBe('0px');
  });
});
