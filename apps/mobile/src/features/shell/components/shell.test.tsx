import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '@/stores/toast';
import { AddButton } from './AddButton';
import { TabScreen } from './TabScreen';
import { ToastHost } from './ToastHost';

/**
 * The shell's three components (P1-23).
 *
 * The navigator itself is not rendered here — `app/(app)/(tabs)/_layout.tsx` is a route file,
 * and `testing.md` §9 excludes those by name because their logic belongs in the components
 * they compose. What the layout decides is *which* tabs exist, and that is asserted against
 * the pure module in `../model/tabs.test.ts`.
 */
const wrap = (ui: ReactNode) =>
  render(
    <SafeAreaProvider>
      <ThemeProvider scheme="light">{ui}</ThemeProvider>
    </SafeAreaProvider>,
  );

describe('AddButton', () => {
  it('is a button whose accessible name is Add', () => {
    wrap(<AddButton onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Add' })).toBeDefined();
  });

  it('calls its one handler', () => {
    const onPress = vi.fn();
    wrap(<AddButton onPress={onPress} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onPress).toHaveBeenCalledOnce();
  });

  /**
   * The control keeps its 56 pt visual size and its 44 pt floor. Asserted on the rendered
   * style rather than on the constant, so a caller that passed a smaller style would fail.
   */
  it('renders at 56 pt with the 44 pt minimum still applied', () => {
    wrap(<AddButton onPress={() => {}} />);
    const style = screen.getByRole('button', { name: 'Add' }).getAttribute('style') ?? '';
    expect(style).toContain('width: 56px');
    expect(style).toContain('height: 56px');
    expect(style).toContain('min-height: 44px');
  });
});

describe('TabScreen', () => {
  it('renders the screen title as a heading and its placeholder body', () => {
    wrap(
      <TabScreen
        title="Today"
        emptyHeading="Nothing planned today"
        emptyBody="The day's agenda arrives in Phase 2."
        testID="today-screen"
      />,
    );

    expect(screen.getByRole('heading', { name: 'Today' })).toBeDefined();
    expect(screen.getByText('Nothing planned today')).toBeDefined();
    expect(screen.getByText("The day's agenda arrives in Phase 2.")).toBeDefined();
  });
});

describe('ToastHost', () => {
  beforeEach(() => useToast.getState().dismiss());

  it('renders nothing when there is no toast', () => {
    wrap(<ToastHost />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('announces the active toast', () => {
    useToast.getState().show({ message: 'Task · saved to Anytime' });
    wrap(<ToastHost />);

    expect(screen.getByText('Task · saved to Anytime')).toBeDefined();
    // Announced without stealing focus (`interaction-contract.md` §4.2).
    expect(screen.getByRole('alert').getAttribute('aria-live')).toBe('polite');
  });

  /** One at a time: a new toast commits the previous rather than queueing behind it. */
  it('replaces the previous message rather than stacking', () => {
    useToast.getState().show({ message: 'first' });
    useToast.getState().show({ message: 'second' });
    wrap(<ToastHost />);

    expect(screen.queryByText('first')).toBeNull();
    expect(screen.getByText('second')).toBeDefined();
  });
});
