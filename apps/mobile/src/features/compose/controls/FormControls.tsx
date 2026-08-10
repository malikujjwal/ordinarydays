import { MAX_INGREDIENTS, MAX_NOTES_LEN } from '@od/shared/constants';
import {
  Checkbox,
  ChevronRight,
  Chip,
  Close as CloseIcon,
  DatePicker,
  Field,
  IconButton,
  Plus,
  SegmentedControl,
  Text,
  TimePicker,
  Touchable,
  useTheme,
} from '@od/ui';
import { type ReactNode, useState } from 'react';
import { View } from 'react-native';
import {
  type DraftIngredient,
  type DraftReservation,
  newIngredient,
} from '@/features/compose/model/draft';
import {
  MEAL_SLOTS,
  type MealSlot,
  mealSlotLabel,
} from '@/features/compose/model/fields';
import { type ReminderOption, reminderOptions } from '@/features/compose/model/reminders';

/**
 * The controls the five forms share (`activities.md` §3.4, P1-25).
 *
 * "Common controls behave identically across types" is a rule, not an observation — so they
 * are one implementation each rather than six that agree today. The interlocks §3.4 states
 * are enforced here, once: **Time is enabled only when a date is set**, **End time appears
 * only once a start time exists**, and **Reminder needs a date**.
 */

export interface DateControlProps {
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  today: string;
  label?: string;
}

export function DateControl({
  value,
  onChange,
  today,
  label = 'Date',
}: DateControlProps) {
  return (
    <DatePicker
      label={label}
      value={value ?? null}
      today={today}
      onChange={(next) => onChange(next ?? undefined)}
      testID="compose-date"
    />
  );
}

export interface TimeControlProps {
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  /** The date the time hangs off. Absent disables the control (§3.4). */
  date: string | undefined;
  label?: string;
  openAt?: string;
  testID?: string;
}

export function TimeControl({
  value,
  onChange,
  date,
  label = 'Time',
  openAt,
  testID = 'compose-time',
}: TimeControlProps) {
  return (
    <View style={{ gap: 0 }}>
      <TimePicker
        label={label}
        value={value ?? null}
        onChange={(next) => onChange(next ?? undefined)}
        disabled={date === undefined}
        {...(openAt === undefined ? {} : { openAt })}
        testID={testID}
      />
      {date === undefined ? <Hint>Pick a date first.</Hint> : null}
    </View>
  );
}

function Hint({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <View style={{ paddingTop: theme.space[2] }}>
      <Text variant="footnote" color="textSecondary">
        {children}
      </Text>
    </View>
  );
}

export interface LocationControlProps {
  label: string;
  address: string;
  onChange: (patch: { label?: string; address?: string }) => void;
}

/**
 * Free text, both halves. **No geocoding, no autocomplete, no map** — the §3 decision is
 * explicit that v1 collects `label` and `address` as plain text and that `lat`/`lng` are
 * populated only by capture or a pasted maps URL.
 */
export function LocationControl({ label, address, onChange }: LocationControlProps) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[4] }} testID="compose-location">
      {/**
       * Required **only once an address is typed**. `activityLocation` makes `label` the
       * required half, so an address alone cannot be sent — and a field that quietly dropped
       * it would be worse than one that asks for the missing half at the moment it starts
       * mattering.
       */}
      <Field
        label="Location"
        value={label}
        onChangeText={(next) => onChange({ label: next })}
        maxLength={120}
        required={address.trim() !== ''}
        {...(address.trim() !== '' && label.trim() === ''
          ? { hint: 'Name the place so the address has something to belong to.' }
          : {})}
        testID="compose-location-label"
      />
      <Field
        label="Address"
        value={address}
        onChangeText={(next) => onChange({ address: next })}
        maxLength={300}
        testID="compose-location-address"
      />
    </View>
  );
}

export interface ReminderControlProps {
  value: number | undefined;
  onChange: (offsetMinutes: number | undefined) => void;
  date: string | undefined;
  time: string | undefined;
}

/**
 * The reminder offset, as chips (`notifications.md` §3).
 *
 * Chips rather than a `Select`, because `design-system.md` §6 has no `Select` primitive and
 * inventing one for this is a design-system decision rather than a form's. The chips are the
 * same control the date quick options use, which is also why the list stays short: §3.2's
 * untimed list has four entries and §3's timed list nine.
 *
 * **A reminder is only ever your own** — it becomes a `REM#<userId>` row, never a field on the
 * Activity (ADR-047).
 */
export function ReminderControl({ value, onChange, date, time }: ReminderControlProps) {
  const theme = useTheme();
  const disabled = date === undefined;
  const options: readonly ReminderOption[] = reminderOptions(time !== undefined);

  return (
    <View style={{ gap: theme.space[2] }} testID="compose-reminder">
      <Text variant="footnoteStrong" color="textSecondary">
        Reminder
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[3] }}>
        {options.map((option) => (
          <Chip
            key={option.label}
            label={option.label}
            selected={option.offsetMinutes === value}
            disabled={disabled}
            onPress={() => onChange(option.offsetMinutes)}
          />
        ))}
      </View>
      {disabled ? <Hint>Pick a date first.</Hint> : null}
    </View>
  );
}

