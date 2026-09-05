import { useCallback, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  Platform,
  type TextInput,
  type View,
} from 'react-native';

/** A notes save acknowledges the existing platform owner (SQLite/outbox on native). */
export function useNotesDraft(
  value: string,
  persist: (notes: string) => Promise<boolean>,
) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const actionRef = useRef<View>(null);
  const returningToNotes = useRef(false);
  const promptVisible = useRef(false);
  const focusAction = useCallback(() => {
    if (!returningToNotes.current || promptVisible.current) return;
    returningToNotes.current = false;
    if (Platform.OS === 'web') actionRef.current?.focus();
    else {
      const handle = findNodeHandle(actionRef.current);
      if (handle !== null) AccessibilityInfo.setAccessibilityFocus(handle);
    }
  }, []);
  const original = useRef(value);
  const [confirming, setConfirming] = useState(false);
  const destination = useRef<(() => void) | undefined>(undefined);
  const dirty = editing && draft !== original.current;
  const latest = useRef({ dirty });
  latest.current = { dirty };
  const close = useCallback(() => {
    returningToNotes.current = true;
    setEditing(false);
  }, []);
  const inFlight = useRef(false);
  const edit = useCallback(() => {
    original.current = value;
    setDraft(value);
    setError(false);
    setEditing(true);
  }, [value]);
  const save = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(false);
    try {
      if (await persist(draft)) close();
      else setError(true);
    } catch {
      setError(true);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const requestLeave = useCallback((leave: () => void) => {
    if (inFlight.current) return;
    if (latest.current.dirty) {
      inputRef.current?.blur();
      promptVisible.current = true;
      destination.current = leave;
      setConfirming(true);
    } else leave();
  }, []);
  const keepEditing = () => {
    destination.current = undefined;
    setConfirming(false);
  };
  const discard = () => {
    const leave = destination.current;
    destination.current = undefined;
    latest.current = { dirty: false };
    setConfirming(false);
    setEditing(false);
    leave?.();
  };
  return {
    inputRef,
    actionRef,
    focusAction,
    promptClosed: () => {
      promptVisible.current = false;
    },
    confirming,
    requestLeave,
    keepEditing,
    discard,
    cancel: () => requestLeave(close),
    editing,
    draft,
    saving,
    error,
    edit,
    save,
    change: setDraft,
    dirty,
  };
}
