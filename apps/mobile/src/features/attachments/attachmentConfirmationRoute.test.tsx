import { instant } from '@od/shared/schemas';
import type { Attachment } from '@od/shared/types';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ActivityDetailRoute from '../../../app/(app)/activity/[id]';

const harness = vi.hoisted(() => ({
  detailProps: undefined as { onAddAttachment?: () => void } | undefined,
  pickerProps: undefined as
    | { open: boolean; onConfirmed: (attachment: Attachment) => void }
    | undefined,
  invalidate: vi.fn(),
  pullActivity: vi.fn(async () => undefined),
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
