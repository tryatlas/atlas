import { useRef, useState } from "react";
import { Button } from "@tryatlas/design";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { savedSpacePages, type SavedSpacePage } from "../lib/space-outbox";
import {
  exportSavedSpacePage,
  readSavedSpacePage,
  type RecoveredSpacePage,
} from "../lib/space-recovery";

/** Local recovery remains available after the conversation or membership is gone. */
export function SpaceRecovery({ convId }: { convId: string }) {
  const accountId = useAuthStore((state) =>
    state.snapshot.status === "signed-in" ? state.snapshot.user?.id : null,
  );
  const pages = accountId ? savedSpacePages(accountId, convId) : [];
  const [recovered, setRecovered] = useState<RecoveredSpacePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  const open = async (page: SavedSpacePage) => {
    const request = ++ticket.current;
    setError(null);
    try {
      const result = await readSavedSpacePage(page);
      if (request === ticket.current) setRecovered(result);
    } catch (failure) {
      if (request === ticket.current) setError(String(failure));
    }
  };
  if (!pages.length) return null;
  return (
    <details className="shrink-0 border-b border-border p-3 text-sm">
      <summary className="cursor-pointer">Recover saved pages</summary>
      <div className="flex flex-wrap gap-2 py-2">
        {pages.map((page) => (
          <Button
            key={`${page.orgId}:${page.pageId}`}
            size="sm"
            variant="outline"
            onClick={() => void open(page)}
          >
            {page.name}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {recovered && recovered.page.accountId === accountId && (
        <div className="flex flex-col gap-2">
          <p>
            {recovered.page.name} · {recovered.nodes.length} items in the saved copy
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() =>
                void exportSavedSpacePage(recovered).catch((failure) =>
                  toast.error(String(failure)),
                )
              }
            >
              Export saved page
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void copyText(recovered.text).then((copied) => {
                  if (!copied) toast.error("The page text could not be copied.");
                })
              }
            >
              Copy page text
            </Button>
          </div>
          <textarea
            aria-label="Saved page text"
            readOnly
            value={recovered.text}
            rows={6}
            className="w-full resize-y rounded border border-border bg-background p-2"
          />
        </div>
      )}
    </details>
  );
}
