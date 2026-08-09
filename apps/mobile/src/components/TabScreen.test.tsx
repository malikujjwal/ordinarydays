import { EmptyState, ThemeProvider } from '@od/ui';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { describe, expect, it } from 'vitest';
import { TabScreen } from './TabScreen';

const wrap = (ui: ReactNode) =>
  render(
    <SafeAreaProvider>
      <ThemeProvider scheme="light">{ui}</ThemeProvider>
    </SafeAreaProvider>,
  );

describe('TabScreen', () => {
  it('renders the screen title as a heading, and whatever body it is given', () => {
    wrap(
      <TabScreen title="Today" testID="today-screen">
        <EmptyState
          heading="Nothing planned today"
          body="The day's agenda arrives in Phase 2."
        />
      </TabScreen>,
    );

    expect(screen.getByRole('heading', { name: 'Today' })).toBeDefined();
    expect(screen.getByText('Nothing planned today')).toBeDefined();
    expect(screen.getByText("The day's agenda arrives in Phase 2.")).toBeDefined();
  });
});
