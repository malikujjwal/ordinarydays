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
  DatePicker,
  Diamond,
  DisclosureRow,
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
  RowGroup,
  ratioOf,
  ScreenShell,
  Search,
  SectionHeader,
  SegmentedControl,
  SettingRow,
  Skeleton,
  space,
  Text,
  ThemeProvider,
  TimePicker,
  Toast,
  type,
  typeAccents,
  useTheme,
  type WallDate,
  type WallTime,
} from '@od/ui';
import { format } from 'date-fns';
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

const TYPES = ['task', 'meal', 'watch', 'event', 'custom'] as const;
const TYPE_ICONS = {
  task: Check,
  meal: Bowl,
  watch: PlayRect,
  event: MapPin,
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

/**
 * The gallery's "today". Read once at module load rather than per render, because a value
 * that changed mid-session would make the date chips disagree with themselves — and because
 * this is the one place in the repository allowed to ask what day it is on the client's
 * behalf: `DatePicker` takes `today` as a prop precisely so it never has to.
 */
const TODAY: WallDate = format(new Date(), 'yyyy-MM-dd');

function Gallery({ scheme }: { scheme: ColorScheme }) {
  const theme = useTheme();
  const [checked, setChecked] = useState(true);
  const [segment, setSegment] = useState(0);
  const [text, setText] = useState('Dinner at Zahav');
  const [date, setDate] = useState<WallDate | null>(null);
  const [time, setTime] = useState<WallTime | null>('19:00');

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

      <Section title="Surfaces">
        <View style={{ flexDirection: 'row', gap: space[3], flexWrap: 'wrap' }}>
          {(
            [
              'surface',
              'surfaceRaised',
              'surfaceRaised2',
              'surfaceOverlay',
              'surfaceInput',
              'surfaceSunken',
              'accentSurface',
              'successSurface',
              'warningSurface',
            ] as const
          ).map((token) => (
            <View key={token} style={{ alignItems: 'center', gap: space[2] }}>
              <View
                style={{
                  width: 64,
                  height: 44,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: colors[scheme].border,
                  backgroundColor: colors[scheme][token],
                }}
              />
              <Text variant="caption" color="textSecondary">
                {token}
              </Text>
            </View>
          ))}
        </View>
      </Section>

      <Section title="Semantic colour">
        {(
          [
            'textDisplay',
            'textPrimary',
            'textSecondary',
            'textMuted',
            'textDisabled',
            'accent',
            'accentDeep',
            'accentControl',
            'accentBorder',
            'success',
            'warning',
            'danger',
            'border',
            'borderSubtle',
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
            accent="event"
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

      {/**
       * **The layout layer (P2-51).** Every state of every shared layout component, which is
       * what makes drift visible rather than discovered on a screen six weeks later. If a
       * screen needs a row shape that is not on this page, the shape is added here first.
       */}
      <Section title="SettingRow — one measure, every state">
        <RowGroup label="Navigates">
          <SettingRow
            label="Notes"
            summary="Check-in is after 3 PM."
            onPress={() => {}}
          />
          <SettingRow
            label="Notes"
            summary="A note long enough that it has to be truncated rather than wrapped, because a collapsed row summarises and never renders the whole value"
            onPress={() => {}}
          />
          <SettingRow label="Related plan" summary="None" onPress={() => {}} />
        </RowGroup>

        <RowGroup label="States a setting">
          <SettingRow label="Repeat" value="Every 3 days" onPress={() => {}} />
          <SettingRow label="Reminder" value="15 minutes before" onPress={() => {}} />
          <SettingRow label="Time" value="6:00 PM" onPress={() => {}} />
        </RowGroup>

        <RowGroup label="Picks one of a set">
          <SettingRow label="Today" value="Wed, Aug 12" onPress={() => {}} />
          <SettingRow label="Tomorrow" value="Thu, Aug 13" selected onPress={() => {}} />
          <SettingRow label="Pick a date" onPress={() => {}} />
        </RowGroup>

        <RowGroup label="Toggles — checkbox role, not button">
          <SettingRow label="At the time" role="checkbox" selected onPress={() => {}} />
          <SettingRow label="15 minutes before" role="checkbox" onPress={() => {}} />
          <SettingRow label="1 day before" role="checkbox" disabled onPress={() => {}} />
        </RowGroup>

        <RowGroup label="Inert — not a control at all">
          <SettingRow
            label="People"
            summary="Sharing and participants"
            note="Coming later"
          />
          <SettingRow
            label="Attachments"
            summary="Photos and files"
            note="Coming later"
          />
        </RowGroup>
      </Section>

      <Section title="DisclosureRow — opens in place">
        <RowGroup>
          <DisclosureRow
            label="Notes"
            summary="Tap to open under its own label"
            testID="gallery-disclosure"
          >
            <Text variant="body" color="textSecondary">
              Content the user edits opens here. A bounded set of choices opens in a Sheet
              instead — expanded in place it pushes every row beneath it down the screen.
            </Text>
          </DisclosureRow>
          <SettingRow label="Repeat" value="Does not repeat" onPress={() => {}} />
        </RowGroup>
      </Section>

      {/**
       * **`ScreenShell`'s footer slot (P2-43).** Bounded to a fixed height so the real
       * component renders inside the gallery's own scroll; everything about it — the gutters,
       * the top rule, the safe-area clearance under the button — is the shipped one.
       */}
      <Section title="ScreenShell — the pinned named write">
        <View style={{ height: 220 }}>
          <ScreenShell
            measure="reading"
            footer={<Button label="Save task" size="lg" fullWidth onPress={() => {}} />}
          >
            <Text variant="body" color="textSecondary">
              The body scrolls; the write does not. A named write that scrolls away is a
              named write the user has to go looking for.
            </Text>
          </ScreenShell>
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
            <IconTile icon={MapPin} tint="event" />
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

      <Section title="DatePicker and TimePicker">
        <DatePicker label="Date" value={date} onChange={setDate} today={TODAY} />
        <TimePicker label="Time" value={time} onChange={setTime} />
        {/* The disabled state, shown so it stays reviewable. **The creation forms no longer
            reach it** (P2-43): Time is absent until a date exists rather than greyed with
            `Pick a date first.` beside it. */}
        <TimePicker label="End time" value={null} onChange={() => {}} disabled />
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
