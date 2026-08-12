import { ApiError } from '@od/shared/client';
import { ThemeProvider } from '@od/ui';
import { render, screen } from '@testing-library/react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { beforeEach, describe, expect, it } from 'vitest';
import { activityMutationKeys } from '@/lib/mutationKeys';
import { OFFLINE_QUEUE_FULL_MESSAGE, useSyncStatus } from '@/stores/syncStatus';
import { SyncStatusBanner } from './SyncStatusBanner';

const renderBanner = () =>
  render(
    <SafeAreaProvider>
      <ThemeProvider scheme="light">
        <SyncStatusBanner />
      </ThemeProvider>
    </SafeAreaProvider>,
  );

describe('SyncStatusBanner', () => {
  beforeEach(() =>
    useSyncStatus.setState({ queueMessage: undefined, conflictChanges: [] }),
  );

  it('shows the exact queue-cap message in one live banner', () => {
    useSyncStatus.getState().showQueueFull();
    renderBanner();

    expect(screen.getByRole('alert').textContent).toContain(OFFLINE_QUEUE_FULL_MESSAGE);
  });

  it('deduplicates divergent PATCH fields into one counted banner and list', () => {
    const conflict = new ApiError('conflict', 'changed', 409, 'req_a');
    const variables = {
      activityId: 'act_a',
      input: { title: 'New', notes: 'A note' },
      ifMatch: 'old',
      changeNames: ['Title', 'Notes'],
    };
    const capture = useSyncStatus.getState().captureMutationError;
    capture(conflict, activityMutationKeys.patch, variables);
    capture(conflict, activityMutationKeys.patch, variables);
    renderBanner();

    expect(screen.getByRole('alert').textContent).toContain(
      "2 changes couldn't be applied.",
    );
    expect(screen.getByText('• Title')).toBeDefined();
    expect(screen.getByText('• Notes')).toBeDefined();
  });
});
