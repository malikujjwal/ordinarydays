import { z } from 'zod';
import {
  MAX_ADDRESS_LEN,
  MAX_FREE_TEXT_LEN,
  MAX_INGREDIENTS,
  MAX_INGREDIENTS_PER_ADD,
  MAX_LIST_ITEMS,
  MAX_NOTES_LEN,
  MAX_PARTICIPANTS,
  MAX_REMINDERS_PER_USER_PER_ACTIVITY,
  MAX_SOURCE_LABEL_LEN,
  MAX_SOURCE_PROVENANCE_SEGMENTS,
  MAX_TITLE_LEN,
} from '../constants.js';
import {
  activity,
  activityDetails,
  activityLocation,
  activitySchedule,
  activityScheduleInput,
  checkDetailsMatchType,
  checkSchedule,
  participantInput,
  planType,
} from './activity.js';
import {
  cursor,
  instant,
  ulidId,
  userId,
  watchEpisode,
  watchMediaKind,
  watchSeason,
} from './common.js';
import { createRecurrence } from './recurrence.js';
import { reminderInputsForSchedule, reminderOffsetMinutes } from './reminder.js';
import { defaultSlot } from './user.js';

const freeText = z.string().max(MAX_FREE_TEXT_LEN);
const nonBlankText = freeText.refine(
  (value) => value.trim().length > 0,
  'A value is required',
);
const title = z
  .string()
  .trim()
  .min(1, 'A title is required')
  .max(MAX_TITLE_LEN, `A title is at most ${MAX_TITLE_LEN} characters`);
const templateKey = z
  .string()
  .trim()
  .min(1, 'A template is required')
  .max(MAX_FREE_TEXT_LEN);

export const listItemSourceLabel = z.string().max(MAX_SOURCE_LABEL_LEN);
const listItemSourceProvenance = z
  .array(
    z.strictObject({
      activityId: ulidId('act'),
      label: z.string().min(1).max(MAX_SOURCE_LABEL_LEN),
    }),
  )
  .max(MAX_SOURCE_PROVENANCE_SEGMENTS);

export const listItemState = z.enum(['open', 'active', 'done']);

export const stageLabels = z.strictObject({
  open: nonBlankText,
  active: nonBlankText,
  done: nonBlankText,
});

export const itemStateMode = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none') }),
  z.strictObject({ mode: z.literal('checkbox') }),
  z.strictObject({
    mode: z.literal('stages'),
    labels: stageLabels,
    groupByState: z.boolean(),
  }),
]);

const textProgress = z.strictObject({ kind: z.literal('text'), value: nonBlankText });
const episodeProgress = z.strictObject({
  kind: z.literal('episode'),
  mediaKind: watchMediaKind.optional(),
  season: watchSeason.optional(),
  episode: watchEpisode.optional(),
});
export const progressValue = z.discriminatedUnion('kind', [
  textProgress,
  episodeProgress,
]);

