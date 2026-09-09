import { ComposeScreen } from '@/features/compose/components/ComposeScreen';

/** Global Add chooser after List-item creation moved back inside each List. */
export function GlobalComposerFixture() {
  return (
    <ComposeScreen
      onClose={() => {}}
      today="2026-08-28"
      timezone="America/New_York"
      listWriter={{
        save: async () => undefined,
        isCreating: false,
        errorMessage: undefined,
        errorRequestId: undefined,
      }}
    />
  );
}
