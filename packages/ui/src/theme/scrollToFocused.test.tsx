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

it('moves an iOS input above a keyboard footer instead of leaving the caret hidden', async () => {
  const scroll = {
    getScrollableNode: vi.fn(),
    scrollTo: vi.fn(),
    scrollResponderScrollNativeHandleToKeyboard: vi.fn(),
  };
  renderHook(() => useScrollToFocusedInput({ current: scroll }, 250, 800, 1200, 80));
  await waitFor(() =>
    expect(scroll.scrollResponderScrollNativeHandleToKeyboard).toHaveBeenCalledWith(
      native.input,
      96,
      true,
    ),
  );
});

it('does not move an iOS input that is already above the keyboard footer', async () => {
  native.y = 100;
  const measured = vi.spyOn(native.input, 'measureInWindow');
  const scroll = {
    getScrollableNode: vi.fn(),
    scrollTo: vi.fn(),
    scrollResponderScrollNativeHandleToKeyboard: vi.fn(),
  };
  try {
    renderHook(() => useScrollToFocusedInput({ current: scroll }, 250, 800, 1200, 80));
    await waitFor(() => expect(measured).toHaveBeenCalled());
    expect(scroll.scrollResponderScrollNativeHandleToKeyboard).not.toHaveBeenCalled();
  } finally {
    native.y = 600;
    measured.mockRestore();
  }
});
