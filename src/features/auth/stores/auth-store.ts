// Account state, mirrored from Rust.
//
// This store is a pure reflection of `atlas:auth-changed`. It never decides
// anything: Rust owns the credential, the grant, and every transition, so the
// only writer here is the event handler wired up once in App.tsx.
//
// `dialogOpen` is the one piece of genuinely local state — whether the connect
// dialog is on screen. It is separate from `status` because a user can dismiss
// the dialog while a grant is still valid, and reopening it must resume rather
// than restart.

import { create } from "zustand";
import { auth, type AuthSnapshot } from "../lib/auth-api";
import {
  identify as identifyTelemetry,
  resetIdentity as resetTelemetryIdentity,
} from "@/features/telemetry/posthog-client";

/**
 * Keep the renderer's crash-reporting identity in step with the account.
 *
 * Rust does the same for product events off its own auth funnel; posthog-js
 * holds a separate distinct id in localStorage, so it has to be told here. Done
 * inside `setSnapshot` because that is the store's single write path — every
 * transition, including the launch restore, passes through it exactly once.
 *
 * `connecting`, and `signed-in` before the profile lands, are deliberately left
 * alone: the next snapshot carries the user, and resetting in that gap would
 * bounce attribution back to the device for no reason.
 */
function syncTelemetryIdentity(snapshot: AuthSnapshot): void {
  if (snapshot.status === "signed-out") {
    resetTelemetryIdentity();
    return;
  }
  if (snapshot.status === "signed-in" && snapshot.user) {
    identifyTelemetry({
      distinctId: snapshot.user.id,
      email: snapshot.user.email,
      name: snapshot.user.name,
      orgId: snapshot.activeOrgId ?? null,
    });
  }
}

interface AuthStoreState {
  snapshot: AuthSnapshot;
  /** Whether the connect dialog is showing. */
  dialogOpen: boolean;
  /** Last grant failure, shown inside the dialog. Cleared on the next attempt. */
  error: string | null;
  /** True between clicking the button and Rust confirming the grant started. */
  starting: boolean;
  actions: {
    setSnapshot: (snapshot: AuthSnapshot) => void;
    setError: (message: string) => void;
    /** Start (or resume) sign-in and show the dialog. */
    beginSignIn: () => Promise<void>;
    /** Dismiss the dialog and abandon the grant. */
    cancelSignIn: () => Promise<void>;
    /** Dismiss the dialog, leaving the grant running. */
    closeDialog: () => void;
    /**
     * Sign out. Resolves to whether the server session was revoked too —
     * `false` means this device is signed out but the server session may
     * outlive it. The signed-out state itself arrives as an event, not from
     * this promise.
     */
    signOut: () => Promise<boolean>;
    /** Pull the current state from Rust (mount hydration). */
    hydrate: () => Promise<void>;
  };
}

let signInGeneration = 0;
let snapshotGeneration = 0;

const useAuthStoreBase = create<AuthStoreState>()((set, get) => ({
  snapshot: { status: "signed-out" },
  dialogOpen: false,
  error: null,
  starting: false,

  actions: {
    setSnapshot: (snapshot) => {
      snapshotGeneration++;
      syncTelemetryIdentity(snapshot);
      set((s) => ({
        snapshot,
        starting: false,
        // Signing in is the end of the flow — close the dialog for them.
        dialogOpen: snapshot.status === "signed-in" ? false : s.dialogOpen,
        error: snapshot.status === "signed-in" ? null : s.error,
      }));
    },

    setError: (message) => set({ error: message, starting: false }),

    beginSignIn: async () => {
      const generation = ++signInGeneration;
      const snapshotVersion = snapshotGeneration;
      set({ dialogOpen: true, error: null, starting: true });
      try {
        const snapshot = await auth.signIn();
        if (generation !== signInGeneration) return;
        if (snapshotVersion === snapshotGeneration) get().actions.setSnapshot(snapshot);
        set({ starting: false });
      } catch (e) {
        if (generation !== signInGeneration) return;
        set({
          error: e instanceof Error ? e.message : String(e),
          starting: false,
        });
      }
    },

    cancelSignIn: async () => {
      const generation = ++signInGeneration;
      set({ dialogOpen: false, error: null, starting: false });
      try {
        const snapshot = await auth.cancelSignIn();
        if (generation === signInGeneration) get().actions.setSnapshot(snapshot);
      } catch {
        // Cancelling is best-effort; the dialog is already gone either way.
      }
    },

    closeDialog: () => set({ dialogOpen: false }),

    signOut: async () => {
      try {
        return await auth.signOut();
      } catch {
        // The local half cannot fail — Rust clears before it can return an
        // error at all — so an IPC failure here says nothing about the server
        // session, and the caveat is the honest thing to show.
        return false;
      }
    },

    hydrate: async () => {
      const generation = snapshotGeneration;
      try {
        const snapshot = await auth.snapshot();
        // Never resurrect the dialog from hydration — if a grant is still in
        // flight it belongs in the title bar, not popped over the project.
        if (generation === snapshotGeneration) get().actions.setSnapshot(snapshot);
      } catch {
        // A failed hydrate leaves the default signed-out state, which is the
        // correct thing to show when we cannot tell.
      }
      void get();
    },
  },
}));

export const useAuthStore = useAuthStoreBase;
