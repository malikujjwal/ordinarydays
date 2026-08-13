import { ThemeProvider } from '@od/ui';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '@/stores/toast';
import { AddButton } from './AddButton';
import { NavRail } from './NavRail';
import { ShellFrame } from './ShellFrame';
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

/**
 * Sets the viewport `useBreakpoint()` reads.
 *
 * jsdom performs no layout, so `documentElement.clientWidth` — which is what React Native
 * Web's `Dimensions` measures, having no `visualViewport` to prefer — is `0` and every
 * breakpoint assertion would otherwise be `compact` by accident rather than by width. Stating
 * it and firing the `resize` that `Dimensions` subscribes to is what makes the two cases
 * genuinely different.
 */
function resizeTo(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: 900,
    configurable: true,
  });
  window.dispatchEvent(new Event('resize'));
}

/** The viewport is global, so it is put back — otherwise a later test inherits a width. */
afterEach(() => resizeTo(390));

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

/**
 * The render test P1-23 asks for: *"three tabs with the exact labels and that the FAB is
 * present on each."*
 *
 * Asserted against `ShellFrame` rather than against `(tabs)/_layout.tsx`, because the layout
 * is a route file — `testing.md` §9 excludes those on the grounds that their logic belongs in
 * the components they compose, and booting an Expo Router navigator under jsdom would test the
 * navigator rather than this repository. The frame is what actually holds both claims: the
 * three destinations come from one frozen module, and the Add button is a sibling of
 * `children`, so it cannot vary by tab.
 */
describe('ShellFrame', () => {
  const frameFor = (activeName: string) =>
    wrap(
      <ShellFrame activeName={activeName} onSelect={() => {}} onAdd={() => {}}>
        <View testID={`${activeName}-body`} />
      </ShellFrame>,
    );

  it.each(['index', 'plans', 'lists'])('keeps the one Add button on %s', (name) => {
    const { unmount } = frameFor(name);
    expect(screen.getAllByRole('button', { name: 'Add' })).toHaveLength(1);
    expect(screen.getByTestId(`${name}-body`)).toBeDefined();
    unmount();
  });

  /**
   * At `compact` the navigator supplies the bottom bar, so the frame must **not** also draw a
   * rail — two navigations for three destinations.
   */
  it('draws no rail at compact width', () => {
    resizeTo(390);
    frameFor('index');
    expect(screen.queryByTestId('nav-rail')).toBeNull();
  });

  /** `design-system.md` §8: from 768 up the rail replaces the bar. */
  it('draws the rail from medium up', () => {
    resizeTo(1024);
    frameFor('plans');
    expect(screen.getByTestId('nav-rail')).toBeDefined();
    // Still exactly one Add button — the rail does not bring a second.
    expect(screen.getAllByRole('button', { name: 'Add' })).toHaveLength(1);
  });

  it('routes T to Today only when focus is outside an editable field', () => {
    const onSelect = vi.fn();
    wrap(
      <ShellFrame activeName="plans" onSelect={onSelect} onAdd={() => {}}>
        <input aria-label="Title" />
      </ShellFrame>,
    );

    fireEvent.keyDown(document, { key: 't' });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({
      name: 'index',
      label: 'Today',
      path: '/',
    });

    onSelect.mockClear();
    const title = screen.getByRole('textbox', { name: 'Title' });
    title.focus();
    fireEvent.keyDown(title, { key: 't' });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('NavRail', () => {
  it('offers exactly Today, Plans, Lists, in that order', () => {
    wrap(<NavRail activeName="index" onSelect={() => {}} />);
    expect(screen.getAllByRole('link').map((element) => element.textContent)).toEqual([
      'Today',
      'Plans',
      'Lists',
    ]);
  });

  it('carries the wordmark', () => {
    wrap(<NavRail activeName="index" onSelect={() => {}} />);
    expect(screen.getByText('Ordinary Days')).toBeDefined();
  });

  /** The active entry says so, not only by its `surfaceSunken` pill. */
  it('marks the active entry as the current page', () => {
    wrap(<NavRail activeName="plans" onSelect={() => {}} />);
    expect(screen.getByRole('link', { name: 'Plans' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      screen.getByRole('link', { name: 'Today' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('reports which destination was chosen', () => {
    const onSelect = vi.fn();
    wrap(<NavRail activeName="index" onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('link', { name: 'Lists' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({
      name: 'lists',
      label: 'Lists',
      path: '/lists',
    });
  });
});

describe('ToastHost', () => {
  beforeEach(() => useToast.setState({ current: undefined }));

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

  it('runs Undo without committing and supports Cmd/Ctrl+Z', () => {
    const onUndo = vi.fn();
    const onCommit = vi.fn();
    useToast.getState().showUndo({ message: 'Task completed', onUndo, onCommit });
    wrap(<ToastHost />);

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });

    expect(onUndo).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('commits once when the six-second window expires', () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    useToast
      .getState()
      .showUndo({ message: 'Task completed', onUndo: vi.fn(), onCommit });
    wrap(<ToastHost />);

    act(() => vi.advanceTimersByTime(6000));
    act(() => vi.advanceTimersByTime(6000));

    expect(onCommit).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
    vi.useRealTimers();
  });
});
