import { type Clock, systemClock } from '@od/shared/time';
import { createContext, type ReactNode, useContext } from 'react';

const ClockContext = createContext<Clock>(systemClock);

export interface ClockProviderProps {
  children: ReactNode;
  clock?: Clock;
}

/** Supplies one clock to every mobile hook, with an override seam for tests and stories. */
export function ClockProvider({ children, clock = systemClock }: ClockProviderProps) {
  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>;
}

export function useClock(): Clock {
  return useContext(ClockContext);
}
