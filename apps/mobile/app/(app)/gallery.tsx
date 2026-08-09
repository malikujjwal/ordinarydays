import {
  AA_BODY,
  Avatar,
  AvatarStack,
  Bowl,
  Button,
  Calendar,
  Card,
  Check,
  Checkbox,
  ChevronRight,
  Chip,
  Clock,
  type ColorScheme,
  colors,
  Diamond,
  EmptyState,
  Field,
  IconButton,
  IconTile,
  MapPin,
  PlayRect,
  Plus,
  ProgressBar,
  Repeat,
  Row,
  ratioOf,
  Search,
  SectionHeader,
  SegmentedControl,
  Skeleton,
  space,
  Text,
  ThemeProvider,
  Ticket,
  Toast,
  type,
  typeAccents,
  useTheme,
} from '@od/ui';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

/**
 * **The token gallery — development only.**
 *
 * Every primitive in every state, both schemes, side by side. It exists for one reason
 * `design-system.md` states outright: the dark values are **derived, not designed**, and
 * §5.1 says to *"eyeball them at the P1-22 token gallery before building screens on them"*.
 *
 * It is not a product screen and never becomes one. It reads no API, has no navigation, and
 * imports nothing from `src/features/`. When the design is signed off it can be deleted
 * without touching a line of product code — that is the test of whether it stayed a gallery.
 */

const TYPES = ['task', 'meal', 'watch', 'event', 'outing', 'custom'] as const;
const TYPE_ICONS = {
  task: Check,
  meal: Bowl,
  watch: PlayRect,
  event: Ticket,
  outing: MapPin,
  custom: Diamond,
} as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[4], paddingTop: theme.space[7] }}>
      <SectionHeader title={title} />
      <View style={{ gap: theme.space[4] }}>{children}</View>
    </View>
  );
}

function Swatch({ name, value, on }: { name: string; value: string; on: string }) {
  const theme = useTheme();
  const ratio = ratioOf(value, on);
  const readable = ratio >= AA_BODY;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}>
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: theme.radius.sm,
          backgroundColor: value,
          borderWidth: 1,
          borderColor: theme.colors.border,
        }}
      />
      <View style={{ flex: 1 }}>
        <Text variant="footnoteStrong">{name}</Text>
        <Text variant="caption" color="textSecondary">
          {`${value} · ${ratio}:1 ${readable ? 'AA' : 'large only'}`}
        </Text>
      </View>
    </View>
  );
}

