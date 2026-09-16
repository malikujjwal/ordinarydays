import type { CreationTarget } from '@od/shared/client';
import {
  ApiError,
  addIngredientsToList,
  createListItem,
  scheduleListItem,
} from '@od/shared/client';
import type { List } from '@od/shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import {
  type DraftFields,
  toScheduleListItemInput,
} from '@/features/compose/model/targets';
import { apiClient } from '@/lib/apiClient';
import { describeApiFailure } from '@/lib/apiFailure';
import { INGREDIENTS_CHANGED } from '@/lib/destinationCopy';
import { validateIngredientDestination } from '@/lib/ingredientDestinationValidation';
import {
  INGREDIENT_DESTINATION_UNAVAILABLE,
  isIngredientDestinationUnavailable,
} from '@/lib/ingredientDestinationValidationError';
import { newLocalId } from '@/lib/localIds';
import { listMutationKeys } from '@/lib/mutationKeys';
import { activityKey, LISTS_KEY } from '@/lib/queryKeys';
import { useComposeDraft } from '@/stores/composeDraft';
import { useToast } from '@/stores/toast';

/**
 * The creation form's two list bridges (P3-43), each behind a button that names both
 * writes and the destination, and each running only after that tap.
 *
 * - **Meal → ingredients** (`Save plan and add 3 items to Groceries`, §9.2 step 4): the
 *   plan's own save first, then P3-17's activity-scoped action with the selected stable
 *   `ing_` ids and the visible `listId`. It never constructs provenance or calls the
 *   ordinary bulk route. A refused action is the whole write refused (§5.3).
 * - **Watch → item + Plan** (`Save plan and add Severance to Watch Later`, §8.1): the
 *   ListItem is written first, then the reviewed Plan goes through P3-13's `/schedule`
 *   bridge from that item — creating the Plan and the caller's viewer-local `LNK#` — with
 *   `audience: { mode: 'just_me' }` **supplied here by the caller** (Phase 6 maps the
 *   reviewed People field), never defaulted inside the bridge or inferred from the item.
 *   The bridge carries a client-minted `activityId` and its own idempotency key, distinct
 *   from the item-create key, so a replay cannot create a second Plan. If the item lands and
 *   the schedule fails, the item remains a valid saved ListItem and the error names it.
 *
 * Web only for the Watch chain in this phase: the native durable version (item intent +
 * dependent bridge intent, `Plan will finish syncing`) needs the SQLite coordinator to chain
 * two intents, which ADR-057's freeze leaves to the device-verified pass — recorded.
 */
export interface ListBridge {
  readonly addIngredients: (
    activityId: string,
    listId: string,
    ingredientIds: readonly string[],
  ) => Promise<boolean>;
  readonly saveWatchItemAndPlan: (
    target: CreationTarget,
    fields: DraftFields,
    timezone: string,
    destination: { readonly list: List },
  ) => Promise<boolean>;
  readonly isSaving: boolean;
}

export function useListBridge(): ListBridge {
  const queryClient = useQueryClient();
  const takeIdempotencyKey = useComposeDraft((s) => s.takeIdempotencyKey);
  const takeActivityId = useComposeDraft((s) => s.takeActivityId);
  const details = useComposeDraft((s) => s.details);

  const ingredients = useMutation({
    mutationFn: async (input: {
      activityId: string;
      listId: string;
      ingredientIds: readonly string[];
    }) => {
      await validateIngredientDestination(input.listId);
      return addIngredientsToList(
        apiClient,
        input.activityId,
        {
          listId: input.listId,
          ingredients: input.ingredientIds.map((ingredientId) => ({ ingredientId })),
        },
        randomUUID(),
      );
    },
  });

  const schedule = useMutation({
    // P3-34's wire tag: the process-wide MutationCache seam projects the new plan from it.
    mutationKey: listMutationKeys.itemSchedule,
    mutationFn: (input: {
      listId: string;
      itemId: string;
      body: Parameters<typeof scheduleListItem>[3];
      idempotencyKey: string;
    }) =>
      scheduleListItem(
        apiClient,
        input.listId,
        input.itemId,
        input.body,
        input.idempotencyKey,
      ),
  });

  return {
    addIngredients: async (activityId, listId, ingredientIds) => {
      try {
        await ingredients.mutateAsync({ activityId, listId, ingredientIds });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: activityKey(activityId) }),
          queryClient.invalidateQueries({ queryKey: LISTS_KEY }),
        ]);
        return true;
      } catch (error) {
        const destinationUnavailable = isIngredientDestinationUnavailable(error);
        const changed = error instanceof ApiError && error.status === 409;
        const failure = describeApiFailure(error, "Couldn't add those ingredients.");
        const message = destinationUnavailable
          ? INGREDIENT_DESTINATION_UNAVAILABLE
          : failure.message;
        useToast.getState().show({
          message: changed
            ? INGREDIENTS_CHANGED
            : `The meal was saved, but ${message.charAt(0).toLowerCase()}${message.slice(1)}`,
          tone: 'error',
          ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
        });
        return false;
      }
    },

    saveWatchItemAndPlan: async (target, fields, timezone, destination) => {
      if (target.objectKind !== 'plan') return false;
      const title = fields.title.trim();
      const list = destination.list;
      // The item carries the reviewed episode progress only where the list can hold it.
      const progressEnabled =
        list.featureConfig.progress?.enabled === true &&
        list.featureConfig.progress.kind === 'episode';
      const season = Number.parseInt(details.season, 10);
      const episode = Number.parseInt(details.episode, 10);
      const features = progressEnabled
        ? {
            progress: {
              kind: 'episode' as const,
              ...(details.mediaKind === undefined
                ? {}
                : { mediaKind: details.mediaKind }),
              ...(Number.isNaN(season) ? {} : { season }),
              ...(Number.isNaN(episode) ? {} : { episode }),
            },
          }
        : undefined;
      let itemId: string;
      try {
        const item = await createListItem(
          apiClient,
          list.listId,
          { title, ...(features === undefined ? {} : { features }) },
          randomUUID(),
        );
        itemId = item.itemId;
      } catch (error) {
        const failure = describeApiFailure(error, "Couldn't add that to the list.");
        useToast.getState().show({
          message: failure.message,
          tone: 'error',
          ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
        });
        return false;
      }
      const body = toScheduleListItemInput(
        target,
        fields,
        timezone,
        takeActivityId(),
        { mode: 'just_me' },
        () => newLocalId('rem'),
      );
      if (body === undefined) return false;
      try {
        await schedule.mutateAsync({
          listId: list.listId,
          itemId,
          body,
          idempotencyKey: takeIdempotencyKey(),
        });
        await queryClient.invalidateQueries({ queryKey: LISTS_KEY });
        return true;
      } catch (error) {
        const failure = describeApiFailure(error, "Couldn't save the plan.");
        useToast.getState().show({
          message: `${title} was added to ${list.title}, but the plan was not saved: ${failure.message}`,
          tone: 'error',
          ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
        });
        return false;
      }
    },

    isSaving: ingredients.isPending || schedule.isPending,
  };
}
