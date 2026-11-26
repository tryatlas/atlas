import { memo, useEffect, useRef, useState } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { useLocalMedia } from "@/features/media/lib/use-local-media";
import {
  CANVAS_FIELD_CLASS,
  CanvasFrame,
  CanvasMedia,
  CanvasNodeFrame,
  CanvasNote,
  CanvasShape,
} from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { NodeHandles } from "@/features/canvas/components/node-handles";
import { moveNode, nodesMap, resizeNode, type SpaceShapeType } from "../lib/space-doc";
import { bindTextField } from "../lib/bind-text-field";
import { spacesApi } from "../lib/spaces-api";
import { useSpaceCanvas } from "./space-canvas-ctx";

// The realtime canvas's node renderers — the local canvas's visual language
// (glass cards, 4-way handles) over the SHARED document model. Display data
// arrives via xyflow `data` (rebuilt per doc revision); edits write straight
// into the Y.Doc through `writeField`, so two people typing in one note merge
// character-wise instead of clobbering.

export interface SpaceNodeCommonData extends Record<string, unknown> {
  title: string;
  body: string;
  text: string;
  color: string | null;
  shapeType: SpaceShapeType | null;
  mediaKind: "image" | "video" | null;
  contentHash: string | null;
  mime: string | null;
}

/** Keep focused inputs, their selections, and IME composition in the CRDT. */
function useMergedField(nodeId: string, field: "title" | "body" | "text", _value: string) {
  const { doc, readOnly } = useSpaceCanvas();
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const current = doc();
  useEffect(() => {
    const element = ref.current;
    const node = current ? nodesMap(current).get(nodeId) : undefined;
    if (!element || !current || !node) return;
    return bindTextField(element, current, node, field, readOnly);
  }, [current, nodeId, field, readOnly]);
  return { ref, readOnly };
}

// ---------------------------------------------------------------------------

export const SpaceNoteNode = memo(function SpaceNoteNode({ id, data, selected }: NodeProps) {
  const d = data as SpaceNodeCommonData;
  const title = useMergedField(id, "title", d.title);
  const body = useMergedField(id, "body", d.body);

  return (
    <div className="group relative h-full w-full">
      <NodeHandles selected={selected} />
      <CanvasNodeFrame kind="note" selected={selected}>
        <CanvasNote
          title={
            <input
              ref={title.ref}
              defaultValue={d.title}
              readOnly={title.readOnly}
              placeholder="Untitled"
              className={cn("nodrag", CANVAS_FIELD_CLASS.noteTitle)}
            />
          }
          body={
            <textarea
              ref={body.ref}
              defaultValue={d.body}
              readOnly={body.readOnly}
              placeholder="Write something…"
              className={cn("nodrag flex-1", CANVAS_FIELD_CLASS.noteBody)}
            />
          }
        />
      </CanvasNodeFrame>
      <SpaceResizer id={id} selected={selected} minWidth={160} minHeight={100} />
    </div>
  );
});

// ---------------------------------------------------------------------------

export const SpaceTextNode = memo(function SpaceTextNode({ id, data, selected }: NodeProps) {
  const d = data as SpaceNodeCommonData;
  const text = useMergedField(id, "text", d.text);

  return (
    <div
      className={cn(
        "group relative h-full w-full rounded",
        selected && "outline outline-1 outline-primary/50",
      )}
    >
      <NodeHandles selected={selected} />
      {/* Not `CanvasText`: the field has to stay this node's own textarea. */}
      <CanvasNodeFrame kind="text" selected={selected}>
        <textarea
          ref={text.ref}
          defaultValue={d.text}
          readOnly={text.readOnly}
          placeholder="Text"
          className={cn(
            "nodrag h-full whitespace-pre-wrap break-words px-1 py-0.5",
            CANVAS_FIELD_CLASS.text,
          )}
        />
      </CanvasNodeFrame>
      <SpaceResizer id={id} selected={selected} minWidth={80} minHeight={40} />
    </div>
  );
});

// ---------------------------------------------------------------------------

