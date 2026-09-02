import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * Motion and width are the two inputs the lifecycle tests at the bottom steer: Reduce Motion
 * resolves every duration to `0`, and the breakpoint chooses the bottom sheet or the dialog.
 * Everything else in the theme is the real thing.
 */
const motionState = vi.hoisted(() => ({
  reduced: false,
  breakpoint: 'compact' as string,
}));
vi.mock('../theme/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../theme/index')>();
  const { motion } = await import('../theme/tokens');
  return {
    ...actual,
    useMotion: () =>
      motionState.reduced
        ? {
            duration: { instant: 0, fast: 0, base: 0, switch: 0, slow: 0, max: 0 },
            easing: motion.easing,
            spring: motion.spring,
            reduced: true,
          }
        : {
            duration: motion.duration,
            easing: motion.easing,
            spring: motion.spring,
            reduced: false,
          },
    useBreakpoint: () => motionState.breakpoint,
  };
});

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

beforeEach(() => {
  keyboardInset.value = 0;
  motionState.reduced = false;
  motionState.breakpoint = 'compact';
});

afterEach(() => vi.useRealTimers());

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

/**
 * **A modal container must say it is a dialog** (`interaction-contract.md` §6,
 * `definition-of-done.md` §5 item 11).
 *
 * React Native Web's `Modal` writes `aria-modal="true"` unconditionally but only adds
 * `role="dialog"` — and only runs its focus trap — once its own show animation has ended.
 * That event never arrives: measured in Chromium against the built export, the container
 * still had `role: null` two seconds after mount. axe reports it as `aria-allowed-attr`, a
 * **critical** violation on every sheet in the product.
 *
 * Found by P3-26's E2E flow, which is the first thing in this repository that opens a sheet
 * on a route an accessibility scan reaches. The fix is in `Sheet` itself; this is the
 * regression test, and it holds under jsdom precisely because jsdom fires no `animationend`
 * either — so a change that put the role back behind that event would fail here.
 */
