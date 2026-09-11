import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

// Exercise the native implementation; the UI test resolver normally prefers .web.ts.
const { useScrollToFocusedInput } =
  await vi.importActual<typeof import('./scrollToFocused')>('./scrollToFocused.ts');

const native = vi.hoisted(() => ({
  y: 600,
  input: {
    measureInWindow: (
      callback: (x: number, y: number, width: number, height: number) => void,
    ) => callback(0, native.y, 200, 96),
  },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  TextInput: { State: { currentlyFocusedInput: () => native.input } },
}));

/** A scroll view whose frame starts `top` points down the window. */
const scrollAt = (top: number) => ({
  getScrollableNode: vi.fn(),
  getNativeScrollRef: () => ({
    measureInWindow: (
      callback: (x: number, y: number, width: number, height: number) => void,
    ) => callback(0, top, 390, 300),
  }),
  scrollTo: vi.fn(),
  scrollResponderScrollNativeHandleToKeyboard: vi.fn(),
});

it('moves an iOS input above a keyboard footer instead of leaving the caret hidden', async () => {
  const scroll = scrollAt(0);
  renderHook(() => useScrollToFocusedInput({ current: scroll }, 250, 800, 1200, 80));
  await waitFor(() =>
    expect(scroll.scrollResponderScrollNativeHandleToKeyboard).toHaveBeenCalledWith(
      native.input,
      96,
      true,
    ),
  );
});

/**
 * React Native's keyboard scroll assumes the scroll view starts at the top of the window. A
 * lifted Sheet's body starts well below it, so its window top is owed on top of the footer or
 * the field lands that far short — still under the actions.
 */
it('adds the scroll view’s own window offset for a body that does not start at the top', async () => {
  const scroll = scrollAt(300);
  renderHook(() => useScrollToFocusedInput({ current: scroll }, 250, 800, 1200, 80));
  await waitFor(() =>
    expect(scroll.scrollResponderScrollNativeHandleToKeyboard).toHaveBeenCalledWith(
      native.input,
      396,
      true,
    ),
  );
});

it('does not move an iOS input that is already above the keyboard footer', async () => {
  native.y = 100;
  const measured = vi.spyOn(native.input, 'measureInWindow');
  const scroll = scrollAt(0);
  try {
    renderHook(() => useScrollToFocusedInput({ current: scroll }, 250, 800, 1200, 80));
    await waitFor(() => expect(measured).toHaveBeenCalled());
    expect(scroll.scrollResponderScrollNativeHandleToKeyboard).not.toHaveBeenCalled();
  } finally {
    native.y = 600;
    measured.mockRestore();
  }
});
