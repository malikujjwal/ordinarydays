import { useMotion } from '@od/ui';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

export interface CompletionTransitionProps {
  children: ReactNode;
  transitionKey: string;
  onFinished: (transitionKey: string) => void;
}

/** Web uses the same motion tokens through a small CSS opacity transition. */
export function CompletionTransition({
  children,
  transitionKey,
  onFinished,
}: CompletionTransitionProps) {
  const motion = useMotion();
  const [opacity, setOpacity] = useState(1);

  useEffect(() => {
    const fadeTimer = setTimeout(() => setOpacity(0), motion.duration.fast);
    const finishTimer = setTimeout(
      () => onFinished(transitionKey),
      motion.duration.fast + motion.duration.base,
    );
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(finishTimer);
    };
  }, [motion.duration.base, motion.duration.fast, onFinished, transitionKey]);

  return (
    <div
      data-testid="completion-transition-row"
      style={{
        opacity,
        transitionDuration: `${motion.duration.base}ms`,
        transitionProperty: 'opacity',
        transitionTimingFunction: motion.easing.accelerate,
      }}
    >
      {children}
    </div>
  );
}
