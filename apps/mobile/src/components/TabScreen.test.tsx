import { Button, EmptyState, Text, ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
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

  it('renders an optional header action beside the title', () => {
    let pressed = false;
    wrap(
      <TabScreen
        title="Today"
        testID="today-screen"
        headerAction={<Button label="More" onPress={() => (pressed = true)} />}
      >
        <EmptyState heading="Nothing planned today" />
      </TabScreen>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(pressed).toBe(true);
  });

  it('keeps a flexible connectivity slot between the title and fixed actions', () => {
    wrap(
      <TabScreen
        title="Today"
        testID="today-screen"
        titleAccessory={<Text>Offline</Text>}
        headerAction={<Text testID="day-count">4 of 19 done</Text>}
      >
        <Text>Body</Text>
      </TabScreen>,
    );

    const title = screen.getByRole('heading', { name: 'Today' });
    const statusSlot = screen.getByTestId('today-screen-title-accessory-slot');
    const count = screen.getByTestId('day-count');
    expect(statusSlot.style.flexGrow).toBe('1');
    expect(
      title.compareDocumentPosition(statusSlot) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      statusSlot.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('does not reserve a permanent band for the floating Add button', () => {
    wrap(
      <TabScreen title="Today" testID="today-screen">
        <EmptyState heading="Nothing planned today" />
      </TabScreen>,
    );

    expect(screen.getByTestId('tab-screen-body').getAttribute('style')).not.toContain(
      'padding-bottom',
    );
  });

  it('can yield only its standard header to screen-owned overlay chrome', () => {
    wrap(
      <TabScreen title="Plans" testID="plans-screen" hideHeader>
        <Text>Plan list</Text>
      </TabScreen>,
    );

    expect(screen.queryByRole('heading', { name: 'Plans' })).toBeNull();
    expect(screen.getByText('Plan list')).toBeDefined();
    expect(screen.getByTestId('tab-screen-body')).toBeDefined();
  });
});

/**
 * The two Today-only slots (P2-44). Plans and Lists pass neither and must render exactly what
 * they rendered before — the phase task's "byte-identically", asserted as absence rather than as
 * a snapshot, per `testing.md` §5.
 */
describe('the Today-only header slots', () => {
  it('renders no caption and no slot when neither is given', () => {
    wrap(
      <TabScreen title="Plans" testID="plans-screen">
        <Text>Body</Text>
      </TabScreen>,
    );

    expect(screen.queryByTestId('plans-screen-caption')).toBeNull();
    expect(screen.queryByTestId('day-progress')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Plans' })).toBeDefined();
  });

  it('puts the caption above the title and the slot below the header row', () => {
    wrap(
      <TabScreen
        title="Today"
        testID="today-screen"
        caption="Thursday, August 6"
        belowHeader={<Text testID="day-progress">bar</Text>}
      >
        <Text>Body</Text>
      </TabScreen>,
    );

    const caption = screen.getByTestId('today-screen-caption');
    const title = screen.getByRole('heading', { name: 'Today' });
    const slot = screen.getByTestId('day-progress');

    // Document order is reading order (`interaction-contract.md` §7.3).
    expect(
      caption.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(title.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