describe('Sheet — the container is a dialog (§6)', () => {
  it('carries the dialog role beside aria-modal, and a name', () => {
    keyboardInset.value = 0;
    mount(sheet());

    const container = document.querySelector('[aria-modal="true"]');
    expect(container?.getAttribute('role')).toBe('dialog');
    expect(container?.getAttribute('aria-label')).toBe('Repeat');
  });

  /** An untitled sheet is still a dialog, and still has a name to announce. */
  it('names an untitled sheet rather than leaving the dialog anonymous', () => {
    keyboardInset.value = 0;
    mount(
      <ThemeProvider scheme="light">
        <Sheet open onClose={() => {}} testID="untitled">
          <div>body</div>
        </Sheet>
      </ThemeProvider>,
    );

    const container = document.querySelector('[aria-modal="true"]');
    expect(container?.getAttribute('role')).toBe('dialog');
    expect(container?.getAttribute('aria-label')).toBe('Dialog');
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

  /** Under Reduce Motion the exit is instant, so the close reports synchronously. */
  it('closes directly once there is nothing to lose', () => {
    keyboardInset.value = 0;
    motionState.reduced = true;
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

/**
 * **The present / dismiss motion is `Sheet`'s own** (`design-system.md` §4.3, P3-51).
 *
 * The lifecycle under test: the modal mounts instantly (so the dialog role above still holds),
 * the surface animates in from the tokens, every control-driven close asks the owner through
 * `onClose` and moves nothing itself, and the exit runs — then the unmount — once the owner
 * drops `open`. Reduce Motion resolves every duration to `instant`, and the same lifecycle
 * then completes synchronously.
 *
 * The tween steps on `requestAnimationFrame` against `Date.now()`, so faking both puts time in
 * the test's hands (`sheetMotion.test.ts` covers the driver itself).
 */
const useFrameClock = () =>
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'Date',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });

const dialogContainer = () => document.querySelector('[aria-modal="true"]');

describe('Sheet — present / dismiss is its own motion (§4.3)', () => {
  it('mounts as a dialog at once and never hands the animation back to the modal', () => {
    const source = readFileSync(resolve(__dirname, 'Sheet.tsx'), 'utf8');
    // The literal, on both platforms: the role and the focus trap depend on its absence on web.
    expect(source).toContain('animationType="none"');
    expect(source).not.toContain('animationType={');

    useFrameClock();
    mount(sheet());
    // Present, and a dialog, before a single frame has run.
    expect(dialogContainer()?.getAttribute('role')).toBe('dialog');
  });

  /**
   * The owner decides: ✕ asks through `onClose` at once and moves nothing, so an owner that
   * declines (a sub-editor's "back") keeps its sheet; the exit runs once `open` drops, and
   * only then does the modal unmount. A leaving sheet takes no taps.
   */
  it('asks the owner at once, exits when open drops, and ignores taps while leaving', () => {
    useFrameClock();
    const onClose = vi.fn();
    const onRow = vi.fn();
    const view = (open: boolean) => (
      <ThemeProvider scheme="light">
        <Sheet open={open} onClose={onClose} title="Repeat" testID="sheet">
          <button type="button" onClick={onRow}>
            Tomorrow
          </button>
        </Sheet>
      </ThemeProvider>
    );
    const rendered = render(view(true));
    act(() => vi.advanceTimersByTime(300)); // fully presented

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    // Declined: nothing moved, the sheet is still the sheet.
    act(() => vi.advanceTimersByTime(400));
    expect(dialogContainer()).not.toBeNull();

    rendered.rerender(view(false));
    act(() => vi.advanceTimersByTime(100)); // mid-exit: mounted, inert
    expect(dialogContainer()).not.toBeNull();
    expect(
      (screen.getByTestId('sheet').parentElement as HTMLElement).style.pointerEvents,
    ).toBe('none');

    act(() => vi.advanceTimersByTime(300)); // past `slow`
    expect(dialogContainer()).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  /** An owner that closes on its own — after a save — still gets the exit, then the unmount. */
  it('animates out before unmounting when the owner drops open', () => {
    useFrameClock();
    const onClose = vi.fn();
    const view = (open: boolean) => (
      <ThemeProvider scheme="light">
        <Sheet open={open} onClose={onClose} title="Repeat" testID="sheet">
          <div>body</div>
        </Sheet>
      </ThemeProvider>
    );
    const rendered = render(view(true));
    act(() => vi.advanceTimersByTime(300));

    rendered.rerender(view(false));
    expect(dialogContainer()).not.toBeNull();
    act(() => vi.advanceTimersByTime(400));
    expect(dialogContainer()).toBeNull();
    // The owner already knows; it is not told twice.
    expect(onClose).not.toHaveBeenCalled();
  });

  /** `dirty` routes through the discard prompt and does not leave until the prompt resolves. */
  it('does not animate out while a dirty sheet waits on its discard prompt', () => {
    useFrameClock();
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
    act(() => vi.advanceTimersByTime(300));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    act(() => vi.advanceTimersByTime(600));

    expect(onDiscardRequest).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(dialogContainer()).not.toBeNull();
  });

  /**
   * Reduce Motion resolves every duration to `instant`: the same lifecycle, completing
   * synchronously — mounted as a dialog, and gone the moment the owner drops `open`.
   */
  it('mounts and unmounts under Reduce Motion the moment the owner drops open', () => {
    motionState.reduced = true;
    const onClose = vi.fn();
    const view = (open: boolean) => (
      <ThemeProvider scheme="light">
        <Sheet open={open} onClose={onClose} title="Repeat" testID="sheet">
          <div>body</div>
        </Sheet>
      </ThemeProvider>
    );
    const rendered = render(view(true));
    expect(dialogContainer()?.getAttribute('role')).toBe('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    // Asked, not gone: the owner drops `open`, and the instant exit unmounts at once.
    expect(dialogContainer()).not.toBeNull();
    rendered.rerender(view(false));
    expect(dialogContainer()).toBeNull();
    rendered.rerender(view(true));
    expect(dialogContainer()?.getAttribute('role')).toBe('dialog');
    rendered.rerender(view(false));
    expect(dialogContainer()).toBeNull();
  });

  /** One component, two resolved treatments: the centred dialog runs the same lifecycle. */
  it('runs the same lifecycle for the centred dialog', () => {
    motionState.breakpoint = 'medium';
    useFrameClock();
    const onClose = vi.fn();
    const view = (open: boolean) => (
      <ThemeProvider scheme="light">
        <Sheet open={open} onClose={onClose} title="Repeat" testID="dialog">
          <div>body</div>
        </Sheet>
      </ThemeProvider>
    );
    const rendered = render(view(true));
    expect(screen.queryByTestId('sheet-grabber')).toBeNull();
    expect(dialogContainer()?.getAttribute('role')).toBe('dialog');
    act(() => vi.advanceTimersByTime(300));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    rendered.rerender(view(false));
    expect(dialogContainer()).not.toBeNull();
    act(() => vi.advanceTimersByTime(400));
    expect(dialogContainer()).toBeNull();
  });

  /**
   * A drag-dismissed sheet is already at its final offset: it leaves by opacity from there and
   * never snaps back first — once the owner drops `open`. The responder cannot be driven under jsdom (see the pan note
   * above), so the decision is `dragReleaseOutcome`'s (`sheetMotion.test.ts`) and this pins
   * that the release branch reaches the fade exit without resetting the drag first.
   */
  it('leaves by fade from the finger after a drag, without snapping back', () => {
    const source = readFileSync(resolve(__dirname, 'Sheet.tsx'), 'utf8');
    const release = source.slice(
      source.indexOf('onPanResponderRelease'),
      source.indexOf('onPanResponderTerminate'),
    );
    // The manner is decided here; the owner still drops `open`, and the fall then fades.
    expect(release).toContain("pendingExit.current = 'fade'");
    expect(release).toContain('onClose()');
    expect(release).not.toContain('dragY.setValue(0)');
    expect(release).toContain("outcome === 'settle-then-discard'");
  });
});
