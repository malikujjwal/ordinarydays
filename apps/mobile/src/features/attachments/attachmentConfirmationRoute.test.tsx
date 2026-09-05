import { instant } from '@od/shared/schemas';
import type { Attachment } from '@od/shared/types';
import { act, render, waitFor } from '@testing-library/react';
import { Platform } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ActivityDetailRoute from '../../../app/(app)/activity/[id]';

// The route also mounts the Plan → existing List mutation hook, whose production identity is
// supplied by Expo. This attachment-focused test keeps that native boundary deterministic.
vi.mock('expo-crypto', () => ({ randomUUID: () => 'idem-attachment-route-test' }));

const harness = vi.hoisted(() => ({
  detailProps: undefined as
    | {
        onAddAttachment?: () => void;
        onNotesGuardChange?: (guard: {
          blocked: boolean;
          requestLeave: (leave: () => void) => void;
        }) => void;
      }
    | undefined,
  pickerProps: undefined as
    | { open: boolean; onConfirmed: (attachment: Attachment) => void }
    | undefined,
  invalidate: vi.fn(),
  pullActivity: vi.fn(async () => undefined),
}));

// Navigation is a native boundary; this test exercises attachment reconciliation only.
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ dispatch: vi.fn() }),
  usePreventRemove: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'act_01J0000000000000000000000A' }),
  useRouter: () => ({
    back: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    setParams: vi.fn(),
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: harness.invalidate }),
}));
vi.mock('@/features/activity/components/ActivityDetailScreen', () => ({
  ActivityDetailScreen: (props: { onAddAttachment?: () => void }) => {
    harness.detailProps = props;
    return null;
  },
}));
vi.mock('@/features/attachments/components/AttachmentPickerSheet', () => ({
  AttachmentPickerSheet: (props: {
    open: boolean;
    onConfirmed: (attachment: Attachment) => void;
  }) => {
    harness.pickerProps = props;
    return null;
  },
}));
vi.mock('@/features/lists/components/DestinationSheet', () => ({
  DestinationSheet: () => null,
}));
vi.mock('@/features/lists/components/NewListSheet', () => ({ NewListSheet: () => null }));
vi.mock('@/hooks/useViewer', () => ({ useViewer: vi.fn() }));
vi.mock('@/lib/followUpNavigation', () => ({ followUpNavigation: () => ({}) }));
vi.mock('@/lib/sqlite/nativeState', () => ({
  getActiveNativeState: () => ({ sync: { pullActivity: harness.pullActivity } }),
}));
vi.mock('@/stores/composeDraft', () => ({ useComposeDraft: () => vi.fn() }));

describe('native attachment confirmation reconciliation', () => {
  beforeEach(() => {
    harness.detailProps = undefined;
    harness.pickerProps = undefined;
    harness.invalidate.mockClear();
    harness.pullActivity.mockClear();
  });

  it('never registers browser unload listeners when native notes become dirty', () => {
    const platform = Platform.OS;
    const listener = vi.spyOn(window, 'addEventListener');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    try {
      render(<ActivityDetailRoute />);
      act(() =>
        harness.detailProps?.onNotesGuardChange?.({
          blocked: true,
          requestLeave: () => {},
        }),
      );
      expect(listener.mock.calls.some(([event]) => event === 'beforeunload')).toBe(false);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
      listener.mockRestore();
    }
  });

  it('uses the native targeted-detail path after a photo is confirmed', async () => {
    render(<ActivityDetailRoute />);
    act(() => harness.detailProps?.onAddAttachment?.());
    expect(harness.pickerProps?.open).toBe(true);
    const attachment: Attachment = {
      attachmentId: 'att_01J0000000000000000000000A',
      activityId: 'act_01J0000000000000000000000A',
      key: 'u/usr_01J0000000000000000000000A/photo.jpg',
      contentType: 'image/jpeg',
      byteSize: 1024,
      createdAt: instant.parse('2026-08-19T12:00:00.000Z'),
      schemaVersion: 1,
    };

    act(() => harness.pickerProps?.onConfirmed(attachment));

    await waitFor(() => expect(harness.pullActivity).toHaveBeenCalledOnce());
    expect(harness.pullActivity).toHaveBeenCalledWith({
      kind: 'activity',
      activityId: attachment.activityId,
    });
    expect(harness.invalidate).not.toHaveBeenCalled();
  });
});
