/**
 * The `@od/shared/types` public surface.
 *
 * A barrel and nothing else: the literal unions live in `vocabulary.ts` and the entity
 * interfaces in a file each, so that an entity can import the vocabulary without importing
 * the barrel that re-exports it. That cycle is what `no-circular` catches.
 *
 * `data-model.md` §4 calls these the authoritative shapes; the Zod schemas in `../schemas/`
 * are the runtime check, and a both-ways `expectTypeOf` in each schema's test pins them
 * together — really pins them, since P1-06's `tsconfig.test.json` typechecks the assertions.
 */
export type {
  Activity,
  ActivityBase,
  ActivityDetails,
  ActivityFilter,
  ActivityListItem,
  ActivityLocation,
  ActivitySchedule,
  EventReservation,
  MealIngredient,
  PlanActivity,
  TaskActivity,
} from './activity.js';
/** Its own file so ADR-047's guard on `activity.ts` stays tight — see the note there. */
export type {
  ActivityDetail,
  ActivityDetailTarget,
  OccurrenceDetailProjection,
} from './activityDetail.js';
export type {
  ActivityAgendaData,
  ActivityAgendaRow,
  AgendaCapabilities,
  AgendaData,
  AgendaDay,
  AgendaIncludeToken,
  AgendaItem,
  AgendaItemStatus,
  AgendaParticipantAvatar,
  AgendaProjectionVersion,
  AgendaWarning,
} from './agenda.js';
export { assertNever } from './assert.js';
export type { DeletedList } from './deletedList.js';
export type { Device, DevicePlatform, RegisterDeviceInput } from './device.js';
export type {
  List,
  ListBehaviour,
  ListCapabilities,
  ListIndex,
  ListItem,
  ListItemActivityLink,
  ListItemDetails,
  ListMember,
  ListTemplate,
} from './list.js';
export type { ListDetail } from './listDetail.js';
export type { ListDetailItem } from './listDetailItem.js';
export type { ListItemView } from './listItemView.js';
export type { ListSettingsMutation } from './listSettingsMutation.js';
export type { ListView } from './listView.js';
export type { Occurrence, OccurrenceStatus } from './occurrence.js';
export type {
  MonthNumber,
  Recurrence,
  RecurrenceFreq,
  RecurrenceMode,
  RecurrenceSegment,
  Weekday,
} from './recurrence.js';
export type { Reminder } from './reminder.js';
export type { ReversibleItemMutation } from './reversibleItemMutation.js';
export type { ActivityScope } from './scope.js';
export {
  activityScope,
  occurrenceScope,
  scopeDate,
  scopeFromWire,
  scopeToWire,
  targetsWholeSeries,
} from './scope.js';
export type {
  DefaultSlot,
  OnboardingState,
  PatchUserInput,
  QuietHours,
  User,
  WeekStart,
} from './user.js';
export type {
  ActivityObjectKind,
  ActivityOutcome,
  ActivityStatus,
  ActivityType,
  ActivityVisibility,
  Gsi1Bucket,
  PlanType,
} from './vocabulary.js';
