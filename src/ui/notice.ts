// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Transient UI notices
// ───────────────────────────────────────────────────────────────────────────
// A rejected action must be *visible*, not just logged. The editor store already
// records a human-readable `lastError` for every refusal (bad connection type,
// occupied input, cycle, undeletable output node…). This tiny store turns those
// into a toast, and lets the canvas raise view-only notices of its own.
//
// `seq` exists because the same message twice in a row is still two events —
// without it, re-attempting the identical illegal connection would show nothing
// after the first toast auto-dismissed.
// ═══════════════════════════════════════════════════════════════════════════

import { create } from 'zustand';

import { useEditorStore } from './store';

export interface NoticeStore {
  message: string | null;
  /** Bumped on every notice so repeats re-trigger the dismiss timer. */
  seq: number;
  notify: (message: string) => void;
  dismiss: () => void;
}

export const useNotice = create<NoticeStore>((set) => ({
  message: null,
  seq: 0,
  notify: (message) => set((s) => ({ message, seq: s.seq + 1 })),
  dismiss: () => set({ message: null }),
}));

/** Imperative shorthand for non-React callers (event handlers, callbacks). */
export function notify(message: string): void {
  useNotice.getState().notify(message);
}

let bridged = false;

/**
 * Forward every editor-store rejection to the toast, from whichever pane raised
 * it, then clear it so an identical next failure is a fresh state change.
 * Idempotent: safe under HMR and StrictMode.
 */
export function bridgeStoreErrors(): void {
  if (bridged) return;
  bridged = true;
  useEditorStore.subscribe((state, prev) => {
    if (state.lastError && state.lastError !== prev.lastError) {
      notify(state.lastError);
      // Deferred: never call `set` from inside a subscriber's own notification.
      queueMicrotask(() => useEditorStore.getState().clearError());
    }
  });
}
