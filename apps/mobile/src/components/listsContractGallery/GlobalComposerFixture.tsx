import { ComposeScreen } from '@/features/compose/components/ComposeScreen';

/** Global Add chooser after List-item creation moved back inside each List. */
export function GlobalComposerFixture() {
  return (
    <ComposeScreen
      onClose={() => {}}
      today="2026-08-28"
      timezone="America/New_York"
      onCreateList={() => {}}
    />
  );
}
