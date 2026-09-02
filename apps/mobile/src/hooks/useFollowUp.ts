import {
  completeActivity,
  deleteActivity,
  getList,
  patchListItem,
  uncompleteActivity,
} from '@od/shared/client';
import { type CompletionFollowUp, completionFollowUp } from '@od/shared/schemas';
import type { ActivityType, ListFeatureConfig, ListItemState } from '@od/shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useCallback } from 'react';
import { apiClient } from '@/lib/apiClient';
import {
  CREATE_A_PLAN,
  deletePrepConfirmation,
  type FollowUpHandlers,
  followUpPresentation,
  nextSessionQuestion,
  progressUpdatedMessage,
} from '@/lib/followUpCopy';
import { useComposeDraft } from '@/stores/composeDraft';
import { useToast } from '@/stores/toast';

/**
 * Where a follow-up's navigation-only rows go. Supplied by the route, which owns the router;
 * absent (a test, or a screen with nowhere to go) those rows still render and simply close.
 */
export interface FollowUpNavigation {
  openActivity: (activityId: string) => void;
  /** After `Create a Plan for S2 E6?` has staged P3-34's bridge: the compose modal. */
  openCompose: () => void;
}

export interface FollowUpSubject {
  activityId: string;
  activityType: ActivityType | undefined;
}

type WatchProgress = Extract<CompletionFollowUp, { kind: 'watch_progress' }>;
type ItemState = Extract<CompletionFollowUp, { kind: 'list_item_state' }>;
type OpenPrep = Extract<CompletionFollowUp, { kind: 'open_prep' }>;

type WireFeatureConfig = Awaited<ReturnType<typeof getList>>['list']['featureConfig'];

/** The wire shape carries `| undefined` on its optional keys; the bridge's type does not. */
function featureConfigOf(config: WireFeatureConfig): ListFeatureConfig {
  const subItems = config.subItems;
  return {
    ...(config.progress === undefined ? {} : { progress: config.progress }),
    ...(config.place === undefined ? {} : { place: config.place }),
    ...(subItems === undefined
      ? {}
      : {
          subItems: {
            enabled: subItems.enabled,
            sectionLabel: subItems.sectionLabel,
            singularLabel: subItems.singularLabel,
            ...(subItems.secondaryLabel === undefined
              ? {}
              : { secondaryLabel: subItems.secondaryLabel }),
            ...(subItems.integration === undefined
              ? {}
              : { integration: subItems.integration }),
          },
        }),
  };
}

/** What `Create a Plan for S2 E6?` bridges: the item as this hook just updated it. */
interface BridgedItem {
  title: string;
  state: ListItemState;
  note?: string | undefined;
}

/**
 * Presents the one follow-up a completion response carries (`activities.md` §5.3,
 * `interaction-contract.md` §1a.2) and performs the tap the user chooses.
 *
 * The server chose the row; this hook only says it and acts on an explicit tap. Every write
 * here is the ordinary endpoint behind its own Undo toast (§1a.2: an accepted follow-up is
 * its own action — un-completing the Activity later never reverses it). `Keep` and the `✕`
 * write nothing. `Delete` names its count on a second tap before anything is removed
 * (§1a.1: deletions always confirm).
 */
