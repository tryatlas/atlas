import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { comms } from "./comms-api";
import { subscribeDraftBus } from "./draft-bus";
import {
  AWARENESS_HEARTBEAT_MS,
  AWARENESS_INTERVAL_MS,
  AWARENESS_TTL_MS,
  decodeAwareness,
  encodeAwareness,
  PROMPT_TEXT_KEY,
  REMOTE,
  toBase64,
  UPDATE_DEBOUNCE_MS,
} from "./draft-sync";
import { useCommsStore } from "../stores/comms-store";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { authoritativePage, spaceOutbox, updateBatches } from "@/features/spaces/lib/space-outbox";
import type { PromptDraft } from "../types";

export interface DraftPeer {
  userId: string;
  cursor: number;
  at: number;
}

/** A draft view owns its editor; the scoped native journal owns unsent work. */
export function useDraftSession(draft: PromptDraft) {
  const draftId = draft.id;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const accountId = useAuthStore((s) =>
    s.snapshot.status === "signed-in" ? (s.snapshot.user?.id ?? null) : null,
  );
  const orgId = useAuthStore((s) =>
    s.snapshot.status === "signed-in" ? s.snapshot.commsOrgId : null,
  );
  const identity = useMemo(
    () => (accountId && orgId ? { accountId, orgId } : null),
    [accountId, orgId],
  );
  const doc = useMemo(() => new Y.Doc({ gc: false }), [draftId, identity]);
  const ytext = useMemo(() => doc.getText(PROMPT_TEXT_KEY), [doc]);
  const journal = useMemo(
    () =>
      identity
        ? spaceOutbox({ ...identity, convId: draft.conv_id, pageId: `draft:${draftId}` })
        : null,
    [identity, draft.conv_id, draftId],
  );
  const [ready, setReady] = useState(false);
  const [meta, setMeta] = useState<PromptDraft>(draft);
  const [peers, setPeers] = useState<Record<string, DraftPeer>>({});
  const [syncError, setSyncError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const retryRef = useRef<() => void>(() => {});
  const lastAwareness = useRef(0);

  useEffect(() => {
    setReady(false);
    setMeta(draftRef.current);
    setPeers({});
    setSyncError(null);
    if (!identity || !journal) {
      setSyncError("Sign in to recover this draft's saved edits.");
      return () => doc.destroy();
    }
    let alive = true;
    let opened = false;
    let sent = draftRef.current.sent_at !== null;
    let sending = false;
    let connectionGeneration = 0;
    let sentIds = new Set<number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let proofTimer: ReturnType<typeof setTimeout> | undefined;
    const current = () => {
      const auth = useAuthStore.getState().snapshot;
      const connection = useCommsStore.getState().connection;
      return (
        alive &&
        auth.status === "signed-in" &&
        auth.user?.id === identity.accountId &&
        auth.commsOrgId === identity.orgId &&
        connection.orgId === identity.orgId &&
        connection.state === "open"
      );
    };
    const fail = (error: unknown) => {
      if (alive) setSyncError(String(error).replace(/Space/g, "Draft"));
    };
    const announce = () => {
      if (!alive) return;
      setPending(journal.pending);
      if (journal.error) fail(journal.error);
    };
    const open = async () => {
      if (current()) await comms.draftOpen(draftId, identity);
    };
    const transmit = async () => {
      if (sending) return;
      sending = true;
      const generation = connectionGeneration;
      try {
        await journal.flush();
        if (!current() || !opened || sent || generation !== connectionGeneration) return;
        const records = journal.records.filter((record) => !sentIds.has(record.id));
        for (const batch of updateBatches(records.map((record) => record.data))) {
          if (!current() || generation !== connectionGeneration || sent) return;
          await comms.draftUpdate(draftId, toBase64(batch), identity);
        }
        if (!current() || generation !== connectionGeneration) return;
        for (const record of records) sentIds.add(record.id);
        if (records.length && proofTimer === undefined)
          proofTimer = setTimeout(() => {
            proofTimer = undefined;
            void open().catch(fail);
          }, 750);
      } catch (error) {
        fail(error);
      } finally {
        sending = false;
        announce();
      }
    };
    const relay = (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      journal.record(update, () => Y.encodeStateAsUpdate(doc));
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void transmit();
      }, UPDATE_DEBOUNCE_MS);
    };
    doc.on("update", relay);
    const loaded = journal.hydrate().then(() => {
      if (!alive) return;
      if (journal.savedSnapshot) Y.applyUpdate(doc, journal.savedSnapshot, REMOTE);
      for (const update of journal.data) Y.applyUpdate(doc, update, REMOTE);
      if (journal.savedSnapshot || journal.pending) setReady(true);
      announce();
    });
    void loaded.catch(fail);
    const offJournal = journal.subscribe(announce);
    const offBus = subscribeDraftBus((event) => {
      if (event.draft_id !== draftId || !current()) return;
      if (event.kind === "opened") {
        const generation = connectionGeneration;
        void loaded
          .then(async () => {
            if (!current() || generation !== connectionGeneration) return;
            const authoritative = authoritativePage(event);
            try {
              Y.applyUpdate(doc, Y.encodeStateAsUpdate(authoritative), REMOTE);
              await journal.flush();
              if (!current() || generation !== connectionGeneration) return;
              await journal.acknowledge(authoritative);
              sent = event.draft.sent_at !== null;
              opened = true;
              setMeta(event.draft);
              setReady(true);
              setSyncError(
                sent && journal.pending
                  ? "This draft was sent before your local changes synced. Your edits remain saved here; copy them to recover."
                  : null,
              );
              journal.captureSnapshot(() => Y.encodeStateAsUpdate(doc));
              void transmit();
            } finally {
              authoritative.destroy();
            }
          })
          .catch(fail);
      } else if (event.kind === "update") {
        try {
          Y.applyUpdate(
            doc,
            Uint8Array.from(atob(event.update), (c) => c.charCodeAt(0)),
            REMOTE,
          );
          journal.captureSnapshot(() => Y.encodeStateAsUpdate(doc));
        } catch (error) {
          fail(error);
        }
      } else if (event.user_id !== useCommsStore.getState().me) {
        const state = decodeAwareness(event.state);
        if (state)
          setPeers((currentPeers) => ({
            ...currentPeers,
            [event.user_id]: { userId: event.user_id, cursor: state.cursor, at: Date.now() },
          }));
      }
    });
    let connection = useCommsStore.getState().connection;
    void loaded.then(open).catch(fail);
    const offConnection = useCommsStore.subscribe((state) => {
      if (
        connection.state === state.connection.state &&
        connection.epoch === state.connection.epoch &&
        connection.orgId === state.connection.orgId
      )
        return;
      connection = state.connection;
      connectionGeneration += 1;
      opened = false;
      sentIds = new Set();
      if (proofTimer !== undefined) clearTimeout(proofTimer);
      proofTimer = undefined;
      void loaded.then(open).catch(fail);
    });
    retryRef.current = () => {
      sentIds.clear();
      setSyncError(null);
      void journal
        .hydrate()
        .then(() => {
          void transmit();
          return open();
        })
        .catch(fail);
    };
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
      if (proofTimer !== undefined) clearTimeout(proofTimer);
      offConnection();
      offBus();
      offJournal();
      doc.off("update", relay);
      // flush synchronously materializes the full snapshot before destruction.
      journal.captureSnapshot(() => Y.encodeStateAsUpdate(doc));
      void journal.flush().catch(() => {});
      doc.destroy();
    };
  }, [doc, draftId, identity, journal]);

  // ---- awareness out: throttled publisher + heartbeat ---------------------
  const cursorRef = useRef(0);
  const publishCursor = useMemo(() => {
    return (offset: number, force = false) => {
      cursorRef.current = offset;
      if (meta.sent_at !== null || !identity) return;
      const now = Date.now();
      if (!force && now - lastAwareness.current < AWARENESS_INTERVAL_MS) return;
      lastAwareness.current = now;
      void comms
        .draftAwareness(draftId, encodeAwareness({ cursor: offset }), identity)
        .catch(() => {});
    };
  }, [draftId, meta.sent_at, identity]);

  useEffect(() => {
    const beat = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      publishCursor(cursorRef.current, true);
    }, AWARENESS_HEARTBEAT_MS);
    return () => window.clearInterval(beat);
  }, [publishCursor]);

  // ---- peer expiry: no leave frame exists, age them out -------------------
  useEffect(() => {
    const sweep = window.setInterval(() => {
      const cutoff = Date.now() - AWARENESS_TTL_MS;
      setPeers((current) => {
        const alive = Object.fromEntries(Object.entries(current).filter(([, p]) => p.at >= cutoff));
        return Object.keys(alive).length === Object.keys(current).length ? current : alive;
      });
    }, 5_000);
    return () => window.clearInterval(sweep);
  }, []);

  return {
    doc,
    ytext,
    ready,
    meta,
    peers,
    publishCursor,
    syncError,
    pending,
    retrySync: () => retryRef.current(),
  };
}
