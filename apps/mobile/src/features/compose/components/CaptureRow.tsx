import { Button, Field, Text, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { AttachmentPicker } from '@/components/AttachmentPicker';
import type { AttachmentUploadController } from '@/hooks/useAttachmentUpload';

/**
 * Camera · Photos · Link, shown on the form once a target is fixed
 * (`activities.md` §2.3, `ai-capture.md` §6).
 *
 * ## The degraded path is the v1 path
 *
 * Capture returns `501` until Phase 8, and this row is built as the primary experience rather
 * than as an error state (`ai-capture.md` §6.2). Concretely:
 *
 * | Mode | Behaviour |
 * | --- | --- |
 * | Type | **Silent.** No banner, no toast, no suggestion. Handled by the form not calling capture at all — there is nothing here for the text path. |
 * | Camera / Photos | The image is picked, **uploaded** (P3-41) and shown with its progress. One line: `Add the details yourself for now.` The save carries its id. |
 * | Link | The URL is retained on `sourceUrl` regardless, and the user fills the form in. |
 *
 * There is deliberately **no disabled "AI" button and no `Coming soon` label** — §6.2 bans
 * both. These are attachment and source-URL controls, which are real affordances; the
 * capability that is missing is simply invisible.
 *
 * Nothing here can reach the target. The picker yields attachment ids and the link a URL,
 * and the store has no action that would let either become an object kind or a Plan kind.
 */
export interface CaptureRowProps {
  sourceUrl: string | undefined;
  onSourceUrlChange: (url: string) => void;
  /** The form's uploads, owned by the screen so a kind change cannot lose one in flight. */
  attachments: AttachmentUploadController;
}

/** §6.1's copy for the image and link paths. The text path stays silent. */
const MANUAL_ENTRY = 'Add the details yourself for now.';

export function CaptureRow({
  sourceUrl,
  onSourceUrlChange,
  attachments,
}: CaptureRowProps) {
  const theme = useTheme();
  const [linkOpen, setLinkOpen] = useState(sourceUrl !== undefined && sourceUrl !== '');

  return (
    <View style={{ gap: theme.space[4] }}>
      {/**
       * The picker renders `Camera` (native only) and `Photos`, then one row per picked
       * image; `Ready`, not `Added`, because nothing is attached until the save lands.
       */}
      <AttachmentPicker controller={attachments} doneLabel="Ready" testID="capture" />

      {/**
       * `Add a link`, not `Link` — the control and the field it reveals would otherwise
       * share an accessible name, and a screen-reader user tabbing the form would meet
       * "Link, button" and "Link, edit text" with nothing to tell them apart. The mode is
       * still called Link in `activities.md` §2.3; this is the button that opens it.
       */}
      <View style={{ flexDirection: 'row', gap: theme.space[3], flexWrap: 'wrap' }}>
        <Button
          label="Add a link"
          variant="secondary"
          onPress={() => setLinkOpen(true)}
          testID="capture-link"
        />
      </View>

      {attachments.uploads.length === 0 ? null : (
        <Text variant="footnote" color="textSecondary" testID="capture-manual-entry">
          {MANUAL_ENTRY}
        </Text>
      )}

      {linkOpen ? (
        <Field
          label="Link"
          value={sourceUrl ?? ''}
          onChangeText={onSourceUrlChange}
          placeholder="https://"
          keyboardType="url"
          hint={MANUAL_ENTRY}
          testID="capture-source-url"
        />
      ) : null}
    </View>
  );
}
