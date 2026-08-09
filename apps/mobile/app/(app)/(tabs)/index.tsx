import { EmptyState } from '@od/ui';
import { TabScreen } from '@/components/TabScreen';

/**
 * Today. A query over the agenda, never storage — Phase 2 (P2-11) fills it.
 *
 * The heading is `interaction-contract.md` §5.2's canonical one, which is truthful here:
 * there is nothing planned. The guidance names the phase rather than §5.2's `Add something you
 * want to do, or check your Lists.`, because telling the user to add something they would then
 * not see on this screen is worse than saying the screen is not filled yet.
 */
export default function TodayTab() {
  return (
    <TabScreen title="Today" testID="today-screen">
      <EmptyState
        heading="Nothing planned today"
        body="The day's agenda arrives in Phase 2."
      />
    </TabScreen>
  );
}
