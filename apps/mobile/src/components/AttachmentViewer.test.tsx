import type { Instant } from '@od/shared/time';
import type { Attachment } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentViewer } from './AttachmentViewer';

const photo: Attachment = {
  attachmentId: 'att_01J8XKQ2M4N5P6R7S8T9V0W1A1',
  activityId: 'act_01J0000000000000000000000A',
  key: 'u/usr_01J0000000000000000000000B/photo.jpg',
  contentType: 'image/jpeg',
  byteSize: 1024,
  createdAt: '2026-08-08T10:00:00.000Z' as Instant,
  schemaVersion: 1,
};

describe('AttachmentViewer', () => {
  it('keeps the close target below a tall device safe area and closes on one press', () => {
    const onClose = vi.fn();
    render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 393, height: 852 },
          insets: { top: 59, right: 0, bottom: 34, left: 0 },
        }}
      >
        <ThemeProvider scheme="light">
          <AttachmentViewer
            open
            attachments={[photo]}
            initialIndex={0}
            onClose={onClose}
          />
        </ThemeProvider>
      </SafeAreaProvider>,
    );

    expect(
      screen
        .getByTestId('attachment-viewer-caption')
        .parentElement?.getAttribute('style'),
    ).toContain('top: 51px');

    fireEvent.click(screen.getByTestId('attachment-viewer-close'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
