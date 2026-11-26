import { useEffect, useRef, useState } from "react";
import { GraphNodeList } from "@/components/graph-node-list";
import { Application } from "pixi.js";
import { destroyPixiApp, initPixiApp, registerPixiApp } from "@/lib/pixi-app";
import { canvasResolution } from "@/lib/ui-zoom";
import { GraphInitError } from "@/components/graph-init-error";
import { GraphRuler, type Viewport } from "@/components/graph-ruler";
import { graphPalette } from "@/components/graph-palette";
import { onThemeApplied, themeBase } from "@/features/theme/theme-values";
import { neighborsOf, type GraphLayout, type ProjectGraph } from "../../lib/knowledge-graph-model";
import { buildKnowledgeScene, type KnowledgeSceneState } from "../../lib/knowledge-graph-scene";

/**
 * Hosts the knowledge graph's pixi `Application` at a measured size and feeds
 * selection into the scene. Props only.
 */
export function KnowledgeGraphCanvas({
  graph,
  width,
  height,
  selectedId,
  onSelect,
  onActivate,
  initialLayout,
  onLayoutChange,
}: {
  graph: ProjectGraph;
  width: number;
  height: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onActivate: (id: string) => void;
  initialLayout: GraphLayout;
  /** Captured when the scene is built, so the teardown flush saves to the
   *  project these positions belong to. */
  onLayoutChange: (layout: GraphLayout) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const latestLayout = useRef(initialLayout);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const [initError, setInitError] = useState<string | null>(null);
  const vpRef = useRef<Viewport>({ x: 0, y: 0, scale: 1 });
  const vpRafRef = useRef(false);
  // Selection state is pushed in via a ref so it doesn't force a Pixi
  // teardown/recreate cycle.
  const sceneRef = useRef<KnowledgeSceneState>({
    selectedId,
    neighbors: new Set(),
    draggingId: null,
    draggingNeighbors: new Set(),
    zoom: 1,
    palette: graphPalette(),
  });

  // The scene is drawn into a WebGL canvas, so it cannot inherit a CSS custom
  // property the way the rest of the app does — a theme switch has to push a
  // new palette in and force one more frame. Replacing the scene OBJECT is what
  // does the forcing: the ticker early-outs on `scene === lastScene` once the
  // simulation has gone to sleep, and a settled graph is the normal case.
  useEffect(
    () =>
      onThemeApplied(() => {
        sceneRef.current = { ...sceneRef.current, palette: graphPalette() };
      }),
    [],
  );

  useEffect(() => {
    const neighbors = selectedId ? neighborsOf(selectedId, graph.edges) : new Set<string>();
    sceneRef.current = { ...sceneRef.current, selectedId, neighbors };
  }, [selectedId, graph.edges]);

  // Esc deselects (mirrors the "click empty area" affordance).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedId !== null) onSelect(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId, onSelect]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let teardown: (() => void) | null = null;
    let createdApp: Application | null = null;

    // Canvas built imperatively each mount so React StrictMode's
    // double-mount can't hand a half-destroyed WebGL canvas to a fresh
    // Pixi Application (caused the `shaderSource` crash in WKWebView).
    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    host.appendChild(canvas);

    const app = new Application();
    registerPixiApp(app);
    createdApp = app;
    void initPixiApp(app, {
      canvas,
      width,
      height,
      resolution: canvasResolution(),
      antialias: true,
      backgroundAlpha: 0,
      autoDensity: true,
      // WKWebView's WebGL2 path is flaky; pin v1.
      preferWebGLVersion: 1,
    })
      .then(() => {
        if (disposed) {
          try {
            destroyPixiApp(app);
          } catch {
            /* ignore */
          }
          return;
        }
        setInitError(null);
        const pushViewport = (v: Viewport) => {
          vpRef.current = v;
          if (!vpRafRef.current) {
            vpRafRef.current = true;
            requestAnimationFrame(() => {
              vpRafRef.current = false;
              setViewport(vpRef.current);
            });
          }
        };
        teardown = buildKnowledgeScene(app, {
          graph,
          width,
          height,
          sceneRef,
          initialLayout: latestLayout.current,
          onSelect,
          onActivate,
          onViewport: pushViewport,
          onLayoutChange: (layout) => {
            latestLayout.current = layout;
            onLayoutChange(layout);
          },
          labelFontFamily: themeBase("font-sans") || "system-ui, sans-serif",
        });
      })
      .catch((e: unknown) => {
        // A scene torn down mid-init fails for that reason, and the cleanup
        // below handles it. Any other failure is shown: a renderer that never
        // started otherwise reads as a graph with nothing in it.
        if (!disposed) setInitError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      disposed = true;
      if (teardown) {
        try {
          teardown();
        } catch {
          /* ignore */
        }
      }
      if (createdApp) {
        try {
          destroyPixiApp(createdApp);
        } catch {
          /* ignore */
        }
      }
      try {
        host.removeChild(canvas);
      } catch {
        /* ignore */
      }
    };
    // A resize rebuilds the app; callbacks are captured as of the build.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, width, height]);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" />
      {initError ? (
        <GraphInitError message={initError} source="Knowledge: drawing the graph" />
      ) : (
        <GraphRuler width={width} height={height} viewport={viewport} />
      )}
      <GraphNodeList
        label="Pages in the graph"
        nodes={graph.nodes}
        selectedId={selectedId}
        onActivate={onActivate}
      />
    </div>
  );
}
