import { useState, useEffect, useMemo, useRef } from "react";
import {
  clearMentionCache,
  closeRecentFilesProject,
  onCliOpenProject,
  openRecentFilesProject,
  setWindowTitle,
} from "@/features/app/lib/app-lifecycle-api";
import { retargetCloudBoard } from "@/features/artifacts/lib/board-api";
import { captureActivate } from "@/features/capture/lib/capture-api";
import { onExplorerChanged } from "@/features/explorer/lib/fs-api";
import { startGitWatch } from "@/features/git/lib/git-watch-api";
import { AppLayout } from "@/features/layout/components/app-layout";
import { CommandPalette } from "@/features/command-palette/components/command-palette";
import { AskAgentHost } from "@/features/ask-agent/components/ask-agent-host";
import { useCommandPaletteStore } from "@/features/command-palette/stores/command-palette-store";
import { NewTabPalette } from "@/components/new-tab-palette";
import { LayoutSwitcher } from "@/features/layout/components/layout-switcher";
import { SearchOverlay } from "@/components/search-overlay";
import { useActionHotkeys } from "@/hooks/use-hotkey";
import {
  useKeybindingsStore,
  watchKeybindingsOnFocus,
} from "@/features/keybindings/stores/keybindings-store";
import { FirstRunDialog } from "@/features/app/components/first-run-dialog";
import { TipHost } from "@/features/tips/components/tip-host";
import { TipTriggers } from "@/features/tips/components/tip-triggers";
import { useNativeMenu } from "@/features/menu/lib/use-native-menu";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useTerminalStore } from "@/features/terminal/stores/terminal-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { startAppBoot } from "@/features/app/lib/start-app-boot";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { cycleChatAgent } from "@/features/chat/lib/switch-agent";
import { readChatTabSession } from "@/features/chat/lib/chat-tab-session";
import { HintOverlay } from "@/features/hint-nav/components/hint-overlay";
import { NavigationHints } from "@/features/keybindings/components/navigation-hints";
import {
  fileIndex,
  openFileIndex,
  markFileIndexClosed,
} from "@/features/file-picker/lib/file-picker-api";
import { activeProjectId } from "@/features/projects/lib/active-project";
import { instructionSync } from "@/features/projects/lib/instruction-sync-api";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { flushAll } from "@/features/projects/lib/flush-registry";
import { captureSnapshot } from "@/features/projects/lib/project-snapshot";
import { useGitStore } from "@/features/git/stores/git-store";
import {
  useRecentFilesStore,
  ensureRecentFilesListener,
} from "@/features/chat/stores/recent-files-store";
import { openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import { settleAndAdvance } from "@/features/chat/lib/settle-and-advance";
import { requestCloseTab } from "@/features/chat/lib/close-tab";
import { installDevSessionHold } from "@/features/chat/lib/dev-session-hold";
import { startAgentEvents } from "@/features/chat/lib/start-agent-events";
import { isDev } from "@/lib/env";
import { useAppProfile } from "@/lib/app-profile";
import { useNativeContextMenu } from "@/lib/native-context-menu";
import {
  hydrateAgentRegistry,
  startCatalogListener,
} from "@/features/agents/stores/agent-registry-store";
import { AgentOAuthModalHost } from "@/features/agents/components/agent-oauth-modal";
import { watchRemovedAgents } from "@/features/chat/lib/removed-agents";
import { watchTurnBranchChanges } from "@/features/chat/lib/branch-change-watch";
import { AgentElicitationHost } from "@/features/chat/components/agent-elicitation-host";
import { UiActionBridge } from "@/features/ui-actions/components/ui-action-bridge";
import { OrgActionLogBridge } from "@/features/org-actions/components/org-action-log-bridge";
import { notifyPullRequestWatch } from "@/features/notifications/lib/agent-notifier";
import { listenSessionPromptInjected } from "@/features/chat/lib/injected-prompt";
import { notifyChatEnvelope } from "@/features/notifications/lib/chat-notifier";
import { noteAtlasSignedIn, notifyAtlasSignedOut } from "@/features/notifications/lib/app-notifier";
import { startAppWarnings } from "@/features/notifications/lib/app-warning-notifier";
import {
  notifyModelDownload,
  notifyUpdateReady,
} from "@/features/notifications/lib/outcome-notifier";
import { logEvent } from "@/features/log/lib/log";
import { startSecurityNotifier } from "@/features/security/lib/security-notifier";
import { NotificationPanel } from "@/features/notifications/components/notification-panel";
import { FeedbackPanel } from "@/features/feedback/components/feedback-panel";
import { UpdateAvailableModal } from "@/features/updater/components/update-available-modal";
import { LoadingOrganisationOverlay } from "@/features/organisations/components/loading-organisation-overlay";
import { StopAgentsDialog } from "@/features/projects/components/stop-agents-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useQuitGuard } from "@/features/app/lib/use-quit-guard";
import { RemoveAgentDialog } from "@/features/agents/components/remove-agent-dialog";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useActiveOrgProjects, activeOrgProjectsSnapshot } from "@/features/projects/lib/org-scope";
import { pushActiveOrgAtBoot } from "@/features/organisations/lib/active-org-change";
import { comms, listenComms } from "@/features/comms/lib/comms-api";
import { createCommsEnvelopeStream } from "@/features/comms/lib/comms-envelope-stream";
import { startTeamPresenceListener } from "@/features/artifacts/lib/team-presence";
import { useTeamPresenceStore } from "@/features/artifacts/stores/team-presence-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useSettingsNav } from "@/features/settings/stores/settings-nav-store";
import { closeSettings, openSettingsSection } from "@/features/settings/lib/open-settings";
import { onSessionsAutoSettled } from "@/features/chat/lib/history-api";
import { SessionViewedTracker } from "@/features/chat/hooks/use-mark-session-viewed";
import { commsActions, pruneTyping } from "@/features/comms/stores/comms-store";
import { useUpdaterStore } from "@/features/updater/stores/updater-store";
import {
  updater,
  listenUpdateProgress,
  listenUpdateReady,
  listenUpdateApplied,
  listenUpdateError,
  listenUpdateChecking,
  listenUpdateAvailable,
} from "@/features/updater/lib/updater-api";
import { announceLinuxRelease } from "@/features/updater/lib/linux-release-notice";
import { isLinux } from "@/lib/platform";
import { Toaster, toast } from "sonner";
import { TOAST_ICONS } from "@/components/toast-icons";
import { IconThemeFonts } from "@/features/icon-theme/components/file-icon";
import { ThemeEditorHost } from "@/features/theme/components/theme-editor/theme-editor-host";
import {
  auth,
  listenAuthChanged,
  listenAuthError,
  listenAuthSignedOut,
} from "@/features/auth/lib/auth-api";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { createWakeRefresher } from "@/features/auth/lib/refresh-on-wake";
import { useMembersStore } from "@/features/organisations/stores/members-store";
import { ConnectDialog } from "@/features/auth/components/connect-dialog";
import { LinkPullRequestDialogHost } from "@/features/pull-requests/components/link-pull-request-dialog";
import { SessionDetailsDialogs } from "@/features/session-context/components/session-details-dialogs";
import { openCapture } from "@/features/capture/lib/open-capture";
import {
  openSessionInEditor,
  toggleSessionDetails,
} from "@/features/session-context/lib/details-commands";
import { clampScale, SCALE_STEP, DEFAULT_SCALE } from "@/features/settings/lib/ui-scale";
import { listenModelDone } from "@/features/settings/lib/models-api";
import { useModelsStore } from "@/features/settings/stores/models-store";
import { useLoadProjectSettings } from "@/features/settings/lib/use-scoped-setting";
import { toggleSourceControl } from "@/features/layout/lib/source-control";
import { toggleFiles } from "@/features/layout/lib/files-surface";
import { refreshProjectTree } from "@/features/explorer/lib/project-tree-model";
import { toggleTeamChat } from "@/features/layout/lib/team-chat";
import { toggleDestination } from "@/features/layout/lib/destinations";
import { toggleAgentPanel } from "@/features/layout/lib/org-agent";
import { startOrgAgentBridge } from "@/features/org-agent/lib/org-agent-bridge";
import { TooltipProvider } from "@tryatlas/design";
import { emitWindowEvent, onWindowEvent } from "@/lib/window-events";