function Gallery({ scheme }: { scheme: ColorScheme }) {
  const theme = useTheme();
  const [checked, setChecked] = useState(true);
  const [segment, setSegment] = useState(0);
  const [text, setText] = useState('Dinner at Zahav');

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.surface,
        padding: theme.space[5],
      }}
    >
      <Text variant="display" color="textDisplay">
        {scheme === 'light' ? 'Light' : 'Dark'}
      </Text>
      <Text variant="subhead" color="textSecondary">
        Every primitive, every state
      </Text>

      <Section title="Type scale">
        {(Object.keys(type) as (keyof typeof type)[]).map((variant) => (
          <Text key={variant} variant={variant} color="textDisplay">
            {`${variant} — Dinner at Zahav`}
          </Text>
        ))}
      </Section>

      <Section title="Semantic colour">
        {(
          [
            'textDisplay',
            'textPrimary',
            'textSecondary',
            'textDisabled',
            'accent',
            'accentDeep',
            'success',
            'warning',
            'danger',
            'borderStrong',
          ] as const
        ).map((token) => (
          <Swatch
            key={token}
            name={token}
            value={colors[scheme][token]}
            on={colors[scheme].surface}
          />
        ))}
      </Section>

      <Section title="Per-type accent">
        <View style={{ flexDirection: 'row', gap: space[3], flexWrap: 'wrap' }}>
          {TYPES.map((name) => (
            <View key={name} style={{ alignItems: 'center', gap: space[2] }}>
              <IconTile icon={TYPE_ICONS[name]} tint={name} />
              <Text variant="caption" color="textSecondary">
                {name}
              </Text>
              <Text variant="caption" color="textSecondary">
                {`${ratioOf(typeAccents[scheme][name].accent, colors[scheme].surface)}:1`}
              </Text>
            </View>
          ))}
        </View>
      </Section>

      <Section title="Button — every variant and state">
        <View style={{ flexDirection: 'row', gap: space[3], flexWrap: 'wrap' }}>
          <Button label="Save task" onPress={() => {}} />
          <Button label="Secondary" variant="secondary" onPress={() => {}} />
          <Button label="Ghost" variant="ghost" onPress={() => {}} />
          <Button label="Delete" variant="danger" onPress={() => {}} />
        </View>
        <View style={{ flexDirection: 'row', gap: space[3], flexWrap: 'wrap' }}>
          <Button label="Disabled" onPress={() => {}} disabled />
          <Button label="Loading" onPress={() => {}} loading />
          <Button label="Large" size="lg" icon={Plus} onPress={() => {}} />
        </View>
      </Section>

      <Section title="IconButton">
        <View style={{ flexDirection: 'row', gap: space[3] }}>
          <IconButton icon={Plus} label="Add" onPress={() => {}} />
          <IconButton icon={Search} label="Search" variant="filled" onPress={() => {}} />
          <IconButton icon={Calendar} label="Reschedule" onPress={() => {}} disabled />
        </View>
      </Section>

      <Section title="Row — default, completed, with a type marker">
        <View>
          <Row
            title="Gym"
            subtitle="6:00 PM"
            onPress={() => {}}
            leading={
              <Checkbox
                checked={checked}
                onChange={setChecked}
                label="Gym, not completed"
              />
            }
            trailing={<ChevronRight size={20} color={theme.colors.textSecondary} />}
          />
          <Row
            title="Submit insurance form"
            onPress={() => {}}
            dimmed
            struck
            leading={<Checkbox checked label="Submit insurance form, completed" />}
          />
          <Row
            title="Dinner at Zahav"
            subtitle="Zahav"
            accent="outing"
            onPress={() => {}}
            trailing={
              <AvatarStack
                people={[
                  { displayName: 'Alex Rivera' },
                  { displayName: 'Sarah Mendes' },
                  { displayName: 'Mika Okada' },
                  { displayName: 'Ujjwal Malik' },
                  { displayName: 'Ben Ford' },
                ]}
              />
            }
          />
        </View>
      </Section>

      <Section title="The UP NEXT card — the one hero surface">
        <Card hero radius="xl" elevation="e3">
          <Text variant="caption" color="accent">
            Up next · in 2h 15m
          </Text>
          <View style={{ height: space[2] }} />
          <Text variant="bodyStrong" color="textDisplay">
            Dentist
          </Text>
          <Text variant="footnoteStrong" color="accent">
            4:30 PM · Dr Patel
          </Text>
        </Card>
      </Section>

      <Section title="Card + IconTile">
        <Card onPress={() => {}}>
          <View style={{ flexDirection: 'row', gap: space[4] }}>
            <IconTile icon={Ticket} tint="event" />
            <View style={{ flex: 1 }}>
              <Text variant="heading" color="textDisplay">
                Philadelphia Food Festival
              </Text>
              <Text variant="subhead" color="textSecondary">
                Sat, Aug 8 · 12:00 PM
              </Text>
              <View style={{ height: space[2] }} />
              <Chip label="From screenshot" />
            </View>
          </View>
        </Card>
      </Section>

      <Section title="SegmentedControl and Chips">
        <SegmentedControl
          segments={[
            { label: 'Needs a date', count: 2 },
            { label: 'Upcoming', count: 5 },
            { label: 'Past' },
          ]}
          selectedIndex={segment}
          onChange={setSegment}
        />
        <View style={{ flexDirection: 'row', gap: space[3], flexWrap: 'wrap' }}>
          <Chip label="All" selected onPress={() => {}} />
          <Chip label="Personal" onPress={() => {}} />
          <Chip label="Shared" onPress={() => {}} />
          <Chip label="Overdue" tone="warning" icon={Clock} />
          <Chip label="Going" tone="success" />
          <Chip label="Repeats" tone="neutral" icon={Repeat} />
        </View>
      </Section>

      <Section title="ProgressBar — the one sanctioned bar">
        <ProgressBar value={0} label="0 of 6 done" />
        <ProgressBar value={0.34} label="2 of 6 done" />
        <ProgressBar value={1} label="6 of 6 done" />
        <ProgressBar value={0.5} tone="neutral" label="Half" />
      </Section>

      <Section title="Field">
        <Field label="Title" value={text} onChangeText={setText} required />
        <Field
          label="Notes"
          value=""
          onChangeText={() => {}}
          placeholder="Anything worth remembering"
          multiline
          hint="Up to 4000 characters"
        />
        <Field
          label="Title"
          value=""
          onChangeText={() => {}}
          error="A title is required"
        />
        <Field label="Location" value="Zahav" onChangeText={() => {}} disabled />
      </Section>

      <Section title="Avatars">
        <View style={{ flexDirection: 'row', gap: space[4], alignItems: 'center' }}>
          <Avatar displayName="Alex Rivera" size="sm" />
          <Avatar displayName="Sarah Mendes" size="md" />
          <Avatar displayName="Mika Okada" size="lg" />
          <AvatarStack
            people={[
              { displayName: 'Alex Rivera' },
              { displayName: 'Sarah Mendes' },
              { displayName: 'Mika Okada' },
            ]}
            size="md"
          />
        </View>
      </Section>

      <Section title="Toast, EmptyState, Skeleton">
        <Toast message="Task completed" action={{ label: 'Undo', onPress: () => {} }} />
        <Toast message="Could not save. Try again." tone="error" />
        <Skeleton shape="row" count={2} />
        <EmptyState
          heading="Nothing today"
          body="Add something when you decide what it is."
          action={{ label: 'Add a task', onPress: () => {} }}
        />
      </Section>

      <View style={{ height: space[11] }} />
    </View>
  );
}

/**
 * Both schemes side by side at `medium` and above, stacked at `compact` — so a 390 px
 * screenshot shows the phone layout and a 1280 px one shows the pair.
 *
 * **Named `gallery.tsx`, not `_gallery.tsx`.** Expo Router ignores any file whose name starts
 * with an underscore — that prefix is reserved for `_layout` — so the underscored version was
 * not a route at all and rendered a blank page. The dev-only guarantee comes from the
 * `__DEV__` gate below instead, which is the honest mechanism: it is absent from a production
 * bundle rather than merely hard to reach.
 */
export default function TokenGallery() {
  if (!__DEV__) return null;

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap' }}
    >
      <View style={{ flexGrow: 1, flexBasis: 390, minWidth: 320 }}>
        <ThemeProvider scheme="light">
          <Gallery scheme="light" />
        </ThemeProvider>
      </View>
      <View style={{ flexGrow: 1, flexBasis: 390, minWidth: 320 }}>
        <ThemeProvider scheme="dark">
          <Gallery scheme="dark" />
        </ThemeProvider>
      </View>
    </ScrollView>
  );
}