export const SpaceShapeNode = memo(function SpaceShapeNode({ id, data, selected }: NodeProps) {
  const d = data as SpaceNodeCommonData;
  // Web parity: a shape's label is its `title` field, centered.
  const title = useMergedField(id, "title", d.title);

  return (
    <div className="group relative h-full w-full">
      <SpaceResizer id={id} selected={selected} minWidth={40} minHeight={40} />
      <NodeHandles selected={selected} />
      <CanvasNodeFrame kind="shape" selected={selected}>
        <CanvasShape
          shape={d.shapeType ?? "rectangle"}
          label={
            <textarea
              ref={title.ref}
              defaultValue={d.title}
              readOnly={title.readOnly}
              rows={1}
              className={cn(
                "nodrag max-h-full whitespace-pre-wrap break-words",
                CANVAS_FIELD_CLASS.shapeLabel,
              )}
            />
          }
        />
      </CanvasNodeFrame>
    </div>
  );
});

// ---------------------------------------------------------------------------

/** A titled frame. Containment is visual only — the contract has no grouping
 *  linkage, and inventing one would be invisible to the web client. */
export const SpaceGroupNode = memo(function SpaceGroupNode({ id, data, selected }: NodeProps) {
  const d = data as SpaceNodeCommonData;
  const title = useMergedField(id, "title", d.title);

  return (
    <div className="group relative h-full w-full">
      <NodeHandles selected={selected} />
      <CanvasNodeFrame kind="frame" selected={selected}>
        <CanvasFrame
          label={
            <input
              ref={title.ref}
              defaultValue={d.title}
              readOnly={title.readOnly}
              placeholder="Group"
              className={cn("nodrag", CANVAS_FIELD_CLASS.frameLabel)}
            />
          }
        />
      </CanvasNodeFrame>
      <SpaceResizer id={id} selected={selected} minWidth={120} minHeight={80} />
    </div>
  );
});

// ---------------------------------------------------------------------------

/** In-flight fetches and resolved paths, module-level: the object behind a
 *  hash is immutable, so one IPC round per hash per session is enough. */
const mediaPathCache = new Map<string, Promise<string>>();

export const SpaceMediaNode = memo(function SpaceMediaNode({ id, data, selected }: NodeProps) {
  const d = data as SpaceNodeCommonData;
  const { convId } = useSpaceCanvas();
  const [path, setPath] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const hash = d.contentHash;
  const mime = d.mime ?? "application/octet-stream";

  useEffect(() => {
    if (!hash) return;
    let alive = true;
    setFailed(false);
    setPath(null);
    let fetching = mediaPathCache.get(hash);
    if (!fetching) {
      fetching = spacesApi.mediaFetch(convId, hash, mime);
      mediaPathCache.set(hash, fetching);
      // A failed fetch must not poison the cache — the ticket path can 502.
      fetching.catch(() => mediaPathCache.delete(hash));
    }
    fetching.then((path) => alive && setPath(path)).catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [convId, hash, mime]);
  const { url, error } = useLocalMedia(path, d.mediaKind === "video" ? "video" : "image");

  return (
    <div className="group relative h-full w-full">
      <NodeHandles selected={selected} />
      <CanvasNodeFrame kind="media" selected={selected}>
        <CanvasMedia
          state={failed || error ? "error" : url === null ? "loading" : "ready"}
          src={url ?? undefined}
          kind={d.mediaKind === "video" ? "video" : "image"}
          alt=""
        />
      </CanvasNodeFrame>
      <SpaceResizer id={id} selected={selected} />
    </div>
  );
});

/** Size writes go through the doc's clamp (`max(40, round)`), and only while
 *  actively resizing — xyflow measurement passes must never write LWW sizes. */
function SpaceResizer({
  id,
  selected,
  minWidth = 60,
  minHeight = 40,
}: {
  id: string;
  selected?: boolean;
  minWidth?: number;
  minHeight?: number;
}) {
  const { doc, readOnly } = useSpaceCanvas();
  if (readOnly) return null;
  return (
    <NodeResizer
      isVisible={!!selected}
      minWidth={minWidth}
      minHeight={minHeight}
      onResize={(_, p) => {
        const d = doc();
        if (!d || !id) return;
        // A left/top handle moves the box while sizing it.
        moveNode(d, id, { x: p.x, y: p.y });
        resizeNode(d, id, { width: p.width, height: p.height });
      }}
    />
  );
}

export const SPACE_NODE_TYPES = {
  note: SpaceNoteNode,
  text: SpaceTextNode,
  shape: SpaceShapeNode,
  media: SpaceMediaNode,
  group: SpaceGroupNode,
} as const;