// Developer console toggle for session holds (Universal RC groundwork).
if (isDev) installDevSessionHold();

/** Minimum gap between two wake-triggered account re-pulls. Long enough that a
 *  burst of focus edges (Space switches) costs one pull; short enough that a
 *  rename made on the web is visible the next time the user comes back. */
const AUTH_WAKE_REFRESH_MS = 5 * 60_000;

// Interface-zoom helpers (⌘+/⌘-/⌘0). They read + write the persisted
// `uiScale` setting; `updateSettings` applies it to the native WebView zoom.
function stepZoom(delta: number) {
  const { settings, actions } = useSettingsStore.getState();
  actions.updateSettings({ uiScale: clampScale(settings.uiScale + delta) });
}
const zoomIn = () => stepZoom(SCALE_STEP);
const zoomOut = () => stepZoom(-SCALE_STEP);
const zoomReset = () =>
  useSettingsStore.getState().actions.updateSettings({ uiScale: DEFAULT_SCALE });

export function App() {
  useNativeContextMenu();
  // Own model download listeners at app scope so completion notifications are
  // delivered even when Settings is closed.
  useEffect(() => {
    void useModelsStore.getState().actions.init();
    const off = listenModelDone(notifyModelDownload);
    return () => void off.then((f) => f());
  }, []);

  // App warnings (auto-fetch failing, behind remote, config.toml errors).
  useEffect(() => startAppWarnings(), []);

  // Blocking Security Agent findings (ATL-985); the rest stays on the Timeline.
  useEffect(() => startSecurityNotifier(), []);

  // The first idle sweep that settles a pile of sessions at once says so,
  // once ever (Rust keeps the flag): otherwise a long list just vanishes.
  useEffect(() => {
    const off = onSessionsAutoSettled(({ count }) => {
      toast(`Settled ${count} idle sessions`, {
        description: "Sessions idle for a few days move to the Settled shelf.",
        action: {
          label: "Settings",
          onClick: () => openSettingsSection("chat", "autoSettleAfterDays"),
        },
      });
    });
    return () => void off.then((f) => f());
  }, []);

  // A prompt Atlas sent an agent on its own (a watched pull request woke
  // it): its tab draws it as its own row, and a session off screen says so.
  useEffect(() => {
    const off = listenSessionPromptInjected((e) => {
      useChatStore
        .getState()
        .actions.addInjectedPrompt(
          e.sessionId,
          e.text,
          { source: e.source, summary: e.summary },
          e.at,
        );
      // A restart continuation is a row only; the notification is the
      // watch's.
      if (e.source === "pull-request-watch") void notifyPullRequestWatch(e);
    });
    return () => void off.then((f) => f());
  }, []);

  // Keybinding profiles: load once, then pick up hand edits to
  // keybindings.json whenever the window regains focus.
  useEffect(() => {
    void useKeybindingsStore.getState().actions.load();
    return watchKeybindingsOnFocus();
  }, []);
  useNativeMenu();

  // No Claude probe here any more. It used to run at boot to drive a banner
  // above the composer and hard-disable the input; both are gone, and probing
  // meant a fresh install spawned subprocesses for an agent it does not have
  // (ADR-0002). The one caller that still needs the answer — the post-auth
  // re-check in `agent-auth-hooks` — asks for it itself.
  useEffect(() => {
    // Agent identity registry (the native agent + registry-installed
    // externals):
    // hydrate once so pickers/glyphs/memory dropdown resolve external
    // metadata; the marketplace re-hydrates after installs.
    void hydrateAgentRegistry();
    // …and stay current: discovery finishes after boot, and installs /
    // acquisitions / settings toggles all change how an agent launches.
    startCatalogListener();
    // An uninstall drops the agent's connection with no delta to any tab on
    // it; the catalog shrinking is what settles those tabs.
    const unwatchRemoved = watchRemovedAgents();
    // A turn that moves its checkout to another branch, for the composer's
    // "Branch changed" strip.
    const unwatchBranches = watchTurnBranchChanges();
    return () => {
      unwatchRemoved();
      unwatchBranches();
    };
  }, []);

  // Warm launch with a path: when the binary is started with a folder while
  // Atlas is already open, the Rust single-instance callback forwards it here. The app is already
  // hydrated, so we just ADD it to the project list and switch to it (no race
  // with hydration). `openProject` → `addProject` dedupes by path.
  useEffect(() => {
    const unlisten = onCliOpenProject((path) => {
      if (!path) return;
      logEvent({
        source: "atlas",
        kind: "cli-launch-open-project",
        summary: `Adding project from CLI (warm launch): ${path}`,
        status: "success",
        payload: { path },
      });
      void useAppStore.getState().actions.openProject(path);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // Auto-update: route the Rust updater events into the updater store, which
  // drives the titlebar arc/badge and the <UpdateAvailableModal />. The
  // check/download/verify/stage all run in Rust; here we just reflect the phase.
  // See src/features/updater + commands::updater.
  useEffect(() => {
    const a = useUpdaterStore.getState().actions;
    const offs: Array<Promise<() => void>> = [
      listenUpdateProgress((e) => a.setDownloading(e.version, e.downloaded, e.total, e.phase)),
      listenUpdateReady((e) => {
        a.setReady(e.version);
        notifyUpdateReady(e.version);
      }),
      listenUpdateApplied((e) => {
        a.reset();
        toast.success(`Updated to Atlas ${e.version}.`);
      }),
      listenUpdateError((e) => a.setError(e.message)),
      listenUpdateChecking((e) => a.setChecking(e.checking)),
    ];
    // Linux never downloads an update, so it has no ready/restart phase:
    // announcing the release is all there is (`updater_linux.rs`).
    if (isLinux) offs.push(listenUpdateAvailable(announceLinuxRelease));
    // Hydrate from the current backend state (e.g. staged before this mount).
    // Show the titlebar badge but don't pop the modal on launch — the live
    // `atlas:update-ready` event opens it; hydration is badge-only.
    void updater.state().then((s) => {
      if (s.phase === "ready" && s.version) {
        a.setReady(s.version);
        a.dismissModal();
      }
    });
    return () => {
      for (const p of offs) void p.then((off) => off());
    };
  }, []);

  // Account auth (ATL-35). Rust owns the credential and every transition; this
  // only mirrors `atlas:auth-changed` into the store. Broadcast (not per-window)
  // so two open windows always agree on who is signed in.
  useEffect(() => {
    const a = useAuthStore.getState().actions;
    const offs: Array<Promise<() => void>> = [
      listenAuthChanged((snapshot) => {
        a.setSnapshot(snapshot);
        if (snapshot.status === "signed-in") noteAtlasSignedIn();
        // Merge the server's org list into the local switcher (adds new ones,
        // takes renamed names onto linked ones, never removes).
        // Guarded on `orgs !== null` (three-state): `null` is "not known yet"
        // (offline), not "no orgs", and must never touch the local list.
        if (snapshot.status === "signed-in" && snapshot.orgs) {
          useOrgStore.getState().actions.mergeServerOrgs(snapshot.orgs);
        }
      }),
      listenAuthError((e) => a.setError(e.message)),
      // A revoked or expired session arrives with nothing on screen, so it must
      // announce itself — the title bar quietly reverting to a signed-out icon
      // reads as a bug. Through the pipeline: toast, center and (away) a banner.
      listenAuthSignedOut((e) => notifyAtlasSignedOut(e.message)),
    ];
    void a.hydrate();
    // Re-pull on wake so an org renamed on the web shows up when the user
    // comes back to Atlas, not at the next relaunch. `atlas:window-active` is
    // the focus rising edge / page-visible signal from `window-focus.ts`, and
    // the first input after 30 s idle (below) — all throttled by one gate.
    const refreshOnWake = createWakeRefresher({
      refresh: auth.refresh,
      isSignedIn: () => useAuthStore.getState().snapshot.status === "signed-in",
      minIntervalMs: AUTH_WAKE_REFRESH_MS,
    });
    const offWindowActive = onWindowEvent("atlas:window-active", refreshOnWake);
    return () => {
      offWindowActive();
      for (const p of offs) void p.then((off) => off());
    };
  }, []);

  // Boot reconciliation of the ACTIVE org. Rust's stored value is seeded from
  // the web and historically fell back to the account's *first* organisation,
  // while the desktop's real choice lives in the local org store and is only
  // pushed on an explicit switch. Push it once at boot too, so the auth
  // snapshot — and everything keyed off it: the chat socket's target and the
  // gateway `atlas-org` billing header — follows the org actually on screen
  // rather than whichever one the server listed first. Once per launch, and
  // not at all after a switch: `pushActiveOrgAtBoot` owns that.
  const bootAuthStatus = useAuthStore((s) => s.snapshot.status);
  const bootLocalActiveOrg = useOrgStore((s) => s.activeOrganisationId);
  const bootOrganisations = useOrgStore((s) => s.organisations);
  useEffect(() => {
    pushActiveOrgAtBoot({
      signedIn: bootAuthStatus === "signed-in",
      activeOrg: bootOrganisations.find((o) => o.id === bootLocalActiveOrg),
    });
  }, [bootAuthStatus, bootLocalActiveOrg, bootOrganisations]);

  // The Timeline's cloud half, pointed at the Organisation on screen.
  //
  // App scope rather than the Timeline panel, for the same reason the chat
  // socket is: the sockets are how a teammate's Session and a new comment
  // arrive, and a panel-scoped target would mean "Timeline closed, nothing
  // arrives". Rust reads each project's binding to decide which of them are
  // actually bound to Cloud — passing paths keeps that judgement in one place.
  const cloudProjects = useActiveOrgProjects();
  const cloudProjectsKey = useMemo(
    () =>
      cloudProjects
        .map((p) => p.path)
        .sort()
        .join("\n"),
    [cloudProjects],
  );
  // Who the Timeline's sockets say is online. Listened at app scope because
  // the roster is only re-sent when somebody comes or goes: a listener that
  // mounted with the panel would miss the one sent when the sockets opened.
  useEffect(() => startTeamPresenceListener(), []);
  // The organisation agent's socket, into its store, before any of its
  // views mount: an answer landing with the panel closed is still kept.
  useEffect(() => startOrgAgentBridge(), []);
  /** The Organisation the presence rosters were heard under. */
  const presenceOrgRef = useRef<string | null>(null);
  useEffect(() => {
    const active = bootOrganisations.find((o) => o.id === bootLocalActiveOrg);
    // A local-only Organisation has no `remoteId` and nothing to point at;
    // `null` is what tears the previous tenant's sockets down.
    const orgId = bootAuthStatus === "signed-in" ? (active?.remoteId ?? null) : null;
    // A roster belongs to the tenant it was heard in. Another Organisation's
    // teammates must not show as online here while its sockets dial.
    if (presenceOrgRef.current !== orgId) {
      presenceOrgRef.current = orgId;
      useTeamPresenceStore.getState().actions.reset();
    }
    void retargetCloudBoard(orgId, cloudProjectsKey ? cloudProjectsKey.split("\n") : []).catch(
      (e) => {
        // The Timeline still renders every local Session without this; a toast
        // for a background target would be noise.
        console.warn("timeline cloud retarget failed:", e);
      },
    );
  }, [bootAuthStatus, bootLocalActiveOrg, bootOrganisations, cloudProjectsKey]);

  // Team chat: the renderer is a projection of Rust's chat state. The socket
  // lives in Rust for the app's lifetime (it is also the notification
  // transport), so this listener runs at app scope rather than with the panel —
  // a panel-scoped one would mean "panel closed, no notifications".
  useEffect(() => {
    // Frame-coalesced: see `comms-envelope-stream.ts`.
    const stream = createCommsEnvelopeStream({
      apply: (envelope) => commsActions().applyEnvelope(envelope),
      notify: notifyChatEnvelope,
    });
    const off = listenComms(stream.push);
    // Subscribe FIRST, then ask Rust to re-announce. Tauri events are not
    // buffered and the socket opens seconds after launch — possibly before this
    // component mounts — so a `resync` emitted into a void was leaving the panel
    // empty until an org switch happened to fire another one.
    void off.then(() => comms.ready()).catch(() => {});
    // There is no "stopped typing" frame, so hints are aged out on a timer.
    const prune = window.setInterval(pruneTyping, 2_000);
    return () => {
      void off.then((fn) => fn());
      window.clearInterval(prune);
      stream.dispose();
    };
  }, []);

  // Warm the member roster at APP scope, so the chat panel's first paint has
  // names — the panel used to be the only fetcher, which meant a boot with the
  // panel closed guaranteed an "Unknown"-titled DM list on first open. Guarded
  // AND keyed on the auth transition (the members-modal pattern): the org id
  // is persisted locally and ready long before the credential is.
  const bootRemoteOrgId =
    bootOrganisations.find((o) => o.id === bootLocalActiveOrg)?.remoteId ?? null;
  const bootSignedIn = bootAuthStatus === "signed-in";
  useEffect(() => {
    if (bootRemoteOrgId && bootSignedIn) {
      void useMembersStore.getState().actions.load(bootRemoteOrgId);
    }
  }, [bootRemoteOrgId, bootSignedIn]);

  // NOTE: we intentionally do NOT wipe localStorage on boot anymore. Several
  // stores legitimately persist there via zustand `persist` — the
  // sidebar's scope and Settled shelf (`atlas-sidebar`), layout prefs (`atlas-layout-prefs`),
  // the review provider/model selection — and a blanket clear was silently
  // dropping all of them on every restart. Each store carries its own
  // `version`/`migrate`, so stale keys from old builds are handled per-store.

  // One-shot bootstrap of the Rust-owned `AppState` (currentProject +
  // recentProjects), and the decision whether this session may write it
  // back. All of it lives in `app/lib/boot-sequence.ts`.
  useEffect(() => startAppBoot(), []);

  const [newTabPaletteOpen, setNewTabPaletteOpen] = useState(false);
  // The project rail's "Open module" row opens the same palette ⌘⌥N does.
  // The palette's state lives here, so the rail asks for it by event rather
  // than the state being lifted into a store for one caller.
  useEffect(() => {
    const open = () => setNewTabPaletteOpen(true);
    return onWindowEvent("atlas:new-tab-palette", open);
  }, []);
  // ⌘K's overlay keeps its state in its own store (it shares the overlay
  // with ⌘P); the rail's org-row search button still asks for it by event.
  useEffect(() => {
    const open = () => useCommandPaletteStore.getState().actions.setOpen(true);
    return onWindowEvent("atlas:command-palette", open);
  }, []);
  const [layoutSwitcherOpen, setLayoutSwitcherOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const {
    addTab,
    setActiveTab,
    activateTabByIndex,
    cycleTab,
    addGroup,
    closeGroup,
    focusAdjacentGroup,
    toggleZenMode,
  } = useLayoutStore((s) => s.actions);
  const tabs = useLayoutStore((s) => s.tabs);
  const activeTabId = useLayoutStore((s) => s.activeTabId);
  const groupOrder = useLayoutStore((s) => s.groupOrder);
  const focusedGroupId = useLayoutStore((s) => s.focusedGroupId);

  // ⌘J — toggle the terminal WITHIN the focused split column (not a global
  // instance), so it respects which pane you're working in.
  const toggleTerminal = () => {
    const st = useLayoutStore.getState();
    const g = st.focusedGroupId;
    const groupOf = (t: { groupId?: string }) => t.groupId ?? "main";
    const groupTabs = st.tabs.filter((t) => groupOf(t) === g);
    const activeTab = st.tabs.find((t) => t.id === st.activeByGroup[g]);

    const focusTerminalSoon = (tabId: string) => {
      useTerminalStore.getState().actions.requestTerminalFocus(tabId);
    };

    if (activeTab?.type === "terminal") {
      // Toggle away: the most-recent non-terminal tab in THIS column (history),
      // else the first non-terminal tab in the column.
      const back = [...st.tabHistory].reverse().find((id) => {
        const t = st.tabs.find((x) => x.id === id);
        return t && groupOf(t) === g && t.type !== "terminal";
      });
      const target = back ?? groupTabs.find((t) => t.type !== "terminal")?.id;
      if (target) setActiveTab(target);
      return;
    }

    const existing = groupTabs.find((t) => t.type === "terminal");
    if (existing) {
      setActiveTab(existing.id);
      focusTerminalSoon(existing.id);
    } else {
      const newTabId = `terminal-${Date.now()}`;
      addTab({
        id: newTabId,
        type: "terminal",
        title: "Terminal",
        closable: true,
        dirty: false,
        data: {},
      });
      focusTerminalSoon(newTabId);
    }
  };
  const currentProject = useAppStore((s) => s.currentProject);
  // The open project's `.atlas/config.toml`, read before anything acts in the
  // project: a new chat's agent (`defaultAgent`) is decided synchronously.
  useLoadProjectSettings(currentProject?.path);
  useQuitGuard();

  // Global agent event bus: one listener routes `atlas:agents` into the chat
  // store (frame-coalesced), the permission queue and the notification
  // pipeline. All of it lives in `chat/lib/start-agent-events.ts`.
  useEffect(() => startAgentEvents(), []);

  // Live file-tree updates. The fileindex watcher (started in
  // `fileindex_open_project`) emits `atlas:explorer:changed` with the
  // set of parent directories touched in each debounced batch. The project's
  // cached tree re-reads the ones it has open — agent-side file writes appear
  // in it without a refresh button, whether or not a tree is on screen. A
  // backgrounded project's resident watcher reports too, and updates that
  // project's tree, not the active one's.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void onExplorerChanged((payload) => {
      if (cancelled) return;
      const id = payload.workspaceId ?? activeProjectId();
      const root = useProjectStore.getState().projects.find((p) => p.id === id)?.path;
      if (!root) return;
      refreshProjectTree(root, payload.fullRefresh ? undefined : payload.dirs);
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Auto-save editor state when tabs change. Keyed on the tabs' order, not
  // just their count, so a tab dragged to a new place in its strip is saved.
  // And on the session a chat tab shows (`data.sessionId`): that is all a
  // restart has to put the conversation back, and it changes with no tab
  // opening, closing or moving.
  const tabOrder = useMemo(
    () => tabs.map((t) => `${t.id} ${readChatTabSession(t.data) ?? ""}`).join("\n"),
    [tabs],
  );
  // And on the terminal tabs' pane trees: a split, a closed pane or a dragged
  // divider changes nothing above, but is part of the same file. The write is
  // skipped when the payload is byte-identical (`writeEditorState`).
  const terminalTrees = useTerminalStore((s) => s.tabs);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!currentProject) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      useLayoutStore.getState().actions.saveEditorState(currentProject.path);
    }, 1000);
    return () => clearTimeout(saveTimerRef.current);
  }, [tabOrder, activeTabId, groupOrder, focusedGroupId, currentProject, terminalTrees]);

  // Maintain the chat-mention picker's "recent files" queue. Push whenever
  // an editor/media/unsupported tab appears whose data.filePath we haven't
  // seen yet in this session. Centralizing here means every call site that
  // opens a file (FilePicker, explorer, message-item link, analysis,
  // git diff, …) feeds the recents list without each having to remember to.
  const seenFileTabsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const projectPath = currentProject?.path ?? "";
    for (const t of tabs) {
      if (t.type !== "editor" && t.type !== "media" && t.type !== "unsupported") continue;
      const absPath = (t.data as Record<string, unknown> | undefined)?.filePath as
        | string
        | undefined;
      if (!absPath) continue;
      if (seenFileTabsRef.current.has(absPath)) continue;
      seenFileTabsRef.current.add(absPath);
      const rel =
        projectPath && absPath.startsWith(projectPath + "/")
          ? absPath.slice(projectPath.length + 1)
          : (absPath.split("/").pop() ?? absPath);
      useRecentFilesStore.getState().actions.push({ absPath, rel });
    }
  }, [tabs, currentProject?.path]);

  // FileIndex lifecycle: open the backend file index on project change,
  // close on project clear. The backend handles fs-watch and incremental
  // updates from that point — Cmd+P queries against the live index.
  useEffect(() => {
    if (!currentProject) {
      fileIndex.closeProject().catch(() => {});
      markFileIndexClosed();
      // Deliberately does NOT stop git watchers. This branch runs whenever the
      // *current* project becomes null, but watchers are per-project and a
      // backgrounded project must keep watching — its commits still need
      // linking to its Sessions. Tearing one down is `teardownHot`'s job, with
      // the project id it actually owns.
      // Auto-fetch, by contrast, only follows the project on screen.
      void useGitStore
        .getState()
        .actions.setAutoFetchProject(null)
        .catch(() => {});
      void closeRecentFilesProject().catch(() => {});
      // Drop the mention cache so the @-picker doesn't briefly
      // surface the previous project's notes / symbols on a fresh
      // open. Replays land via knowledge/analysis store hydration.
      void clearMentionCache().catch(() => {});
      return;
    }
    // Deliberately NOT `markFileIndexClosed()` here: switching projects keeps
    // every hot project's Rust index resident (`fileindex_open_project` is
    // idempotent for a live one), so previously-confirmed roots stay valid —
    // clearing them made the first Cmd+P/@ after every switch pay a status
    // round-trip. Roots are forgotten where indexes actually die: project
    // close (above) and project teardown (`markFileIndexClosedFor`).
    const projectId = activeProjectId();
    void openFileIndex(currentProject.path);
    // Git watcher: emits `atlas:git-changed` on commit / checkout /
    // branch ops. Replaces the 3-second polling that git-graph-panel
    // used to do via `refetchInterval` on `git_graph_signature`.
    // Keyed by project so each open project keeps its own resident watcher.
    void startGitWatch(currentProject.path, projectId).catch((e) =>
      console.warn("git watch start failed:", e),
    );
    // Mirrored instructions: tells Rust which project this window works in.
    // With `instructionSync` on it syncs and watches it; off, Rust only
    // remembers it as the project to act on when the setting is switched on.
    void instructionSync
      .start(currentProject.path, projectId)
      .catch((e) => console.warn("instruction sync start failed:", e));
    // Background fetch follows the project this window shows, so its Pull
    // badge reflects the remote (Rust `git_autofetch`).
    void useGitStore
      .getState()
      .actions.setAutoFetchProject(currentProject.path)
      .catch(() => {});
    // Capture: a bound Project just became active — open its store (which
    // also heals a folder rename) and kick its transcript import and drain.
    // A no-op for Projects that never enabled capture.
    void captureActivate(currentProject.path).catch((e) =>
      console.warn("capture activate failed:", e),
    );
    // Clear the global recents mirror SYNCHRONOUSLY before the async reload so
    // there's no window where it still shows the previous project's files
    // (the picker also filters by project as a belt-and-suspenders guard).
    useRecentFilesStore.getState().actions.hydrate([]);
    // Recent-files state: Rust loads `<project>/.atlas/recent-files.json`
    // and returns the list. We hydrate the JS mirror with it so the
    // mention picker's "Recent files" section is correct from the
    // first render of the new project.
    void openRecentFilesProject(currentProject.path, projectId)
      .then((items) => {
        useRecentFilesStore.getState().actions.hydrate(items);
      })
      .catch((e) => console.warn("recent_files_open_project failed:", e));
  }, [currentProject?.path]);

  // Native window title: `projectName - Atlas` while a project is open,
  // plain `Atlas` otherwise. This is what macOS shows on the window-menu,
  // on minimize, and on title hover — and the taskbar and Alt-Tab on Windows,
  // which is why the dev profile's window says `Atlas Dev` here.
  const { productName } = useAppProfile();
  useEffect(() => {
    const title = currentProject ? `${currentProject.name} - ${productName}` : productName;
    void setWindowTitle(title).catch(() => {});
  }, [currentProject?.name, productName]);

  // Install the singleton listener for `atlas:recent-files-changed`
  // once — every push from Rust patches the mirror in place.
  useEffect(() => {
    ensureRecentFilesListener();
  }, []);

  // Fallback for webview reloads. Native quit is held by useQuitGuard until
  // the same flush barrier finishes, including pending background documents.
  useEffect(() => {
    const onBeforeUnload = () => {
      const wsId = useProjectStore.getState().activeProjectId;
      const path = useAppStore.getState().currentProject?.path ?? null;
      // Capture first so the flush dedup compares against the CURRENT state
      // (not a stale capture from the last switch-away).
      if (wsId) captureSnapshot(wsId);
      void flushAll({ projectId: wsId, path, reason: "quit" }).catch((error) =>
        console.error("Reload save failed", error),
      );
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Chords live in the active keybinding profile (Settings → Keybindings);
  // this is only the action-id → behaviour map. See
  // `src/features/keybindings/lib/actions.ts` for the registry.
  useActionHotkeys({
    // ⌘⇧N — "Add project": the palette's sources (new, local folder, Git
    // URL, GitHub).
    "workspace.add": () => useCommandPaletteStore.getState().actions.openAddProject(),
    // ⌘⇧. — toggle the Arc-like project sidebar. (⌘. alone is the macOS
    // system "Cancel" chord and gets swallowed before reaching the webview.)
    "workspace.toggleSidebar": () => useProjectStore.getState().actions.toggleSidebar(),
    // ⌘K and ⌘P share one overlay: each chord opens its mode, switches to it
    // from the other, or closes it when it is the one on screen.
    "nav.commandPalette": () => useCommandPaletteStore.getState().actions.toggleCommands(),
    "nav.filePicker": () => useCommandPaletteStore.getState().actions.toggleFiles(),
    // ⇧⌘F, also the palette's "Search project contents": the overlay closes
    // first, so the two dialogs never stack.
    "nav.search": () => {
      useCommandPaletteStore.getState().actions.setOpen(false);
      setSearchOpen(true);
    },
    // ⌘B — the project tree, a surface tab beside the agent. The id keeps its
    // old name (it toggled the left file panel) so a rebinding still applies.
    "panels.left": toggleFiles,
    // ⌘⇧B — source control, a surface tab beside the agent. The id keeps its
    // old name so a user's rebinding of it still applies.
    "panels.right": toggleSourceControl,
    // ⌘⇧C — team chat, a surface tab that follows you between projects.
    "panels.teamChat": toggleTeamChat,
    "panels.sessionDetails": toggleSessionDetails,
    "panels.terminal": toggleTerminal,
    // ⌘⌥A — the Organisation agent, in the side panel.
    "panels.agent": toggleAgentPanel,
    // ⌥J — Knowledge, a destination: opens it, or goes back to the session
    // when it is the one on screen.
    "panels.knowledge": () => toggleDestination("knowledge"),
    // ⌘1–8 select by index; ⌘9 always jumps to the LAST tab (browser
    // convention) — the store treats i<0 as "last".
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `tabs.focus${i + 1}`,
        () => activateTabByIndex(i === 8 ? -1 : i, !useAppStore.getState().currentProject),
      ]),
    ),
    "tabs.close": () => {
      const layout = useLayoutStore.getState();
      if (layout.destinationShown) {
        layout.actions.hideDestination();
        return;
      }
      const current = layout.activeTabId;
      if (current) requestCloseTab(current);
    },
    "tabs.prev": () => cycleTab(-1, !useAppStore.getState().currentProject),
    "tabs.next": () => cycleTab(1, !useAppStore.getState().currentProject),
    // ── Split view ──
    "split.new": () => addGroup(),
    "split.focusLeft": () => focusAdjacentGroup(-1),
    "split.focusRight": () => focusAdjacentGroup(1),
    // Close the focused split column (tabs move to the left neighbour).
    "split.close": () => closeGroup(useLayoutStore.getState().focusedGroupId),
    // Zen mode: the session alone, side panels hidden. Again restores.
    "panels.zen": () => {
      if (currentProject) toggleZenMode();
    },
    // ⌥/ — cycle the coding agent (Claude Code → Codex → Atlas → …). A
    // session is paired to one agent: an empty chat flips in place; a started
    // chat opens a NEW chat bound to the next agent (per the pairing rule).
    "chat.cycleAgent": () => {
      const layout = useLayoutStore.getState();
      const tab = layout.tabs.find((t) => t.id === layout.activeTabId);
      if (!tab || tab.type !== "chat") return;
      cycleChatAgent(tab.id);
    },
    // ⌘⌥S — settle the open session (or bring it back), through the chat
    // tab's own sidebar, which moves on to the next session.
    "chat.settleSession": () => {
      const layout = useLayoutStore.getState();
      const tab = layout.tabs.find((t) => t.id === layout.activeTabId);
      if (!tab || tab.type !== "chat") return;
      settleAndAdvance(tab.id);
    },
    // ⌘T — open a surface. A single column grows a pane beside
    // it whose launcher takes a bare letter; a split window opens the focused
    // column's `+` menu, which takes the same letters.
    "tabs.openSurface": () => {
      if (!currentProject) return;
      // Always the surfaces pane, never the main one: with no pane yet it
      // opens one on the launcher; otherwise it shows the pane and opens the
      // `+` menu of its focused column (or its first).
      const layout = useLayoutStore.getState();
      const { groupOrder, focusedGroupId, actions } = layout;
      if (groupOrder.length === 1) {
        actions.setFocusedGroup(groupOrder[0]);
        actions.addGroup();
        return;
      }
      const target = focusedGroupId === groupOrder[0] ? groupOrder[1] : focusedGroupId;
      if (layout.surfaces === "hidden") actions.setSurfaces("shown");
      actions.setFocusedGroup(target);
      emitWindowEvent("atlas:open-surface-menu", { groupId: target });
    },
    // New agent chat, unbound by default (⌘T A opens one). Singleton: focuses
    // the existing chat tab and resets it to a fresh session rather than
    // opening a second chat tab.
    "tabs.newChat": () => openNewAgentChat(),
    "tabs.newChatIn": () => {
      // The active organisation's projects: the picker lists only those, so
      // another organisation's would open it empty.
      if (activeOrgProjectsSnapshot().length > 1) {
        useCommandPaletteStore.getState().actions.openProjectPicker();
      } else {
        void openNewAgentChat();
      }
    },
    // ⌘N — new untitled editor. The synthetic `untitled:<ts>` path
    // tells the editor to start with an empty buffer and to fall
    // into the save-as flow on ⌘S (see `editor-panel.tsx`).
    "tabs.newUntitled": () => {
      const ts = Date.now();
      addTab({
        id: `editor-untitled-${ts}`,
        type: "editor",
        title: "Untitled",
        closable: true,
        dirty: false,
        data: { filePath: `untitled:${ts}` },
      });
    },
    // Keyboard-first equivalent of the `+` button's dropdown.
    "nav.newTabPalette": () => setNewTabPaletteOpen(true),
    "nav.layoutSwitcher": () => setLayoutSwitcherOpen(true),
    "tabs.newTerminal": () =>
      addTab({
        id: `terminal-${Date.now()}`,
        type: "terminal",
        title: "Terminal",
        closable: true,
        dirty: false,
        data: {},
      }),
    // ⌘, toggles: Settings covers the window, so the same key takes you back.
    "app.settings": () =>
      useSettingsNav.getState().open ? closeSettings() : openSettingsSection(),
    // The org's Usage dashboard, a destination: the same key goes back.
    "usage.open": () => toggleDestination("usage"),
    // Session Capture: the project label's capture popover.
    "app.capture": openCapture,
    // The session in the main column, in the preferred editor.
    "app.openInEditor": openSessionInEditor,
    // ── Interface zoom ──
    "view.zoomIn": zoomIn,
    "view.zoomOut": zoomOut,
    "view.zoomReset": zoomReset,
  });

  return (
    // One provider at the root so every tooltip in the app shares a delay and
    // a SKIP group: hovering along a facepile shows each name instantly after
    // the first, instead of re-waiting per avatar.
    <TooltipProvider>
      <NavigationHints />
      <div className="h-screen w-screen">
        <AppLayout />
      </div>
      <CommandPalette />
      <AskAgentHost />
      <NewTabPalette open={newTabPaletteOpen} onOpenChange={setNewTabPaletteOpen} />
      <LayoutSwitcher open={layoutSwitcherOpen} onOpenChange={setLayoutSwitcherOpen} />
      <SearchOverlay open={searchOpen} onOpenChange={setSearchOpen} />
      <HintOverlay />
      <AgentOAuthModalHost />
      {/* Sign-in asks questions of its own (device codes, login URLs), and they
          arrive before the agent has any session to route them by. */}
      <AgentElicitationHost />
      <UiActionBridge />
      <SessionViewedTracker />
      <OrgActionLogBridge />
      <NotificationPanel />
      <FeedbackPanel />
      <UpdateAvailableModal />
      <FirstRunDialog />
      <TipHost />
      <TipTriggers />
      <ConnectDialog />
      <LoadingOrganisationOverlay />
      <StopAgentsDialog />
      <ConfirmDialog />
      <LinkPullRequestDialogHost />
      <SessionDetailsDialogs />
      <RemoveAgentDialog />
      <ThemeEditorHost />
      {/* Renders nothing at all until a glyph-based icon theme is in use, and
          so costs an SVG theme (including the bundled default) nothing. */}
      <IconThemeFonts />
      <Toaster
        position="bottom-right"
        closeButton
        icons={TOAST_ICONS}
        toastOptions={{
          style: {
            background: "var(--card)",
            border: "1px solid var(--border)",
            color: "var(--foreground)",
            fontSize: "var(--text-sm)",
          },
          // A notification's second action rides sonner's `cancel` slot, whose
          // stock colours are light-theme only (near-black text on a dark card).
          cancelButtonStyle: {
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--secondary-foreground)",
          },
        }}
      />
    </TooltipProvider>
  );
}
