import { Button, Field, Text, useTheme } from '@od/ui';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Image, Platform, View } from 'react-native';

/**
 * Camera · Photos · Link, shown on the form once a target is fixed
 * (`activities.md` §2.3, `ai-capture.md` §6).
 *
 * ## The degraded path is the v1 path
 *
 * Capture returns `501` until Phase 8, and this row is built as the primary experience rather
 * than as an error state (`ai-capture.md` §6.2). Concretely:
 *
 * | Mode | Phase 1 behaviour |
 * | --- | --- |
 * | Type | **Silent.** No banner, no toast, no suggestion. Handled by the form not calling capture at all — there is nothing here for the text path. |
 * | Camera / Photos | The image is picked and shown locally. One line: `Add the details yourself for now.` |
 * | Link | The URL is retained on `sourceUrl` regardless, and the user fills the form in. |
 *
 * There is deliberately **no disabled "AI" button and no `Coming soon` label** — §6.2 bans
 * both. These are attachment and source-URL controls, which are real Phase 1 affordances;
 * the capability that is missing is simply invisible.
 *
 * Nothing here can reach the target. The callbacks write an image URI and a URL, and the
 * store has no action that would let either become an object kind or a Plan kind.
 */
export interface CaptureRowProps {
  sourceUrl: string | undefined;
  onSourceUrlChange: (url: string) => void;
  attachmentUri: string | undefined;
  onAttach: (uri: string) => void;
  onClearAttachment: () => void;
}

/** §6.1's copy for the image and link paths. The text path stays silent. */
const MANUAL_ENTRY = 'Add the details yourself for now.';

export function CaptureRow({
  sourceUrl,
  onSourceUrlChange,
  attachmentUri,
  onAttach,
  onClearAttachment,
}: CaptureRowProps) {
  const theme = useTheme();
  const [linkOpen, setLinkOpen] = useState(sourceUrl !== undefined && sourceUrl !== '');
  const [pickError, setPickError] = useState<string | undefined>(undefined);

  /**
   * `expo-image-picker` returns `canceled: true` rather than throwing when the user backs
   * out, and a cancel is a complete and correct outcome — no error, no message.
   */
  async function pick(source: 'camera' | 'library') {
    setPickError(undefined);
    const permission =
      source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      setPickError(
        source === 'camera'
          ? 'Ordinary Days needs camera access to take a photo.'
          : 'Ordinary Days needs photo access to pick an image.',
      );
      return;
    }

    const result =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync({ quality: 0.8 })
        : await ImagePicker.launchImageLibraryAsync({ quality: 0.8 });

    if (result.canceled) return;
    const uri = result.assets[0]?.uri;
    if (uri !== undefined) onAttach(uri);
  }

  return (
    <View style={{ gap: theme.space[4] }}>
      <View style={{ flexDirection: 'row', gap: theme.space[3], flexWrap: 'wrap' }}>
        {/* No camera in a browser tab; the control is absent rather than present-and-broken. */}
        {Platform.OS === 'web' ? null : (
          <Button
            label="Camera"
            variant="secondary"
            onPress={() => void pick('camera')}
            testID="capture-camera"
          />
        )}
        <Button
          label="Photos"
          variant="secondary"
          onPress={() => void pick('library')}
          testID="capture-photos"
        />
        {/**
         * `Add a link`, not `Link` — the control and the field it reveals would otherwise
         * share an accessible name, and a screen-reader user tabbing the form would meet
         * "Link, button" and "Link, edit text" with nothing to tell them apart. The mode is
         * still called Link in `activities.md` §2.3; this is the button that opens it.
         */}
        <Button
          label="Add a link"
          variant="secondary"
          onPress={() => setLinkOpen(true)}
          testID="capture-link"
        />
      </View>

      {pickError === undefined ? null : (
        <Text variant="footnote" color="danger">
          {pickError}
        </Text>
      )}

      {attachmentUri === undefined ? null : (
        <View style={{ gap: theme.space[3] }} testID="capture-attachment">
          <Image
            accessibilityIgnoresInvertColors
            accessibilityLabel="The photo you picked"
            source={{ uri: attachmentUri }}
            style={{
              width: '100%',
              height: 160,
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.surfaceSunken,
            }}
            resizeMode="cover"
          />
          <Text variant="footnote" color="textSecondary">
            {MANUAL_ENTRY}
          </Text>
          <Button
            label="Remove photo"
            variant="ghost"
            onPress={onClearAttachment}
            testID="capture-remove-attachment"
          />
        </View>
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
