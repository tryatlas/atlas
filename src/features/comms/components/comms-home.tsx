import { useMemo, useState } from "react";
import { toast } from "sonner";
import { comms } from "../lib/comms-api";
import { useCommsStore } from "../stores/comms-store";
import { useMembersStore } from "@/features/organisations/stores/members-store";
import { CreateChannelMenu } from "./create-channel-menu";
import { NewDmMenu } from "./new-dm-menu";
import { CommsHomeView } from "./views/comms-home-view";

/**
 * Team chat's home: the comms store's conversations, roster and presence,
 * handed to `CommsHomeView`, plus starting a DM from a contact row.
 */
export function CommsHome({
  activeConvId = null,
  sidebar = false,
}: {
  /** The conversation on screen beside this list (the split view), lit. */
  activeConvId?: string | null;
  /** Laid out as the split view's left column rather than a full-width
   *  page: no fade-in, since it is there from the first frame. */
  sidebar?: boolean;
} = {}) {
  const conversations = useCommsStore((s) => s.conversations);
  const discoverable = useCommsStore((s) => s.discoverable);
  const reads = useCommsStore((s) => s.reads);
  const memberList = useCommsStore((s) => s.members);
  // The DM/contact sections are unreadable without the roster (titles resolve
  // to "Unknown", contacts are simply absent), so while it is still on its
  // way the sections show placeholder rows rather than degraded ones.
  const rosterOrgId = useCommsStore((s) => s.connection.orgId);
  const rosterLoading = useMembersStore((s) =>
    rosterOrgId ? (s.byOrg[rosterOrgId]?.loading ?? false) : false,
  );
  const rosterPending = memberList.length === 0 && rosterLoading;
  const online = useCommsStore((s) => s.online);
  const me = useCommsStore((s) => s.me);
  const actions = useCommsStore((s) => s.actions);

  /** The member whose DM is being created, for the row's spinner. */
  const [startingDm, setStartingDm] = useState<string | null>(null);

  const members = useMemo(() => new Map(memberList.map((m) => [m.id, m])), [memberList]);
  const readBy = useMemo(() => new Map(reads.map((r) => [r.conv_id, r])), [reads]);

  const startDm = async (userId: string) => {
    if (startingDm) return;
    setStartingDm(userId);
    try {
      // Idempotent server-side: 200 = opened the existing one, 201 = created.
      const result = await comms.createDm(userId);
      if (useCommsStore.getState().connection.orgId !== rosterOrgId) return;
      actions.adoptConversation(result.conversation);
      actions.openConversation(result.conversation.id);
    } catch (e) {
      console.warn("comms: DM create failed:", userId, e);
      toast.error("Could not start that conversation. Try again.");
    } finally {
      setStartingDm(null);
    }
  };

  return (
    <CommsHomeView
      conversations={conversations}
      discoverable={discoverable}
      reads={readBy}
      members={members}
      online={online}
      me={me}
      rosterPending={rosterPending}
      startingDmId={startingDm}
      activeConvId={activeConvId}
      sidebar={sidebar}
      onOpen={(convId, newTab) =>
        newTab ? actions.openConversationInNewTab(convId) : actions.openConversation(convId)
      }
      onStartDm={(userId) => void startDm(userId)}
      onJoin={(convId) => actions.joinChannel(convId)}
      channelAction={<CreateChannelMenu />}
      dmAction={<NewDmMenu />}
    />
  );
}
