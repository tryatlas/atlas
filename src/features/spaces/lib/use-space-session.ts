import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { toBase64, fromBase64 } from "@/features/comms/lib/draft-sync";
import { useCommsStore } from "@/features/comms/stores/comms-store";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import {
  parseServerMessage,
  spacesApi,
  type SpaceClientMessage,
  type SpaceConnState,
  type SpaceReadOnlyReason,
} from "./spaces-api";
import { subscribeSpaceBus } from "./spaces-bus";
import { acquireSpaceSocket, registerOpenPage, releaseSpaceSocket } from "./live-spaces";
import { landingPage } from "./open-space";
import {
  applyAwareness,
  decodeSpaceFrame,
  SPACE_DOC_VERSION,
  frameAwareness,
  hasNewcomer,
  SPACE_FLUSH_TICK_MS,
  SPACE_FRAME_AWARENESS,
  SPACE_FRAME_UPDATE,
  type SpaceActor,
  type SpaceAwarenessState,
} from "./space-wire";
import { applyPageContent, applyRelayed, frameUpdate, localUndo, REMOTE } from "./space-doc";
import {
  authoritativePage,
  rememberSpacePage,
  savedSpacePages,
  spaceOutbox,
  updateBatches,
  type SpaceOutbox,
} from "./space-outbox";
import type { SpacePageTarget } from "./space-page-edit";
import { useSpacesStore } from "../stores/spaces-store";

type EditingReason = SpaceReadOnlyReason | "unavailable" | "recovering";

