import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { describe, expect, it, vi } from 'vitest';
import { AnytimeScreen } from './AnytimeScreen';

describe('AnytimeScreen loading stub', () => {
  it('renders a serif display heading, five-row skeleton and working back control', () => {
    const onBack = vi.fn();
    render(
      <SafeAreaProvider>
        <ThemeProvider scheme="light">
          <AnytimeScreen onBack={onBack} />
        </ThemeProvider>
      </SafeAreaProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Anytime' })).toBeDefined();
    expect(screen.getByTestId('anytime-loading')).toBeDefined();
    expect(screen.getByRole('progressbar', { name: 'Loading' }).children).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