export const listPlace = z.strictObject({
  label: nonBlankText,
  address: z.string().max(MAX_ADDRESS_LEN).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

export const listSubItem = z.strictObject({
  id: z.string().min(1).max(MAX_FREE_TEXT_LEN),
  title: nonBlankText,
  secondary: freeText.optional(),
  rank: z.string().min(1),
});

const subItemCollection = z.strictObject({
  entries: z.array(listSubItem).max(MAX_INGREDIENTS),
});

export const listItemFeatures = z.strictObject({
  progress: progressValue.optional(),
  place: listPlace.optional(),
  subItems: subItemCollection.optional(),
});

export const progressFeatureConfig = z.strictObject({
  enabled: z.boolean(),
  kind: z.enum(['text', 'episode']),
});
export const placeFeatureConfig = z.strictObject({ enabled: z.boolean() });
export const subItemsFeatureConfig = z.strictObject({
  enabled: z.boolean(),
  sectionLabel: nonBlankText,
  singularLabel: nonBlankText,
  secondaryLabel: nonBlankText.optional(),
  integration: z.literal('mealIngredients').optional(),
});
export const listFeatureConfig = z.strictObject({
  progress: progressFeatureConfig.optional(),
  place: placeFeatureConfig.optional(),
  subItems: subItemsFeatureConfig.optional(),
});

export const list = z
  .object({
    schemaVersion: z.literal(2),
    listId: ulidId('lst'),
    ownerId: userId,
    templateKey,
    title,
    icon: freeText,
    emptyStateCopy: freeText,
    itemStateMode,
    featureConfig: listFeatureConfig,
    slot: defaultSlot.nullable(),
    /**
     * Derived, never stored: whether the row can be a destination for a given write, e.g.
     * `ingredients`. Optional because it exists only once the API has shaped a response
     * (`services/api/src/handlers/toList.ts`) — a row read from storage has no such
     * attribute, and `.parse`-ing one must not fail for lacking it.
     */
    capabilities: z.strictObject({ ingredients: z.boolean() }).optional(),
    sourceActivityId: ulidId('act').optional(),
    itemCount: z.number().int().nonnegative(),
    doneCount: z.number().int().nonnegative(),
    memberCount: z.number().int().positive(),
    rankVersion: z.number().int().nonnegative(),
    itemVersion: z.number().int().nonnegative().optional(),
    rankRepairId: z.string().min(1).optional(),
    schemaMigrationId: z.string().min(1).optional(),
    archived: z.boolean(),
    updatedAt: instant,
    lastItemActivityAt: instant,
  })
  .meta({ id: 'List' });

export const listIndex = z.object({
  listId: ulidId('lst'),
  userId,
  role: z.enum(['owner', 'member']),
  addedAt: z.string().min(1),
});

export const listMember = z.object({
  listId: ulidId('lst'),
  personId: ulidId('psn'),
  userId: userId.optional(),
  reciprocalPersonId: ulidId('psn').optional(),
  displayName: nonBlankText,
  email: z.email().optional(),
  role: z.literal('member'),
  status: z.enum(['invited', 'active']),
  invitedBy: userId,
  addedAt: z.string().min(1),
  joinedAt: z.string().min(1).optional(),
});

export const listItem = z
  .object({
    itemId: ulidId('itm'),
    listId: ulidId('lst'),
    rank: z.string().min(1),
    itemRevision: z.number().int().nonnegative(),
    title,
    note: z.string().max(MAX_NOTES_LEN).optional(),
    state: listItemState,
    features: listItemFeatures.optional(),
    sourceActivityId: ulidId('act').optional(),
    sourceLabel: listItemSourceLabel.optional(),
    sourceProvenance: listItemSourceProvenance.optional(),
  })
  .meta({ id: 'ListItem' });

export const listItemActivityLink = z.object({
  listId: ulidId('lst'),
  itemId: ulidId('itm'),
  viewerUserId: userId,
  activityId: ulidId('act'),
  linkedAt: z.string().min(1),
});

export const listTemplate = z
  .strictObject({
    templateKey,
    chooserLabel: nonBlankText,
    summary: nonBlankText,
    defaultTitle: title,
    icon: nonBlankText,
    itemStateMode,
    featureConfig: listFeatureConfig,
    slot: defaultSlot.nullable(),
    emptyStateCopy: nonBlankText,
  })
  .meta({ id: 'ListTemplate' });

export const createListInput = z
  .strictObject({
    listId: ulidId('lst').optional(),
    title,
    templateKey,
    sourceActivityId: ulidId('act').optional(),
  })
  .meta({ id: 'CreateListInput' });
export type CreateListInput = z.infer<typeof createListInput>;

const partialFeatureConfig = z
  .strictObject({
    progress: progressFeatureConfig.optional(),
    place: placeFeatureConfig.optional(),
    subItems: subItemsFeatureConfig.optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    'Name at least one feature to change',
  );

export const patchListInput = z
  .strictObject({
    title: title.optional(),
    itemStateMode: itemStateMode.optional(),
    featureConfig: partialFeatureConfig.optional(),
    slot: defaultSlot.nullable().optional(),
    archived: z.boolean().optional(),
    /** Attach-only Plan provenance. A List can acquire this relationship once. */
    sourceActivityId: ulidId('act').optional(),
  })
  .superRefine((value, context) => {
    if (value.sourceActivityId === undefined || Object.keys(value).length === 1) return;
    context.addIssue({
      code: 'custom',
      path: ['sourceActivityId'],
      message: 'Attaching a list to a plan must be its own change',
    });
  })
  .meta({ id: 'PatchListInput' });
export type PatchListInput = z.infer<typeof patchListInput>;

const createListItemFields = {
  itemId: ulidId('itm').optional(),
  title,
  note: z.string().max(MAX_NOTES_LEN).optional(),
  features: listItemFeatures.optional(),
  afterItemId: ulidId('itm').optional(),
} as const;

export const createListItemInput = z
  .strictObject(createListItemFields)
  .meta({ id: 'CreateListItemInput' });
export type CreateListItemInput = z.infer<typeof createListItemInput>;

export const bulkCreateListItemsInput = z
  .strictObject({
    items: z.array(z.strictObject(createListItemFields)).min(1).max(MAX_LIST_ITEMS),
  })
  .meta({ id: 'BulkCreateListItemsInput' });
export type BulkCreateListItemsInput = z.infer<typeof bulkCreateListItemsInput>;

export const listView = list
  .omit({ itemVersion: true, rankRepairId: true, schemaMigrationId: true })
  .meta({ id: 'ListView' });
export const listItemView = listItem
  .omit({ itemRevision: true, sourceProvenance: true })
  .meta({ id: 'ListItemView' });

export const listItemPlanState = z
  .strictObject({
    type: planType,
    status: z.enum(['saved', 'scheduled', 'completed', 'skipped', 'cancelled']),
    schedule: activitySchedule.optional(),
  })
  .meta({ id: 'ListItemPlanState' });

export const listDetailItem = z
  .union([
    z.strictObject({
      item: listItemView,
      viewerLink: listItemActivityLink,
      viewerPlan: listItemPlanState,
    }),
    z.strictObject({ item: listItemView }),
  ])
  .meta({ id: 'ListDetailItem' });

export const listDetail = z
  .object({
    list: listView,
    items: z.array(listDetailItem).optional(),
    nextCursor: cursor.optional(),
  })
  .meta({ id: 'ListDetail' });

export const deletedList = z
  .object({ listId: ulidId('lst') })
  .meta({ id: 'DeletedList' });
export const listListQuery = z
  .strictObject({ cursor: cursor.optional() })
  .meta({ id: 'ListListQuery' });
export const listDetailQuery = z
  .strictObject({ includeItems: z.enum(['true', 'false']).optional() })
  .meta({ id: 'ListDetailQuery' });
export const listItemPageQuery = z
  .strictObject({ cursor: cursor.optional() })
  .meta({ id: 'ListItemPageQuery' });

const listItemFeaturePatch = z.strictObject({
  progress: progressValue.nullable().optional(),
  place: listPlace.nullable().optional(),
  subItems: subItemCollection.nullable().optional(),
});

export const patchListItemInput = z
  .strictObject({
    title: title.optional(),
    state: listItemState.optional(),
    note: z.string().max(MAX_NOTES_LEN).nullable().optional(),
    features: listItemFeaturePatch.optional(),
    afterItemId: ulidId('itm').nullable().optional(),
  })
  .meta({ id: 'PatchListItemInput' });
export type PatchListItemInput = z.infer<typeof patchListItemInput>;

export const undoListOperationInput = z
  .strictObject({ undoToken: z.string().min(1) })
  .meta({ id: 'UndoListOperationInput' });
export type UndoListOperationInput = z.infer<typeof undoListOperationInput>;

export const listUndoResult = z
  .discriminatedUnion('outcome', [
    z.strictObject({
      outcome: z.literal('applied'),
      affectedCount: z.number().int().nonnegative(),
    }),
    z.strictObject({ outcome: z.literal('expired') }),
    z.strictObject({ outcome: z.literal('no_longer_applicable') }),
  ])
  .meta({ id: 'ListUndoResult' });

export const reversibleItemMutation = z
  .strictObject({
    affectedCount: z.number().int().nonnegative(),
    undoToken: z.string().min(1),
    undoExpiresAt: instant,
  })
  .meta({ id: 'ReversibleItemMutation' });

export const listSettingsMutation = z
  .union([
    z.strictObject({
      list: listView,
      undoToken: z.string().min(1),
      undoExpiresAt: instant,
    }),
    z.strictObject({ list: listView }),
  ])
  .meta({ id: 'ListSettingsMutation' });

const scheduleReminderInput = z.strictObject({
  reminderId: ulidId('rem'),
  offsetMinutes: reminderOffsetMinutes,
});
export const scheduleCreationTarget = z.strictObject({
  objectKind: z.literal('plan'),
  type: planType,
});
export const scheduleAudience = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('just_me') }),
  z.strictObject({
    mode: z.literal('selected_people'),
    participants: z.array(participantInput).min(1).max(MAX_PARTICIPANTS),
  }),
]);
export const scheduleListItemInput = z
  .strictObject({
    activityId: ulidId('act'),
    creationTarget: scheduleCreationTarget,
    audience: scheduleAudience,
    title: title.optional(),
    notes: z.string().max(MAX_NOTES_LEN).optional(),
    schedule: activityScheduleInput.optional(),
    recurrence: createRecurrence.optional(),
    reminders: z
      .array(scheduleReminderInput)
      .max(MAX_REMINDERS_PER_USER_PER_ACTIVITY)
      .optional(),
    location: activityLocation.optional(),
    details: activityDetails.optional(),
    attachmentIds: z.array(ulidId('att')).max(20).optional(),
    sourceUrl: z.url().optional(),
  })
  .superRefine((value, ctx) => {
    checkDetailsMatchType(
      {
        type: value.creationTarget.type,
        ...(value.details === undefined ? {} : { details: value.details }),
      },
      ctx,
    );
    if (value.schedule !== undefined) checkSchedule(value.schedule, ctx);
    if (value.recurrence !== undefined && value.schedule === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Repeat needs a scheduled date.',
        path: ['recurrence'],
      });
    }
    if (value.reminders !== undefined) {
      const result = reminderInputsForSchedule(value.schedule).safeParse(value.reminders);
      if (!result.success) {
        for (const issue of result.error.issues) {
          ctx.addIssue({
            code: 'custom',
            message: issue.message,
            path: ['reminders', ...issue.path],
          });
        }
      }
    }
  })
  .meta({ id: 'ScheduleListItemInput' });
