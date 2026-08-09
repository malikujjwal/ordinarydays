/**
 * `@od/ui` — the design system. React Native and React Native Web. Knows no domain.
 *
 * This is the single barrel and the package's entire public surface
 * (`repo-structure.md` §6). Three rules this package lives under (§2.2):
 *
 * - It imports **no workspace package**, not even `@od/shared`. A primitive that needs a
 *   domain type is not a primitive; it is a feature component and belongs in
 *   `apps/mobile/src/features/<f>/components/`. This keeps the dependency graph a tree
 *   rather than a diamond, and keeps `ui` extractable.
 * - It never fetches, never holds server state, and never navigates.
 * - It contains **no hard-coded colour, spacing, radius or font size**. Every such value
 *   comes from a token, and the colour ramps are module-private so a component cannot reach
 *   a raw hex (`design-system.md` §10).
 */

export * from './icons/index';
export {
  Avatar,
  type AvatarProps,
  AvatarStack,
  type AvatarStackProps,
  initialsOf,
} from './primitives/Avatar';
export { Button, type ButtonProps, type ButtonVariant } from './primitives/Button';
export { Card, type CardProps } from './primitives/Card';
export { Checkbox, type CheckboxProps } from './primitives/Checkbox';
export { Chip, type ChipProps, type ChipTone } from './primitives/Chip';
export {
  EmptyState,
  type EmptyStateProps,
  SectionHeader,
  type SectionHeaderProps,
  Skeleton,
  type SkeletonProps,
  Toast,
  type ToastProps,
} from './primitives/Feedback';
export { Field, type FieldProps } from './primitives/Field';
export { IconButton, type IconButtonProps } from './primitives/IconButton';
export { IconTile, type IconTileProps } from './primitives/IconTile';
export { ProgressBar, type ProgressBarProps } from './primitives/ProgressBar';
export { Row, type RowProps } from './primitives/Row';
export {
  type Segment,
  SegmentedControl,
  type SegmentedControlProps,
} from './primitives/SegmentedControl';
export { Sheet, type SheetProps } from './primitives/Sheet';
export { Text, type TextColor, type TextProps } from './primitives/Text';
export { Touchable, type TouchableProps } from './primitives/Touchable';
export {
  AA_BODY,
  AA_LARGE,
  contrastRatio,
  ratioOf,
} from './theme/contrast';
export * from './theme/index';
