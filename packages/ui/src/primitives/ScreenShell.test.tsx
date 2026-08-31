import { fireEvent, render, screen } from '@testing-library/react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme/ThemeProvider';
import { ScreenShell } from './ScreenShell';
import { Text } from './Text';

const keyboardInset = vi.hoisted(() => ({ value: 0 }));
vi.mock('../theme/keyboard', () => ({
  useKeyboardInset: () => keyboardInset.value,
}));

function mount(onScroll = vi.fn()) {
  return {
    onScroll,
    ...render(
      <ThemeProvider scheme="light">
        <SafeAreaProvider>
          <ScreenShell testID="shell" onScroll={onScroll} scrollEventThrottle={16}>
            <Text>Focused field</Text>
          </ScreenShell>
        </SafeAreaProvider>
      </ThemeProvider>,
    ),
  };
}

function scrollContent(): HTMLElement {
  const content = screen.getByText('Focused field').parentElement?.parentElement;
  if (!(content instanceof HTMLElement)) throw new Error('Scroll content must render');
  return content;
}

describe('ScreenShell keyboard and paginated-scroll ownership', () => {
  beforeEach(() => {
    keyboardInset.value = 0;
  });

  it('forwards pagination scroll events from its owned ScrollView', () => {
    const { onScroll } = mount();
    fireEvent.scroll(screen.getByTestId('shell-body'));
    expect(onScroll).toHaveBeenCalledOnce();
  });

  it('uses the compact header-to-body bridge inside its owned ScrollView', () => {
    render(
      <ThemeProvider scheme="light">
        <SafeAreaProvider>
          <ScreenShell
            header={<Text>List header</Text>}
            bodySpacing="compact"
            testID="compact-shell"
          >
            <Text>Compact body</Text>
          </ScreenShell>
        </SafeAreaProvider>
      </ThemeProvider>,
    );

    const content = screen.getByText('Compact body').parentElement?.parentElement;
    if (!(content instanceof HTMLElement)) throw new Error('Scroll content must render');
    expect(getComputedStyle(content).paddingTop).toBe('8px');
  });

  it('replaces the safe-area inset on keyboard show, resize, and hide', () => {
    const view = mount();
    expect(getComputedStyle(scrollContent()).paddingBottom).toBe('66px');

    keyboardInset.value = 336;
    view.rerender(
      <ThemeProvider scheme="light">
        <SafeAreaProvider>
          <ScreenShell testID="shell">
            <Text>Focused field</Text>
          </ScreenShell>
        </SafeAreaProvider>
      </ThemeProvider>,
    );
    expect(getComputedStyle(scrollContent()).paddingBottom).toBe('368px');

    keyboardInset.value = 280;
    view.rerender(
      <ThemeProvider scheme="light">
        <SafeAreaProvider>
          <ScreenShell testID="shell">
            <Text>Focused field</Text>
          </ScreenShell>
        </SafeAreaProvider>
      </ThemeProvider>,
    );
    expect(getComputedStyle(scrollContent()).paddingBottom).toBe('312px');

    keyboardInset.value = 0;
    view.rerender(
      <ThemeProvider scheme="light">
        <SafeAreaProvider>
          <ScreenShell testID="shell">
            <Text>Focused field</Text>
          </ScreenShell>
        </SafeAreaProvider>
      </ThemeProvider>,
    );
    expect(getComputedStyle(scrollContent()).paddingBottom).toBe('66px');
  });
});
