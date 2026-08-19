import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HydrationGate, STARTUP_ERROR_MESSAGE } from './HydrationGate';

type GateProps = Parameters<typeof HydrationGate>[0];

function restoreOutcome() {
  return { status: 'empty' as const, safeToPersist: Promise.resolve() };
}

function renderGate(overrides: Partial<GateProps>) {
  return render(
    <SafeAreaProvider>
      <ThemeProvider scheme="light">
        <HydrationGate
          install={() => () => undefined}
          restore={async () => restoreOutcome()}
          startSession={async () => ({
            stop: () => undefined,
            queryPersistenceSafe: true,
          })}
          subscribe={() => () => undefined}
          {...overrides}
        >
          <Text>gate-children</Text>
        </HydrationGate>
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

describe('HydrationGate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('surfaces a session-start failure as a retryable error instead of blocking hydration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const startSession = vi
      .fn<NonNullable<GateProps['startSession']>>()
      .mockRejectedValueOnce(new Error('the account database would not open'))
      .mockResolvedValueOnce({ stop: () => undefined, queryPersistenceSafe: true });
    const subscribe = vi.fn(() => () => undefined);
    const install = vi.fn(() => () => undefined);
    renderGate({ startSession, subscribe, install });

    await screen.findByTestId('startup-error');
    expect(screen.getByText(STARTUP_ERROR_MESSAGE)).toBeDefined();
    expect(screen.queryByText('gate-children')).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      'native_state_session_failed',
      'the account database would not open',
    );
    expect(subscribe).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('startup-retry'));

    await screen.findByText('gate-children');
    expect(startSession).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('surfaces a persisted-restore failure the same way', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const startSession = vi.fn<NonNullable<GateProps['startSession']>>();
    renderGate({
      restore: async () => {
        throw new Error('storage read failed');
      },
      startSession,
    });

    await screen.findByTestId('startup-error');
    expect(screen.queryByText('gate-children')).toBeNull();
    expect(startSession).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'native_state_session_failed',
      'storage read failed',
    );
  });
});
