interface Reservation {
  running: boolean;
  superseded: boolean;
  cancel: () => void;
}
interface Slot {
  tail: Promise<void>;
  reservations: Set<Reservation>;
}
const slots = new Map<string, Slot>();

/** Orders adapter calls across dismissal/reopening; it never caches persisted domain values. */
export function reserveItemWrite(key: string) {
  const owner = slots.get(key) ?? {
    tail: Promise.resolve(),
    reservations: new Set<Reservation>(),
  };
  slots.set(key, owner);
  let released = false;
  const reservation: Reservation = {
    running: false,
    superseded: false,
    cancel: () => {
      if (released) return;
      released = true;
      owner.reservations.delete(reservation);
      if (owner.reservations.size === 0 && slots.get(key) === owner) slots.delete(key);
    },
  };
  owner.reservations.add(reservation);
  // New user intent retires queued/failed work from any previous editor. An already running
  // adapter call must settle first; the next call is ordered after it by the shared tail.
  for (const older of owner.reservations) {
    if (older === reservation) continue;
    older.superseded = true;
    if (!older.running) older.cancel();
  }
  return {
    cancel: reservation.cancel,
    execute: <T extends { ok: boolean }>(write: () => Promise<T>) => {
      const work = owner.tail.then(async () => {
        if (released || reservation.superseded) return { kind: 'superseded' } as const;
        reservation.running = true;
        try {
          const outcome = await write();
          if (outcome.ok || reservation.superseded) reservation.cancel();
          return { kind: 'settled', ...outcome } as const;
        } finally {
          reservation.running = false;
        }
      });
      owner.tail = work.then(
        () => undefined,
        () => undefined,
      );
      return work;
    },
  };
}
