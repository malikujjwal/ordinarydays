import type { ReactElement } from 'react';
import { type IconProps, templateIcons } from './index';

type IconComponent = (props: IconProps) => ReactElement;

/** Resolves stored catalogue names while keeping the legacy fallback invariant in one place. */
export function templateIcon(name: string): IconComponent {
  const fallback = templateIcons.list;
  if (fallback === undefined)
    throw new Error('The template icon registry has no list fallback.');
  return templateIcons[name] ?? fallback;
}
