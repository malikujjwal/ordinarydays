import { ThemeProvider } from '@od/ui';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSyncStatus } from '@/stores/syncStatus';

const recovery = vi.hoisted(() => ({
  retry: vi.fn(async () => true),
  discard: vi.fn(async () => true),
  blocked: vi.fn(),
}));

function blockedIntent() {
  return {
    intentId: 'blocked-one',
    ownerUserId: 'usr_01J0000000000000000000000A',
    mutationKey: ['activity', 'patch'],
    variables: {},
    entityId: 'act_01J0000000000000000000000A',
    orderingKey: 'activity:act_01J0000000000000000000000A',
    status: 'needs_attention',
    createdAt: 1,
    seq: 1,
    attempts: 1,
    attention: { kind: 'rejected', status: 422 },
    lastError: 'Rejected title',
  };
}

vi.mock('@/hooks/usePendingIntents', () => ({
  useBlockedIntents: () => recovery.blocked(),
  retryBlockedIntent: recovery.retry,
  discardBlockedIntent: recovery.discard,
}));

import { SyncStatusBanner } from './SyncStatusBanner';

function bannerUnderTest() {
  return (
    <SafeAreaProvider>
      <ThemeProvider scheme="light">
        <SyncStatusBanner />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function renderBanner() {
  return render(bannerUnderTest());
}

describe('SyncStatusBanner recovery controls', () => {
  beforeEach(() => {
    recovery.retry.mockClear();
    recovery.discard.mockClear();
    recovery.retry.mockResolvedValue(true);
    recovery.discard.mockResolvedValue(true);
    recovery.blocked.mockReset();
    recovery.blocked.mockReturnValue([blockedIntent()]);
    useSyncStatus.setState({ queueMessage: undefined, conflictChanges: [] });
  });

  it('offers explicit Retry and Discard for retained writes', async () => {
    renderBanner();
    expect(screen.getByText("1 change couldn't be applied.")).toBeDefined();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(recovery.retry).toHaveBeenCalledWith('blocked-one'));
  });

  it('removes an accepted recovery immediately instead of waiting for a store refresh', async () => {
    renderBanner();

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(screen.queryByTestId('blocked-intents')).toBeNull());
  });

  it('shows the same intent again when an accepted retry fails later', async () => {
    const rendered = renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByTestId('blocked-intents')).toBeNull());

    act(() => {
      recovery.blocked.mockReturnValue([]);
      rendered.rerender(bannerUnderTest());
    });
    act(() => {
      recovery.blocked.mockReturnValue([blockedIntent()]);
      rendered.rerender(bannerUnderTest());
    });

    expect(screen.getByText("1 change couldn't be applied.")).toBeDefined();
  });

  it('describes a failed authoritative refresh without claiming the change disappeared', async () => {
    recovery.discard.mockResolvedValueOnce(false);
    renderBanner();

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(
      await screen.findByText("Couldn't refresh the latest data. Check your connection."),
    ).toBeDefined();
    expect(
      screen.queryByText('That change is no longer waiting for recovery.'),
    ).toBeNull();
  });
});
