import Constants from 'expo-constants';
import { Text, View } from 'react-native';
import { apiBaseUrl } from '@/lib/apiClient';

/**
 * The scaffold's proof of life, and nothing more.
 *
 * **P0-22 makes this the health screen** — it calls `/v1/health` through `@od/shared` and
 * renders the response on the simulator, in a browser and on a physical iPhone over the
 * LAN, from this one file. What is here now is the half that can be verified without the
 * API: that the app boots, that Expo Router found the route, and that config resolution
 * produced a base URL.
 *
 * The base URL is on screen deliberately rather than in a log. On a physical device it is
 * the single fact that decides whether anything will work, and reading it from the phone is
 * faster than inferring it from a failed request.
 *
 * No colours, spacing or font sizes: the tokens do not exist until P1-22, and inventing
 * literals now is how a design system ends up with values nobody chose
 * (`design-system.md` §9).
 */
export default function Index() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text accessibilityRole="header">
        {Constants.expoConfig?.name ?? 'Ordinary Days'}
      </Text>
      <Text accessibilityLabel={`API base URL ${apiBaseUrl}`}>{apiBaseUrl}</Text>
    </View>
  );
}