/** A view of one page; durable unsent edits live in the scoped outbox, not this hook. */
export function useSpaceSession(convId: string) {
  const patch = useSpacesStore.getState().actions.patch;
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
  const identityKey = JSON.stringify(identity);
  const ownerRef = useRef(identityKey);
  const [pageId, setPageId] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState<EditingReason | null>(null);
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const [actors, setActors] = useState<ReadonlyMap<string, SpaceActor>>(new Map());
  const [banner, setBanner] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [pendingUpdates, setPendingUpdates] = useState(false);
  const [following, setFollowing] = useState<string | null>(null);
  const followingRef = useRef<string | null>(null);
  const docRef = useRef<Y.Doc | null>(null);
  const undoRef = useRef<Y.UndoManager | null>(null);
  const pageIdRef = useRef<string | null>(null);
  const slotRef = useRef<number | null>(null);
  const sinceRef = useRef(new Map<string, number>());
  const connRef = useRef<SpaceConnState>("disconnected");
  const readOnlyRef = useRef<EditingReason | null>(null);
  const seatReadOnlyRef = useRef(false);
  const archivedRef = useRef(false);
  const recoveryRef = useRef(false);
  const generationRef = useRef(0);
  const sentRef = useRef(new Set<number>());
  const journalRef = useRef<SpaceOutbox | null>(null);
  const unsubscribeJournalRef = useRef<(() => void) | null>(null);
  const actorsRef = useRef<ReadonlyMap<string, SpaceActor>>(new Map());
  const unregisterPageRef = useRef<(() => void) | null>(null);
  const mineRef = useRef<SpaceAwarenessState>({});
  const awarenessTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const outboundTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const proofTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const proofRef = useRef<{ pageId: string; generation: number; ids: Set<number> } | null>(null);
  const sendingRef = useRef(false);

  const updateAccess = useCallback(
    (reason: EditingReason | null) => {
      readOnlyRef.current = reason;
      setReadOnly(reason);
      unregisterPageRef.current?.();
      unregisterPageRef.current = null;
      if (pageIdRef.current && docRef.current)
        unregisterPageRef.current = registerOpenPage(
          convId,
          pageIdRef.current,
          docRef.current,
          reason,
          identity ?? undefined,
        );
    },
    [convId, identity],
  );

  const requestPage = useCallback(
    (id: string, proof = false) => {
      if (!identity || recoveryRef.current || connRef.current !== "open") return;
      if (proof)
        proofRef.current = {
          pageId: id,
          generation: generationRef.current,
          ids: new Set(sentRef.current),
        };
      const since = proof ? undefined : sinceRef.current.get(id);
      void spacesApi
        .sendControl(
          convId,
          { t: "page.open", page_id: id, ...(since === undefined ? {} : { since }) },
          identity,
        )
        .catch((error) => setBanner(String(error)));
    },
    [convId, identity],
  );

  const flushOutbound = useCallback(async () => {
    outboundTimer.current = undefined;
    const journal = journalRef.current;
    if (!journal) return;
    let ownsSend = false;
    try {
      await journal.flush();
      if (
        journal !== journalRef.current ||
        ownerRef.current !== identityKey ||
        sendingRef.current ||
        !identity ||
        recoveryRef.current ||
        slotRef.current === null ||
        connRef.current !== "open" ||
        readOnlyRef.current !== null
      )
        return;
      sendingRef.current = true;
      ownsSend = true;
      const generation = generationRef.current;
      const slot = slotRef.current;
      const target = pageIdRef.current;
      const records = journal.records.filter((record) => !sentRef.current.has(record.id));
      for (const batch of updateBatches(records.map((record) => record.data))) {
        if (
          generation !== generationRef.current ||
          journal !== journalRef.current ||
          slot !== slotRef.current ||
          readOnlyRef.current !== null
        )
          return;
        await spacesApi.sendBinary(convId, toBase64(frameUpdate(slot, batch)), identity);
      }
      if (generation !== generationRef.current || journal !== journalRef.current) return;
      for (const record of records) sentRef.current.add(record.id);
      if (records.length && target && proofTimer.current === undefined) {
        proofTimer.current = setTimeout(() => {
          proofTimer.current = undefined;
          if (generation === generationRef.current && target === pageIdRef.current)
            requestPage(target, true);
        }, 750);
      }
    } catch (error) {
      setSyncError(journal.error ?? String(error));
    } finally {
      if (ownsSend) sendingRef.current = false;
    }
  }, [convId, identity, identityKey, requestPage]);

  const scheduleOutbound = useCallback(() => {
    if (outboundTimer.current === undefined)
      outboundTimer.current = setTimeout(() => {
        void flushOutbound();
      }, 33);
  }, [flushOutbound]);

  const sendAwarenessNow = useCallback(() => {
    awarenessTimer.current = undefined;
    const slot = slotRef.current;
    if (
      !identity ||
      recoveryRef.current ||
      slot === null ||
      connRef.current !== "open" ||
      seatReadOnlyRef.current ||
      readOnlyRef.current === "unavailable"
    )
      return;
    const state = useCommsStore.getState();
    const name = state.members.find((member) => member.id === state.me)?.name;
    void spacesApi
      .sendBinary(
        convId,
        toBase64(frameAwareness(slot, { ...mineRef.current, ...(name ? { name } : {}) })),
        identity,
      )
      .catch(() => {});
  }, [convId, identity]);
  const publishAwareness = useCallback(
    (state: Partial<SpaceAwarenessState>) => {
      mineRef.current = { ...mineRef.current, ...state };
      if (awarenessTimer.current === undefined)
        awarenessTimer.current = setTimeout(sendAwarenessNow, SPACE_FLUSH_TICK_MS);
    },
    [sendAwarenessNow],
  );
  const follow = useCallback(
    (id: string | null) => {
      followingRef.current = id;
      setFollowing(id);
      publishAwareness({ following: id });
    },
    [publishAwareness],
  );

  const repaintRef = useRef<ReturnType<typeof setTimeout> | number | null>(null);
  const scheduleRepaint = useCallback(() => {
    if (repaintRef.current !== null) return;
    repaintRef.current = setTimeout(() => {
      repaintRef.current = null;
      setRevision((value) => value + 1);
    }, 16);
  }, []);

  const attachDoc = useCallback(
    (doc: Y.Doc, journal: SpaceOutbox) => {
      // Old listeners close over their own page and account, including teardown edits.
      docRef.current?.destroy();
      undoRef.current?.destroy();
      docRef.current = doc;
      undoRef.current = localUndo(doc);
      doc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin !== REMOTE) {
          journal.record(update, () => Y.encodeStateAsUpdate(doc));
          scheduleOutbound();
        } else journal.captureSnapshot(() => Y.encodeStateAsUpdate(doc));
        scheduleRepaint();
      });
    },
    [scheduleOutbound, scheduleRepaint],
  );

  const openPage = useCallback(
    (id: string, recover = false) => {
      if (!identity || (pageIdRef.current === id && recoveryRef.current === recover)) return;
      void journalRef.current?.flush().catch((error) => setSyncError(String(error)));
      generationRef.current += 1;
      ownerRef.current = identityKey;
      recoveryRef.current = recover;
      slotRef.current = null;
      proofRef.current = null;
      sentRef.current = new Set();
      sinceRef.current.delete(id);
      pageIdRef.current = id;
      setPageId(id);
      setReady(false);
      setActors(new Map());
      actorsRef.current = new Map();
      followingRef.current = null;
      setFollowing(null);
      mineRef.current = {};
      unsubscribeJournalRef.current?.();
      const journal = spaceOutbox({ ...identity, convId, pageId: id });
      journalRef.current = journal;
      const doc = new Y.Doc();
      attachDoc(doc, journal);
      updateAccess(recover ? "unavailable" : "recovering");
      const changed = () => {
        setSyncError(journal.error);
        setPendingUpdates(journal.pending);
        if (journal.records.some((record) => !sentRef.current.has(record.id)) && !recover)
          scheduleOutbound();
      };
      unsubscribeJournalRef.current = journal.subscribe(changed);
      changed();
      const page = useSpacesStore.getState().byConv[convId]?.pages.find((page) => page.id === id);
      rememberSpacePage({ ...journal.scope, name: page?.name ?? id });
      void journal
        .hydrate()
        .then(() => {
          if (docRef.current !== doc || journalRef.current !== journal) return;
          if (journal.savedSnapshot) {
            Y.applyUpdate(doc, journal.savedSnapshot, REMOTE);
            journal.applyTo(doc);
            setReady(true);
            if (!recover && connRef.current !== "unavailable")
              updateAccess(archivedRef.current ? "archived" : null);
          }
        })
        .catch((error) => setSyncError(String(error)));
      if (!recover) {
        requestPage(id);
        if (connRef.current === "open")
          void spacesApi
            .sendControl(convId, { t: "page.active", page_id: id }, identity)
            .catch((error) => setBanner(String(error)));
      }
    },
    [attachDoc, convId, identity, identityKey, requestPage, scheduleOutbound, updateAccess],
  );

  useEffect(() => {
    if (!identity) return;
    return subscribeSpaceBus(convId, (event) => {
      if (ownerRef.current !== identityKey && pageIdRef.current !== null) return;
      if (event.kind === "connection") {
        if (event.state !== "open" || connRef.current !== "open") {
          generationRef.current += 1;
          slotRef.current = null;
          sentRef.current = new Set();
          proofRef.current = null;
        }
        connRef.current = event.state;
        patch(convId, { connection: event.state });
        if (event.state !== "open") {
          setActors(new Map());
          actorsRef.current = new Map();
          followingRef.current = null;
          setFollowing(null);
          mineRef.current = { ...mineRef.current, following: null };
          if (event.state === "unavailable") updateAccess("unavailable");
        }
        return;
      }
      if (event.kind === "control") {
        const message = parseServerMessage(event.frame);
        if (!message) return;
        switch (message.t) {
          case "space.hello": {
            slotRef.current = null;
            archivedRef.current = message.archived;
            patch(convId, {
              pages: message.pages,
              archived: message.archived,
              stale: message.doc_version > SPACE_DOC_VERSION,
              error: null,
            });
            if (recoveryRef.current) break;
            const current = pageIdRef.current;
            if (current && message.pages.some((page) => page.id === current)) requestPage(current);
            else {
              const asked = useSpacesStore.getState().actions.takeRequestedPage(convId);
              const landing = landingPage(message.pages, message.active_page_id, asked);
              if (landing) openPage(landing);
            }
            break;
          }
          case "page.opened": {
            if (
              message.page_id !== pageIdRef.current ||
              connRef.current !== "open" ||
              recoveryRef.current
            )
              break;
            const generation = generationRef.current;
            const journal = journalRef.current;
            if (!journal) break;
            const proof =
              proofRef.current?.pageId === message.page_id &&
              proofRef.current.generation === generation
                ? proofRef.current
                : null;
            proofRef.current = null;
            let authoritative: Y.Doc;
            try {
              authoritative = authoritativePage(message);
            } catch (error) {
              setSyncError(String(error));
              break;
            }
            if (!message.resume && !proof) {
              void journal.flush().catch((error) => setSyncError(String(error)));
              attachDoc(new Y.Doc(), journal);
            }
            const doc = docRef.current!;
            applyPageContent(doc, message);
            slotRef.current = message.slot;
            sinceRef.current.set(message.page_id, message.index);
            seatReadOnlyRef.current = message.read_only === "actor_ceiling";
            updateAccess(
              seatReadOnlyRef.current
                ? "actor_ceiling"
                : archivedRef.current || message.read_only === "archived"
                  ? "archived"
                  : null,
            );
            void journal
              .hydrate()
              .then(async () => {
                // A full reply can acknowledge; a resume contains only a suffix.
                if (!message.resume) await journal.acknowledge(authoritative);
                if (generation !== generationRef.current || doc !== docRef.current) return;
                journal.applyTo(doc);
                if (proof) for (const id of proof.ids) sentRef.current.delete(id);
                setReady(true);
                setSyncError(journal.error);
                setPendingUpdates(journal.pending);
                scheduleOutbound();
                if (!seatReadOnlyRef.current) publishAwareness({});
                journal.captureSnapshot(() => Y.encodeStateAsUpdate(doc));
              })
              .catch((error) => setSyncError(String(error)))
              .finally(() => authoritative.destroy());
            break;
          }
          case "page.tree": {
            patch(convId, { pages: message.pages });
            const current = pageIdRef.current;
            if (
              current &&
              !recoveryRef.current &&
              !message.pages.some((page) => page.id === current)
            ) {
              // Retain the deleted page as a readable local recovery copy.
              openPage(current, true);
              setBanner("This page was removed. Your saved copy is available to export.");
            }
            break;
          }
          case "page.closed": {
            if (message.page_id !== pageIdRef.current) break;
            slotRef.current = null;
            sentRef.current = new Set();
            if (message.reason === "evicted") requestPage(message.page_id);
            else {
              updateAccess("unavailable");
              setBanner("This page was removed. Your saved copy is available to export.");
            }
            break;
          }
          case "space.access": {
            archivedRef.current = message.archived;
            patch(convId, { archived: message.archived });
            updateAccess(
              seatReadOnlyRef.current
                ? "actor_ceiling"
                : message.archived
                  ? "archived"
                  : "recovering",
            );
            if (!message.archived && pageIdRef.current) requestPage(pageIdRef.current);
            break;
          }
          case "error": {
            const detail = message.error.detail as { reconnect?: boolean } | undefined;
            if (detail?.reconnect) {
              slotRef.current = null;
              void spacesApi.cycle(convId).catch((error) => setBanner(String(error)));
            } else setBanner(message.error.message || message.error.code);
            break;
          }
          case "page.created":
            break;
        }
        return;
      }
      const bytes = fromBase64(event.data);
      const frame = bytes ? decodeSpaceFrame(bytes) : null;
      if (!frame || frame.slot !== slotRef.current) return;
      if (frame.type === SPACE_FRAME_UPDATE) {
        if (docRef.current) applyRelayed(docRef.current, frame.payload);
      } else if (frame.type === SPACE_FRAME_AWARENESS) {
        const before = actorsRef.current;
        const after = applyAwareness(before, frame.payload);
        if (before === after) return;
        actorsRef.current = after;
        setActors(after);
        const followed = followingRef.current;
        if (followed && !after.has(followed)) follow(null);
        if (hasNewcomer(before, after) && !seatReadOnlyRef.current) publishAwareness({});
      }
    });
  }, [
    attachDoc,
    convId,
    follow,
    identity,
    identityKey,
    openPage,
    patch,
    publishAwareness,
    requestPage,
    scheduleOutbound,
    updateAccess,
  ]);

  const requested = useSpacesStore((state) => state.requestedPages[convId] ?? null);
  useEffect(() => {
    if (!requested || !pageIdRef.current) return;
    const asked = useSpacesStore.getState().actions.takeRequestedPage(convId);
    if (asked) openPage(asked);
  }, [convId, openPage, requested]);

  useEffect(() => {
    if (!identity) return;
    let disposed = false;
    ownerRef.current = identityKey;
    const savedPages = savedSpacePages(identity.accountId, convId).filter(
      (page) => page.orgId === identity.orgId,
    );
    const saved = savedPages[savedPages.length - 1];
    if (saved) openPage(saved.pageId);
    void spacesApi
      .summary(convId)
      .then((summary) => {
        if (!disposed) useSpacesStore.getState().actions.adoptSummary(convId, summary);
      })
      .catch((error) => {
        if (!disposed) patch(convId, { error: String(error) });
      });
    void acquireSpaceSocket(convId).catch((error) => {
      if (!disposed) setBanner(String(error));
    });
    return () => {
      disposed = true;
      // Capture the full recovery snapshot before destroying the Y.Doc.
      void journalRef.current
        ?.flush()
        .catch((error) => console.error("Space recovery save failed", error));
      unsubscribeJournalRef.current?.();
      unsubscribeJournalRef.current = null;
      unregisterPageRef.current?.();
      unregisterPageRef.current = null;
      generationRef.current += 1;
      releaseSpaceSocket(convId);
      docRef.current?.destroy();
      undoRef.current?.destroy();
      docRef.current = null;
      undoRef.current = null;
      journalRef.current = null;
      pageIdRef.current = null;
      slotRef.current = null;
      setReady(false);
      setPageId(null);
      if (outboundTimer.current !== undefined) clearTimeout(outboundTimer.current);
      if (proofTimer.current !== undefined) clearTimeout(proofTimer.current);
      if (awarenessTimer.current !== undefined) clearTimeout(awarenessTimer.current);
      if (repaintRef.current !== null) clearTimeout(repaintRef.current);
      outboundTimer.current = undefined;
      proofTimer.current = undefined;
      awarenessTimer.current = undefined;
      repaintRef.current = null;
    };
  }, [convId, identity, identityKey, openPage, patch]);

  const send = useCallback(
    (message: SpaceClientMessage) => {
      if (
        !identity ||
        recoveryRef.current ||
        connRef.current !== "open" ||
        readOnlyRef.current !== null
      )
        return;
      void spacesApi
        .sendControl(convId, message, identity)
        .catch((error) => setBanner(String(error)));
    },
    [convId, identity],
  );
  const retrySync = useCallback(() => {
    sentRef.current = new Set();
    void journalRef.current
      ?.hydrate()
      .then(() => flushOutbound())
      .catch((error) => setSyncError(String(error)));
    if (pageIdRef.current) requestPage(pageIdRef.current, true);
  }, [flushOutbound, requestPage]);
  const meta = useSpacesStore((state) => state.byConv[convId]);
  const recoveryPages = accountId
    ? savedSpacePages(accountId, convId).filter((page) => page.orgId === orgId)
    : [];

  return {
    pageId,
    ready: ready && ownerRef.current === identityKey,
    revision,
    actors,
    readOnly,
    banner,
    syncError,
    pendingUpdates,
    following,
    follow,
    meta,
    recoveryPages,
    retrySync,
    dismissBanner: () => setBanner(null),
    doc: docRef,
    undo: undoRef,
    pageTarget: (): SpacePageTarget | null =>
      docRef.current && journalRef.current
        ? { scope: journalRef.current.scope, snapshot: Y.encodeStateAsUpdate(docRef.current) }
        : null,
    openPage: (id: string) => openPage(id),
    recoverPage: (id: string) => openPage(id, true),
    publishAwareness,
    createPage: (options: { kind?: "page" | "folder"; parent_id?: string | null }) =>
      send({ t: "page.create", ...options }),
    renamePage: (id: string, fields: { name?: string; icon?: string | null }) =>
      send({ t: "page.rename", page_id: id, ...fields }),
    movePage: (id: string, parentId: string | null, index: number) =>
      send({ t: "page.move", page_id: id, parent_id: parentId, index }),
    deletePage: (id: string) => send({ t: "page.delete", page_id: id }),
  };
}
export type SpaceSession = ReturnType<typeof useSpaceSession>;