export interface SlotControlProps {
  value: MealSlot | undefined;
  onChange: (slot: MealSlot) => void;
}

export function SlotControl({ value, onChange }: SlotControlProps) {
  const theme = useTheme();
  const index = value === undefined ? -1 : MEAL_SLOTS.indexOf(value);

  return (
    <View style={{ gap: theme.space[2] }} testID="compose-slot">
      <Text variant="footnoteStrong" color="textSecondary">
        Slot
      </Text>
      <SegmentedControl
        segments={MEAL_SLOTS.map((slot) => ({ label: mealSlotLabel(slot) }))}
        selectedIndex={index}
        onChange={(next) => {
          const slot = MEAL_SLOTS[next];
          if (slot !== undefined) onChange(slot);
        }}
      />
    </View>
  );
}

export interface KindControlProps {
  value: 'movie' | 'show';
  onChange: (kind: 'movie' | 'show') => void;
}

const WATCH_KINDS = ['movie', 'show'] as const;

export function KindControl({ value, onChange }: KindControlProps) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[2] }} testID="compose-kind">
      <Text variant="footnoteStrong" color="textSecondary">
        Kind
      </Text>
      <SegmentedControl
        segments={[{ label: 'Movie' }, { label: 'Show' }]}
        selectedIndex={WATCH_KINDS.indexOf(value)}
        onChange={(next) => onChange(WATCH_KINDS[next] ?? 'movie')}
      />
    </View>
  );
}

export interface ComingSoonControlProps {
  label: string;
  /** The copy naming what fills it, per P1-25 — never a bare disabled control. */
  hint: string;
  testID: string;
}

/**
 * A field from `activities.md` §4 whose behaviour belongs to a later phase.
 *
 * Rendered **disabled with copy**, never hidden. P1-25 is explicit about why: hiding them
 * means the layout changes when the phase that fills them lands, and a user who cannot see
 * that a Plan can have people has been told the product is smaller than it is. Same reasoning
 * P1-26 applied to the detail screen's sections.
 */
export function ComingSoonControl({ label, hint, testID }: ComingSoonControlProps) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[2] }} testID={testID}>
      <Text variant="footnoteStrong" color="textSecondary">
        {label}
      </Text>
      <View
        style={{
          padding: theme.space[5],
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.surfaceSunken,
        }}
      >
        {/*
          `textSecondary`, not `textDisabled`.

          `textDisabled` is deliberately below AA (`contrast.test.ts` asserts it), and that
          exemption is real — WCAG 1.4.3 excuses an **inactive control's own label**. This is
          not that. The hint is the copy naming what will fill the field, and P1-25 requires it
          precisely so this is never a bare disabled control: it is the only thing telling the
          user why the field is inert, which makes it informative prose that happens to sit
          next to a disabled control.

          At 2.53:1 it was unreadable for anyone who needs contrast, and P1-29's axe gate
          reported it as a `serious` violation on the compose route — the first thing that flow
          found. `textSecondary` on `surfaceSunken` is already pinned at AA by
          `contrast.test.ts`, which is the pair the light `surfaceSunken` was nudged for.
        */}
        <Text variant="footnote" color="textSecondary">
          {hint}
        </Text>
      </View>
    </View>
  );
}

export interface IngredientsControlProps {
  rows: DraftIngredient[];
  onChange: (rows: DraftIngredient[]) => void;
}

/**
 * Repeating name + quantity rows, each with a checkbox (`activities.md` §4.2).
 *
 * **The checkboxes default to unchecked and select nothing on their own.** They exist to
 * choose which ingredients a later, explicitly enabled list write would copy — "suggest,
 * never auto-create" — and in Phase 1 that write does not exist at all.
 */
