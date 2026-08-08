/**
 * `@od/ui` — the design system. React Native and React Native Web. Knows no domain.
 *
 * This is the single barrel and the package's entire public surface (`repo-structure.md`
 * §6). It is one of only two barrels in the repository, and it earns its cost because it
 * is the contract between packages rather than a convenience inside one.
 *
 * Empty by design. P0-08 scaffolds the package; the theme (`theme/tokens.ts`,
 * `breakpoints.ts`, `typography.ts`) and the primitives (`primitives/`) are written in
 * P1-22, and each is exported from here as it lands. `react` and `react-native` are
 * deliberately not dependencies yet either — see the note in the package README of record,
 * `repo-structure.md` §2.2, and P0-19's edge case on version drift.
 *
 * Three rules this package lives under, all from `repo-structure.md` §2.2:
 *
 * - It imports **no workspace package**, not even `@od/shared`. A primitive that needs a
 *   domain type is not a primitive; it is a feature component and belongs in
 *   `apps/mobile/src/features/<f>/components/`. This keeps the dependency graph a tree
 *   rather than a diamond, and keeps `ui` extractable.
 * - It never fetches, never holds server state, and never navigates.
 * - It contains no hard-coded colour, spacing, radius or font size. Every such value comes
 *   from a token (`design-system.md` §9).
 */
export {};