export function useFollowUpActions(navigation: FollowUpNavigation | undefined) {
  const queryClient = useQueryClient();
  const openPlanForItem = useComposeDraft((state) => state.openPlanForItem);

  const present = useCallback(
    (result: unknown, subject: FollowUpSubject, toastId: number): void => {
      // Only the follow-up is read; the rest of the response is the mutation's business.
      const carried =
        typeof result === 'object' && result !== null && 'followUp' in result
          ? result.followUp
          : undefined;
      const parsed = completionFollowUp.safeParse(carried);
      if (!parsed.success) return;
      const followUp = parsed.data;

      const toast = useToast.getState();
      const refresh = () => void queryClient.invalidateQueries();
      const failed = (message: string) => toast.show({ message, tone: 'error' });

      const createPlanFor = (
        source: WatchProgress,
        item: BridgedItem,
        session: { season: number; episode: number },
      ) => {
        const { season, episode } = session;
        void getList(apiClient, source.listId)
          .then((detail) => {
            // P3-34's bridge: the kind chooser opens unselected; fields fill only after the tap.
            openPlanForItem({
              listId: source.listId,
              itemId: source.itemId,
              list: { featureConfig: featureConfigOf(detail.list.featureConfig) },
              item: {
                title: item.title,
                state: item.state,
                ...(item.note === undefined ? {} : { note: item.note }),
                // The Progress this hook just wrote, in the bridge's own shape.
                features: {
                  progress: {
                    kind: 'episode',
                    ...(source.mediaKind === undefined
                      ? {}
                      : { mediaKind: source.mediaKind }),
                    season,
                    episode,
                  },
                },
              },
            });
            navigation?.openCompose();
          })
          .catch(() => failed("Couldn't open that list item."));
      };

      const updateProgress = (source: WatchProgress) => {
        const mediaKind =
          source.mediaKind === undefined ? {} : { mediaKind: source.mediaKind };
        const { season, episode } = source.target;
        // The server only asks a non-empty question (P3-16); an empty target is not one.
        if (season === undefined || episode === undefined) return;
        void patchListItem(apiClient, source.listId, source.itemId, {
          features: { progress: { kind: 'episode', ...mediaKind, season, episode } },
        })
          .then((item) => {
            refresh();
            const previous = source.current;
            const canRestore =
              previous.season !== undefined && previous.episode !== undefined;
            toast.showUndo({
              message: progressUpdatedMessage(season, episode),
              // §5.3: the next session is a second, separate step, offered only for shows.
              ...(source.mediaKind === 'show'
                ? {
                    followUp: {
                      message: nextSessionQuestion(source.listTitle, season, episode),
                      actions: [
                        {
                          label: CREATE_A_PLAN,
                          onPress: () => createPlanFor(source, item, { season, episode }),
                          testID: 'follow-up-create-plan',
                        },
                      ],
                    },
                  }
                : {}),
              onCommit: () => {},
              onUndo: () => {
                if (!canRestore) return;
                void patchListItem(apiClient, source.listId, source.itemId, {
                  features: {
                    progress: {
                      kind: 'episode',
                      ...mediaKind,
                      season: previous.season ?? season,
                      episode: previous.episode ?? episode,
                    },
                  },
                })
                  .then(refresh)
                  .catch(() => failed("Couldn't undo that progress update."));
              },
            });
          })
          .catch(() => failed("Couldn't update progress."));
      };

      const markDone = (source: ItemState) => {
        const visited = subject.activityType === 'event';
        void patchListItem(apiClient, source.listId, source.itemId, { state: 'done' })
          .then(() => {
            refresh();
            toast.showUndo({
              message: visited
                ? `${source.itemTitle ?? 'Item'} marked visited`
                : `${source.listTitle} item marked done`,
              onCommit: () => {},
              onUndo: () => {
                void patchListItem(apiClient, source.listId, source.itemId, {
                  state: source.current.state,
                })
                  .then(refresh)
                  .catch(() => failed("Couldn't undo that."));
              },
            });
          })
          .catch(() =>
            failed(visited ? "Couldn't mark it visited." : "Couldn't mark it done."),
          );
      };

      const completeAllPrep = (source: OpenPrep) => {
        const count = source.childIds.length;
        void Promise.all(
          source.childIds.map((childId) =>
            completeActivity(apiClient, childId, {}, randomUUID()),
          ),
        )
          .then(() => {
            refresh();
            toast.showUndo({
              message: `Completed ${count} prep ${count === 1 ? 'task' : 'tasks'}`,
              onCommit: () => {},
              onUndo: () => {
                void Promise.all(
                  source.childIds.map((childId) =>
                    uncompleteActivity(apiClient, childId, {}, randomUUID()),
                  ),
                )
                  .then(refresh)
                  .catch(() => failed("Couldn't undo those completions."));
              },
            });
          })
          .catch(() => {
            refresh();
            failed("Couldn't complete every prep task.");
          });
      };

      const deletePrep = (source: OpenPrep) => {
        const count = source.childIds.length;
        const confirmation = deletePrepConfirmation(count);
        toast.show({
          message: confirmation.message,
          dismissible: true,
          duration: 10000,
          action: {
            label: confirmation.label,
            onPress: () => {
              void Promise.all(
                source.childIds.map((childId) => deleteActivity(apiClient, childId)),
              )
                .then(() => {
                  refresh();
                  toast.show({
                    message: `Deleted ${count} prep ${count === 1 ? 'task' : 'tasks'}`,
                  });
                })
                .catch(() => {
                  refresh();
                  failed("Couldn't delete every prep task.");
                });
            },
          },
        });
      };

      const handlers: FollowUpHandlers = {
        updateProgress,
        markDone,
        addIngredients: () => {
          toast.dismiss(toastId);
          navigation?.openActivity(subject.activityId);
        },
        keepPrep: () => toast.dismiss(toastId),
        completeAllPrep,
        deletePrep,
        reviewExpenses: () => {
          toast.dismiss(toastId);
          navigation?.openActivity(subject.activityId);
        },
        addExpense: () => {
          toast.dismiss(toastId);
          navigation?.openActivity(subject.activityId);
        },
      };

      toast.attachFollowUp(
        toastId,
        followUpPresentation(followUp, { activityType: subject.activityType }, handlers),
      );
    },
    [navigation, openPlanForItem, queryClient],
  );

  return { present };
}