export function IngredientsControl({ rows, onChange }: IngredientsControlProps) {
  const theme = useTheme();

  const update = (index: number, patch: Partial<DraftIngredient>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <View style={{ gap: theme.space[3] }} testID="compose-ingredients">
      <Text variant="footnoteStrong" color="textSecondary">
        Ingredients
      </Text>

      {rows.map((row, index) => (
        <View
          /**
           * The row's own id, not its index. Editing a name would otherwise remount the
           * field being typed into, and removing a row above would slide every checkbox
           * state up by one — which is the rule's actual point rather than a style note.
           */
          key={row.id}
          style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}
        >
          <Checkbox
            checked={row.selected}
            label={`Select ${row.name === '' ? `ingredient ${index + 1}` : row.name}`}
            onChange={(selected) => update(index, { selected })}
          />
          <View style={{ flex: 2 }}>
            <Field
              label={`Ingredient ${index + 1}`}
              hideLabel
              value={row.name}
              onChangeText={(name) => update(index, { name })}
              placeholder="Name"
              maxLength={120}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field
              label={`Quantity ${index + 1}`}
              hideLabel
              value={row.quantity}
              onChangeText={(quantity) => update(index, { quantity })}
              placeholder="Quantity"
              maxLength={120}
            />
          </View>
          <IconButton
            icon={CloseIcon}
            label={`Remove ingredient ${index + 1}`}
            onPress={() => onChange(rows.filter((_, i) => i !== index))}
          />
        </View>
      ))}

      {/* Capped at the schema's own limit, so the row that would be rejected is never
          offered rather than being sent and 400ing on a field the user cannot see. */}
      {rows.length >= MAX_INGREDIENTS ? (
        <Hint>{`That's the most ingredients one meal can hold (${MAX_INGREDIENTS}).`}</Hint>
      ) : (
        <IconButton
          icon={Plus}
          label="Add an ingredient"
          onPress={() => onChange([...rows, newIngredient()])}
        />
      )}
    </View>
  );
}

export interface ReservationControlProps {
  value: DraftReservation;
  onChange: (patch: Partial<DraftReservation>) => void;
}

interface DisclosureGroupProps {
  label: string;
  testID: string;
  children: ReactNode;
}

/** A compact, keyboard- and screen-reader-operable disclosure shared by Event groups. */
function DisclosureGroup({ label, testID, children }: DisclosureGroupProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={{ gap: theme.space[4] }} testID={testID}>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onPress={() => setExpanded((current) => !current)}
        testID={`${testID}-toggle`}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Text variant="footnoteStrong" color="textSecondary">
          {label}
        </Text>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}
        >
          <ChevronRight size={20} color={theme.colors.textSecondary} />
        </View>
      </Touchable>
      {expanded ? <View style={{ gap: theme.space[4] }}>{children}</View> : null}
    </View>
  );
}

/** The Event reservation disclosure group (`activities.md` §4.4). */
export function ReservationControl({ value, onChange }: ReservationControlProps) {
  return (
    <DisclosureGroup label="Reservation" testID="compose-reservation">
      <Field
        label="Reservation name"
        value={value.name}
        onChangeText={(name) => onChange({ name })}
        maxLength={120}
      />
      <Field
        label="Reservation time"
        value={value.time}
        onChangeText={(time) => onChange({ time })}
        placeholder="19:30"
        maxLength={5}
      />
      <Field
        label="Party size"
        value={value.partySize}
        onChangeText={(partySize) => onChange({ partySize })}
        keyboardType="number-pad"
        maxLength={2}
      />
      <Field
        label="Reference"
        value={value.reference}
        onChangeText={(reference) => onChange({ reference })}
        maxLength={120}
      />
    </DisclosureGroup>
  );
}

export interface TicketsAndDetailsControlProps {
  price: string;
  ticketUrl: string;
  organiser: string;
  onChange: (patch: { price?: string; ticketUrl?: string; organiser?: string }) => void;
  fieldErrors: Record<string, string>;
}

/** The Event tickets-and-details disclosure group (`activities.md` §4.4). */
export function TicketsAndDetailsControl({
  price,
  ticketUrl,
  organiser,
  onChange,
  fieldErrors,
}: TicketsAndDetailsControlProps) {
  return (
    <DisclosureGroup label="Tickets & details" testID="compose-tickets-details">
      <Field
        label="Price"
        value={price}
        onChangeText={(nextPrice) => onChange({ price: nextPrice })}
        keyboardType="number-pad"
        placeholder="0.00"
        testID="compose-price"
        {...(fieldErrors.price === undefined ? {} : { error: fieldErrors.price })}
      />
      <Field
        label="Ticket link"
        value={ticketUrl}
        onChangeText={(nextTicketUrl) => onChange({ ticketUrl: nextTicketUrl })}
        keyboardType="url"
        testID="compose-ticket-url"
        {...(fieldErrors.ticketUrl === undefined ? {} : { error: fieldErrors.ticketUrl })}
      />
      <Field
        label="Organiser"
        value={organiser}
        onChangeText={(nextOrganiser) => onChange({ organiser: nextOrganiser })}
        maxLength={120}
        testID="compose-organiser"
      />
    </DisclosureGroup>
  );
}

export interface NotesControlProps {
  value: string;
  onChange: (notes: string) => void;
  error?: string;
}

export function NotesControl({ value, onChange, error }: NotesControlProps) {
  return (
    <Field
      label="Notes"
      value={value}
      onChangeText={onChange}
      multiline
      maxLength={MAX_NOTES_LEN}
      testID="compose-notes"
      {...(error === undefined ? {} : { error })}
    />
  );
}