export type ScheduleListItemInput = z.infer<typeof scheduleListItemInput>;

export const scheduledListItem = z
  .object({ activity, item: listItemView, viewerLink: listItemActivityLink })
  .meta({ id: 'ScheduledListItem' });

export const addIngredientsToListInput = z
  .strictObject({
    listId: ulidId('lst'),
    ingredients: z
      .array(
        z.strictObject({ ingredientId: ulidId('ing'), itemId: ulidId('itm').optional() }),
      )
      .min(1)
      .max(MAX_INGREDIENTS_PER_ADD),
  })
  .meta({ id: 'AddIngredientsToListInput' });
export type AddIngredientsToListInput = z.infer<typeof addIngredientsToListInput>;

export const addedIngredient = z
  .strictObject({
    ingredientId: ulidId('ing'),
    outcome: z.enum(['created', 'labelled']),
    item: listItemView,
  })
  .meta({ id: 'AddedIngredient' });

export const addIngredientsToListResult = z
  .object({
    listId: ulidId('lst'),
    sourceLabel: listItemSourceLabel,
    ingredients: z.array(addedIngredient),
    activityUpdatedAt: z.iso.datetime(),
  })
  .meta({ id: 'AddIngredientsToListResult' });
export type AddIngredientsToListResult = z.infer<typeof addIngredientsToListResult>;
