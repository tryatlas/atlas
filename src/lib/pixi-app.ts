/**
 * Ownership of the pixi `Application` instances Atlas keeps alive at once.
 *
 * Atlas runs TWO independent pixi Applications — `knowledge-graph-canvas.tsx` and
 * `memory-graph-canvas-view.tsx` — and both are routinely mounted together: the
 * Knowledge Graph tab is a persistent module (`display:none` when hidden, see
 * `center-panel.tsx`), so opening the Memory tab in graph mode puts a second
 * WebGL context on the page without taking the first one down.
 *
 * That is fine until one of them is destroyed. `Application.destroy(true, …)`
 * reads as "remove the canvas", and the Application-level JSDoc says exactly
 * that — but `AbstractRenderer.destroy()` ALSO treats a bare `true` as
 * `releaseGlobalResources`, and those resources are process-global, not
 * per-renderer: the pooled `Batch` objects, `TexturePool`, `CanvasPool` and the
 * canvas-texture cache are module singletons shared by every renderer on the
 * page. Releasing them destroys objects the OTHER, still-running Application is
 * mid-flight on. It does not throw at destroy time; it throws one frame later,
 * inside the survivor's own ticker:
 *
 *     TypeError: Cannot read properties of null (reading 'clear')
 *       at _DefaultBatcher.break     ← `batch.textures` was nulled by Batch.destroy()
 *       at _BatcherPipe.buildEnd
 *       at WebGLRenderer.render
 *
 * and the survivor's canvas stays blank from then on. A try/catch around
 * `destroy()` cannot see it, because the throw is on a later tick.
 *
 * So: register every Application here, destroy it through `destroyPixiApp`, and
 * the global pools are released only when the LAST one goes away — which is
 * when releasing them is both safe and the point. Destroying an app that is not
 * (or no longer) registered is a no-op, so the double-destroy the graph
 * components can produce — the unmount cleanup and the resolved `init()`
 * promise both firing — costs nothing.
 *
 * Because every Application comes through here, this module is also what lets
 * pixi run under the app's content-security policy. Pixi 8 builds its shader
 * and uniform-upload functions with `new Function`, and a renderer's
 * constructor checks for that first: where `eval` is refused, it throws
 * "Current environment does not allow unsafe-eval". The CSP in
 * `src-tauri/tauri.conf.json` allows only `'wasm-unsafe-eval'`, so in the
 * shipped app every `init()` rejected and both graphs drew their ruler over an
 * empty canvas, while `bun run dev` (a browser tab with no CSP) drew them fine.
 * `pixi.js/unsafe-eval` swaps those builders for eval-free ones. Allowing
 * `'unsafe-eval'` in the CSP instead would hand `eval` to every script in the
 * app. `tests/pixi-csp-contract.test.ts` keeps the import here and every
 * Application coming through this module.
 */
import "pixi.js/unsafe-eval";
import type { Application } from "pixi.js";

/**
 * Applications created but not yet destroyed. A Set rather than a counter so
 * that a repeat `destroyPixiApp` for the same instance cannot skew the count.
 */
const liveApps = new Set<Application>();
const initializing = new Set<Application>();
const destroyRequested = new WeakSet<Application>();

/** Keep pending init alive until its renderer exists, then honor teardown. */
export async function initPixiApp(
  app: Application,
  options: Parameters<Application["init"]>[0],
): Promise<void> {
  initializing.add(app);
  try {
    await app.init(options);
  } catch (error) {
    initializing.delete(app);
    try {
      if (app.renderer) destroyPixiApp(app);
      else app.stage.destroy({ children: true });
    } catch {
      // Partial initialization can also make cleanup fail. Preserve the
      // original renderer error, which is what the user needs to diagnose.
    } finally {
      liveApps.delete(app);
    }
    throw error;
  }
  initializing.delete(app);
  if (destroyRequested.has(app)) destroyPixiApp(app);
}

/**
 * Call immediately after `new Application()`, BEFORE awaiting `init()` — an
 * app that is still initialising still has to hold the global pools open.
 */
export function registerPixiApp(app: Application): void {
  liveApps.add(app);
}

/**
 * Destroys `app`, releasing pixi's process-global pools only if no other
 * Application is left to need them. Safe to call twice; the second call
 * returns without touching the app.
 */
export function destroyPixiApp(app: Application): void {
  if (!liveApps.has(app)) return;
  if (initializing.has(app)) {
    destroyRequested.add(app);
    return;
  }
  app.destroy(
    { removeView: true, releaseGlobalResources: liveApps.size === 1 },
    { children: true },
  );
  liveApps.delete(app);
}

/** Live Application count. Exported for tests. */
export function livePixiAppCount(): number {
  return liveApps.size;
}
