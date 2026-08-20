import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSyncStatus } from '@/stores/syncStatus';

const recovery = vi.hoisted(() => ({
  retry: vi.fn(async () => true),
  discard: vi.fn(async () => true),
}));

vi.mock('@/hooks/usePendingIntents', () => ({
  useBlockedIntents: () => [
    {
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
    },
  ],
  retryBlockedIntent: recovery.retry,
  discardBlockedIntent: recovery.discard,
}));

import { SyncStatusBanner } from './SyncStatusBanner';

function renderBanner() {
  return render(
    <SafeAreaProvider>
      <ThemeProvider scheme="light">
        <SyncStatusBanner />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

describe('SyncStatusBanner recovery controls', () => {
  beforeEach(() => {
    recovery.retry.mockClear();
    recovery.discard.mockClear();
    useSyncStatus.setState({ queueMessage: undefined, conflictChanges: [] });
  });

  it('offers explicit Retry and Discard for retained writes', async () => {
    renderBanner();
    expect(screen.getByText("1 change couldn't be applied.")).toBeDefined();

    fireEvent.click(screen.getByTestId('retry-intent-blocked-one'));
    await waitFor(() => expect(recovery.retry).toHaveBeenCalledWith('blocked-one'));
    await waitFor(() =>
      expect(
        screen.getByTestId('discard-intent-blocked-one').getAttribute('aria-disabled'),
      ).not.toBe('true'),
    );

    fireEvent.click(screen.getByTestId('discard-intent-blocked-one'));
    await waitFor(() => expect(recovery.discard).toHaveBeenCalledWith('blocked-one'));
  });
});
