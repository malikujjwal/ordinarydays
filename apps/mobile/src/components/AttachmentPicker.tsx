import { Button, ProgressBar, Text, useTheme } from '@od/ui';
import { Image, Platform, View } from 'react-native';
import type {
  AttachmentUpload,
  AttachmentUploadController,
} from '@/hooks/useAttachmentUpload';
import { QUEUED_LABEL } from '@/lib/uploadPolicy';

/**
 * The picker and its progress rows (P3-41): `Camera` (native only — a browser tab has no
 * camera path worth the code, `tech-stack.md` platform table) and `Photos`, the pre-check
 * refusal under them, and one row per picked image showing where its upload is.
 *
 * The row is the placeholder §P3-41 describes: it appears the moment the image is picked,
 * from the local URI, and its state line resolves when the last step returns. Nothing here
 * fabricates a media URL — the thumbnail is the device's own copy of the picture.
 */
export interface AttachmentPickerProps {
  controller: AttachmentUploadController;
  /**
   * What a finished upload says. `Added` on a plan (it is linked); on a creation form the
   * photo rides with the save, so `Ready` is the honest word — nothing is attached yet.
   */
  doneLabel?: 'Added' | 'Ready';
  testID?: string;
}

function statusLine(upload: AttachmentUpload, doneLabel: 'Added' | 'Ready'): string {
  switch (upload.status) {
    case 'queued':
      return QUEUED_LABEL;
    case 'uploading':
      return `Uploading ${Math.round(upload.progress * 100)}%`;
    case 'confirming':
      return 'Finishing…';
    case 'done':
      return doneLabel;
    case 'failed':
      return upload.error ?? "Couldn't upload that photo.";
  }
}

export function AttachmentPicker({
  controller,
  doneLabel = 'Added',
  testID = 'attachment-picker',
}: AttachmentPickerProps) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.space[4] }} testID={testID}>
      <View style={{ flexDirection: 'row', gap: theme.space[3], flexWrap: 'wrap' }}>
        {Platform.OS === 'web' ? null : (
          <Button
            label="Camera"
            variant="secondary"
            onPress={() => void controller.pick('camera')}
            testID={`${testID}-camera`}
          />
        )}
        <Button
          label="Photos"
          variant="secondary"
          onPress={() => void controller.pick('library')}
          testID={`${testID}-photos`}
        />
      </View>

      {controller.refusal === undefined ? null : (
        <Text variant="footnote" color="danger" testID={`${testID}-refusal`}>
          {controller.refusal}
        </Text>
      )}

      {controller.uploads.map((upload, index) => {
        const line = statusLine(upload, doneLabel);
        const position = `Photo ${index + 1} of ${controller.uploads.length}`;
        return (
          <View
            key={upload.localId}
            accessible
            accessibilityLabel={`${position}, ${line}`}
            style={{ flexDirection: 'row', gap: theme.space[4], alignItems: 'center' }}
            testID={`${testID}-row-${upload.localId}`}
          >
            <Image
              accessibilityIgnoresInvertColors
              source={{ uri: upload.uri }}
              style={{
                width: 56,
                height: 56,
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.surfaceSunken,
                opacity: upload.status === 'done' ? 1 : 0.7,
              }}
              resizeMode="cover"
            />
            <View style={{ flex: 1, gap: theme.space[2] }}>
              <Text
                variant="footnote"
                color={upload.status === 'failed' ? 'danger' : 'textSecondary'}
                testID={`${testID}-status-${upload.localId}`}
              >
                {line}
              </Text>
              {upload.status === 'uploading' ? (
                <ProgressBar
                  value={upload.progress}
                  label={line}
                  testID={`${testID}-progress-${upload.localId}`}
                />
              ) : null}
              {upload.requestId === undefined ? null : (
                <Text variant="caption" color="textMuted" selectable>
                  {upload.requestId}
                </Text>
              )}
            </View>
            {upload.status === 'failed' ? (
              <Button
                label="Retry"
                variant="ghost"
                onPress={() => controller.retry(upload.localId)}
                testID={`${testID}-retry-${upload.localId}`}
              />
            ) : null}
            {/**
             * Removing a row before it is linked is a local act — the `tmp/` object, if any,
             * is the one-day lifecycle's to clean. Once confirmed against a plan the photo is
             * an attachment, and taking it off is P3-42's `Delete`, which confirms.
             */}
            {upload.status === 'done' && upload.attachment !== undefined ? null : (
              <Button
                label="Remove"
                variant="ghost"
                onPress={() => controller.remove(upload.localId)}
                testID={`${testID}-remove-${upload.localId}`}
              />
            )}
          </View>
        );
      })}
    </View>
  );
}
