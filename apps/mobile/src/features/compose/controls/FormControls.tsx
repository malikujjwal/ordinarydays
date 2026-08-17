import { MAX_INGREDIENTS, MAX_NOTES_LEN } from '@od/shared/constants';
import {
  Checkbox,
  Close as CloseIcon,
  DatePicker,
  DisclosureRow,
  Field,
  IconButton,
  Plus,
  SegmentedControl,
  SettingRow,
  Sheet,
  Text,
  TimePicker,
  useTheme,
} from '@od/ui';
import { useState } from 'react';
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
 * are one implementation each rather than six that agree today.
 *
 * **The §3.4 interlocks are no longer expressed here** (P2-43). Time, Reminder and Repeat used
 * to render disabled with `Pick a date first.` beside them; they are now simply absent until a
 * date exists, and the one place that decides it is `fieldRegions` in `model/fields.ts`. A
 * control that knew how to grey itself out is a control that can be asked to, so the knowledge
 * lives with the field tables instead.
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
  label?: string;
  openAt?: string;
  testID?: string;
}

/**
 * The time, once there is a day for it to sit on.
 *
 * It takes no `date` any more: §3.4's "only enabled when a date is set" is now "only rendered
 * when a date is set", and the field table decides that. A control that could be handed a
 * missing date is a control that can be rendered inert.
 */
export function TimeControl({
  value,
  onChange,
  label = 'Time',
  openAt,
  testID = 'compose-time',
}: TimeControlProps) {
  return (
    <TimePicker
      label={label}
      value={value ?? null}
      onChange={(next) => onChange(next ?? undefined)}
      {...(openAt === undefined ? {} : { openAt })}
      testID={testID}
    />
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
  time: string | undefined;
}

/**
 * The reminder offset (`notifications.md` §3, §4.1's `Select` control).
 *
 * **One row, in every state, matching Repeat** — founder decision, 2026-08-16. The first P2-43
 * build made this a `+ Reminder` action until an offset was set, per the task's own prose; the
 * founder's report was that it "is not looking good" and that the version matching Repeat was
 * better. Two adjacent controls that do the same thing — state a setting, open a menu — reading
 * as two different kinds of control was the whole of it, and §0's component-family rule says the
 * same thing in the abstract.
 *
 * `Off` in the value slot is a **state report, not a selection**: no `REM#` row is written and
 * nothing is pre-chosen, exactly as `Repeat` reads `Does not repeat` before any rule exists. The
 * menu underneath still opens with nothing ticked.
 *
 * The options open in a **bottom-anchored menu over a dimmed form**, which is what the frames
 * draw and what §4.1 has always called this control. `Off` is a real row in it, so removing a
 * reminder is the same gesture as setting one.
 *
 * **A reminder is only ever your own** — it becomes a `REM#<userId>` row, never a field on the
 * Activity (ADR-047). Nothing here reads the title: `remind me` in the text of a draft cannot
 * reach this control (`interaction-contract.md` §1a.3).
 */
export function ReminderControl({ value, onChange, time }: ReminderControlProps) {
  const [open, setOpen] = useState(false);
  const options: readonly ReminderOption[] = reminderOptions(time !== undefined);
  const current = options.find((option) => option.offsetMinutes === value);

  return (
    <View testID="compose-reminder">
      <SettingRow
        label="Reminder"
        value={value === undefined ? 'Off' : (current?.label ?? 'Off')}
        opens
        onPress={() => setOpen(true)}
        testID="compose-reminder-row"
      />

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Reminder"
        detent="medium"
        testID="compose-reminder-menu"
      >
        <View>
          {options.map((option) => (
            <SettingRow
              key={option.label}
              label={option.label}
              /**
               * **Nothing is ticked until the user has set one.** `Off` and "no reminder" are
               * the same `undefined`, so a bare equality check put a check and an accent tint
               * on `Off` the moment the menu opened — a menu that answered itself before it was
               * asked, which is the one thing progressive disclosure may never do
               * (`CLAUDE.md` rule 2).
               */
              selected={value !== undefined && option.offsetMinutes === value}
              onPress={() => {
                onChange(option.offsetMinutes);
                setOpen(false);
              }}
              testID={`compose-reminder-option-${option.offsetMinutes ?? 'off'}`}
            />
          ))}
        </View>
      </Sheet>
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

/**
 * The Event reservation disclosure group (`activities.md` §4.4).
 *
 * `DisclosureRow` rather than the local toggle this used to hand-roll: P2-51's gate is that a
 * screen may not build its own row, and the hand-rolled one had its own type, its own chevron
 * colour and its own spacing. It carries no summary — an empty reservation has no current
 * content to report, and a line of copy describing the form would be exactly the invented
 * summary that rule exists to prevent.
 */
export function ReservationControl({ value, onChange }: ReservationControlProps) {
  return (
    <DisclosureRow label="Reservation" testID="compose-reservation">
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
    </DisclosureRow>
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
    <DisclosureRow label="Tickets & details" testID="compose-tickets-details">
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
    </DisclosureRow>
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
