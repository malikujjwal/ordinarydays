import Constants from 'expo-constants';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useHealth } from '@/features/health/hooks/useHealth';

/**
 * The health screen: proof that the whole local loop closes, on the simulator, in a browser
 * and on a physical iPhone over the LAN, from this one file.
 *
 * It renders the stage, the SHA, the resolved API base URL and the round-trip time. **The
 * base URL is the important one** — it is what turns "the device shows a spinner forever"
 * into "the device is calling `http://localhost:3000`, which on a phone is the phone" in one
 * glance. It is therefore rendered in every state, including the failing one, and before any
 * request has been made.
 *
 * Layering (`tech-stack.md` §3.2): this route reads no params, owns no data and calls one
 * feature hook. Presentation lives here rather than in a feature component only because the
 * whole screen is under fifty lines; the moment it needs a second one, it splits.
 *
 * **No colours, spacing values or font sizes.** `design-system.md` §10 forbids introducing
 * one that is not a token, and the tokens do not exist as code until P1-22 writes
 * `packages/ui/src/theme/`. Flex layout and the platform's default type are the honest
 * subset — inventing literals now would create values nobody chose and a migration later.
 * The state behaviour and the copy below are `interaction-contract.md` §5's, which is the
 * part of that contract this screen can honour today.
 */
export default function Index() {
  const health = useHealth();

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}>
      <View accessibilityRole="summary" testID="health-screen">
        <Text accessibilityRole="header">
          {Constants.expoConfig?.name ?? 'Ordinary Days'}
        </Text>

        <Field label="API" value={health.baseUrl} testID="health-base-url" />
        <Field label="Status" value={statusText(health)} testID="health-status" />
        <Field label="Stage" value={health.data?.stage ?? '—'} />
        <Field label="SHA" value={health.data?.sha ?? '—'} />
        <Field
          label="Round trip"
          value={health.roundTripMs === undefined ? '—' : `${health.roundTripMs} ms`}
        />

        {health.requestId === undefined ? null : (
          // §5.3: the request id is always shown in small text so a support message can name
          // it. "Small" is a token this screen does not have yet; the label carries it.
          <Field label="Request" value={health.requestId} testID="health-request-id" />
        )}

        {health.status === 'error' ? (
          <Pressable
            onPress={health.refetch}
            accessibilityRole="button"
            accessibilityLabel="Try again"
            testID="health-retry"
          >
            <Text>Try again</Text>
          </Pressable>
        ) : null}
      </View>
    </ScrollView>
  );
}

/**
 * One fact, labelled. `accessibilityLabel` pairs the label with its value so VoiceOver reads
 * "API, http://192.168.1.5:3000" rather than two unrelated strings from two nodes
 * (`interaction-contract.md` §6.2).
 */
function Field({
  label,
  value,
  testID,
}: {
  label: string;
  value: string;
  testID?: string;
}) {
  return (
    <View accessibilityLabel={`${label}, ${value}`} testID={testID}>
      <Text>
        {label}: {value}
      </Text>
    </View>
  );
}

/**
 * §5.3's copy, not the exception's. `pending` says what is happening rather than showing a
 * spinner over a screen that is mostly useful information already.
 */
function statusText(health: ReturnType<typeof useHealth>): string {
  if (health.status === 'pending') return 'Checking…';
  if (health.status === 'error') return health.message ?? "Couldn't load this.";
  return health.isRefetching ? `${health.data?.status ?? 'ok'} · refreshing` : 'ok';
}
