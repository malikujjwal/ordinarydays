import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme/ThemeProvider';

/**
 * The keyboard inset is the one thing here worth faking: jsdom has no `visualViewport`, so the
 * web fork honestly reports `0` and the composition under test — *does the sheet move out from
 * under the keyboard* — would never be exercised. Mocked at the module boundary rather than by
 * dispatching viewport events, because the contract being asserted is `Sheet`'s, not the hook's.
 */
const keyboardInset = vi.hoisted(() => ({ value: 0 }));
vi.mock('../theme/keyboard', () => ({
  useKeyboardInset: () => keyboardInset.value,
}));

const { Sheet } = await import('./Sheet');
const { Button } = await import('./Button');

const mount = (node: ReactNode) =>
  render(<ThemeProvider scheme="light">{node}</ThemeProvider>);

const sheet = (actions?: ReactNode) => (
  <Sheet
    open
    onClose={() => {}}
    title="Repeat"
    detent="fit"
    {...(actions === undefined ? {} : { actions })}
    testID="sheet"
  >
    <div>body</div>
  </Sheet>
);

describe('Sheet — the keyboard contract (§20)', () => {
  it('sits on the safe-area inset while the keyboard is closed', () => {
    keyboardInset.value = 0;
    mount(sheet());

    // 24 (`space[7]`) plus the stub's 34 pt home indicator.
    expect(screen.getByTestId('sheet').style.paddingBottom).toBe('58px');
  });

  /**
   * **The whole surface lifts, not just the body.** Lifting only the content would leave the
   * actions slot — the control the user needs to finish the edit — behind the keyboard, which is
   * §20's named failure. The scrim carries the offset so the fixed footer rides up with it.
   */
  it('lifts clear of the keyboard, and drops the home indicator while it does', () => {
    keyboardInset.value = 336;
    mount(sheet(<Button label="Apply repeat" onPress={() => {}} />));

    const surface = screen.getByTestId('sheet');
    // The home indicator is under the keyboard, so its inset is no longer owed.
    expect(surface.style.paddingBottom).toBe('24px');
    expect((surface.parentElement as HTMLElement).style.paddingBottom).toBe('336px');
    expect(screen.getByTestId('sheet-actions')).toBeDefined();
  });

  it('keeps the body scrollable and the actions outside it', () => {
    keyboardInset.value = 0;
    mount(sheet(<Button label="Apply repeat" onPress={() => {}} />));

    const body = screen.getByTestId('sheet-body');
    expect(body.contains(screen.getByTestId('sheet-actions'))).toBe(false);
  });
});

describe('Sheet — the grabber is a promise (§0)', () => {
  it('renders a grabber when the sheet can be dragged', () => {
    keyboardInset.value = 0;
    mount(sheet());

    expect(screen.getByTestId('sheet-grabber')).toBeDefined();
  });

  /** Nothing to drag, so nothing that says you can. */
  it('renders none when the sheet cannot be dismissed', () => {
    keyboardInset.value = 0;
    mount(
      <ThemeProvider scheme="light">
        <Sheet open onClose={() => {}} title="Repeat" dismissible={false} testID="fixed">
          <div>body</div>
        </Sheet>
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('sheet-grabber')).toBeNull();
  });
});

/**
 * §20: `✕` asking while swipe silently discards is the divergence this prevents. Every exit
 * converges on one `requestClose`, so a screen cannot guard one path and forget another.
 */
describe('Sheet — dirty state guards every exit', () => {
  it('routes the close button through the discard request rather than closing', () => {
    keyboardInset.value = 0;
    const onClose = vi.fn();
    const onDiscardRequest = vi.fn();
    mount(
      <ThemeProvider scheme="light">
        <Sheet
          open
          onClose={onClose}
          onDiscardRequest={onDiscardRequest}
          dirty
          title="Notes"
          testID="dirty"
        >
          <div>body</div>
        </Sheet>
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDiscardRequest).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes directly once there is nothing to lose', () => {
    keyboardInset.value = 0;
    const onClose = vi.fn();
    const onDiscardRequest = vi.fn();
    mount(
      <ThemeProvider scheme="light">
        <Sheet
          open
          onClose={onClose}
          onDiscardRequest={onDiscardRequest}
          title="Notes"
          testID="clean"
        >
          <div>body</div>
        </Sheet>
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onDiscardRequest).not.toHaveBeenCalled();
  });
});

/**
 * **Where the pan is attached, guarded at the source.**
 *
 * The reported bug was not a threshold and not a policy — both were right. It was that
 * `panHandlers` hung on the header `View`, so a swipe starting anywhere else never reached the
 * responder at all. React Native Web's responder system does not run on the synthetic touch
 * events jsdom can produce, so a test that "drives a swipe" here would pass whether the sheet
 * dismissed or not. This asserts the one fact a rendered test cannot: the handlers are on the
 * surface, and the surface is the element the detent, the elevation and `testID` are on.
 *
 * The behaviour itself is covered by `sheetGesture.test.ts`, and was reproduced in a browser
 * before and after the fix.
 */
describe('Sheet — the pan is on the surface, not the header (§6.1)', () => {
  const source = readFileSync(resolve(__dirname, 'Sheet.tsx'), 'utf8');

  it('spreads panHandlers onto the animated surface', () => {
    const surface = source.slice(source.indexOf('<Animated.View'));
    const beforeChildren = surface.slice(0, surface.indexOf('>'));

    expect(beforeChildren).toContain('responder.panHandlers');
    expect(beforeChildren).toContain('testID={testID}');
  });

  it('leaves no second copy of the handlers on an inner element', () => {
    expect(source.match(/responder\.panHandlers/g)).toHaveLength(1);
  });

  /** Capture, or the ScrollView claims the gesture before the sheet is ever asked. */
  it('claims the gesture in the capture phase', () => {
    expect(source).toContain('onMoveShouldSetPanResponderCapture');
    expect(source).not.toContain('onMoveShouldSetPanResponder:');
  });
});
