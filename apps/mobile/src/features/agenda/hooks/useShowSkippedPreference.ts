import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

const SHOW_SKIPPED_KEY = 'ordinarydays-today-show-skipped-v1';

export interface ShowSkippedPreference {
  showSkipped: boolean;
  setShowSkipped: (show: boolean) => void;
}

/** Today-only presentation state. It never changes the agenda request or server data. */
export function useShowSkippedPreference(): ShowSkippedPreference {
  const [showSkipped, setShowSkippedState] = useState(false);
  const changedLocally = useRef(false);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(SHOW_SKIPPED_KEY)
      .then((stored) => {
        if (active && !changedLocally.current) setShowSkippedState(stored === 'true');
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const setShowSkipped = useCallback((show: boolean) => {
    changedLocally.current = true;
    setShowSkippedState(show);
    void AsyncStorage.setItem(SHOW_SKIPPED_KEY, String(show)).catch(() => undefined);
  }, []);

  return { showSkipped, setShowSkipped };
}
