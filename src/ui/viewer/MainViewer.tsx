// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Main viewer
// ───────────────────────────────────────────────────────────────────────────
// Mounts the ONE shared `PreviewRenderer` (`src/preview/renderer.ts`) onto a
// canvas and keeps it in sync with the store: every `doc` change is forwarded
// to `renderer.setDocument`, which itself decides (via `topologySignature`)
// whether that means a real recompile or a direct uniform write. This file
// owns none of that decision — it is pure plumbing between React/the store
// and the renderer, same division of responsibility as `notice.ts` bridging
// `store.lastError` to the toast.
//
// Contract with `App.tsx` (which must not otherwise be edited):
//   • props-free — reads `useEditorStore` directly
//   • renders exactly one root element: the whole
//     <footer className="sg-viewer"> (Phase 1 reserved this exact slot)
//   • named export `MainViewer`
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef } from 'react';

import { createPreviewRenderer, type PreviewRenderer } from '../../preview/renderer';
import { useEditorStore } from '../store';
import './mainViewer.css';

/** Forwards the renderer's compile-error/recovery signal to `store.lastError`
 *  (the one channel `NoticeToast` already renders), without ever clobbering
 *  some OTHER, unrelated error that arrived in between. */
function createCompileErrorBridge(): (message: string | null) => void {
  let mine: string | null = null;
  return (message) => {
    if (message !== null) {
      mine = message;
      useEditorStore.setState({ lastError: message });
      return;
    }
    if (mine !== null && useEditorStore.getState().lastError === mine) {
      useEditorStore.setState({ lastError: null });
    }
    mine = null;
  };
}

export function MainViewer() {
  const doc = useEditorStore((s) => s.doc);
  const viewerSource = useEditorStore((s) => s.viewerSource);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<PreviewRenderer | null>(null);

  // Create the one shared renderer once per mount. Idempotent under
  // StrictMode's double-invoke: `dispose()` tears the WebGL context down
  // cleanly before the second mount creates a fresh one. Published to the
  // store so `ShaderNodeCard` can drive its live thumbnail off the SAME
  // renderer/GPU context — never a second one.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createPreviewRenderer(canvas, {
      onCompileError: createCompileErrorBridge(),
      // Same compile the GPU just bound (or tried to) — see CompiledProgram's
      // header comment in renderer.ts. The code panel and node diagnostic
      // badges both read this from the store rather than recompiling.
      onCompiled: (program) => useEditorStore.setState({ compiledProgram: program }),
    });
    rendererRef.current = renderer;
    useEditorStore.getState().setPreviewRenderer(renderer);
    return () => {
      useEditorStore.getState().setPreviewRenderer(null);
      useEditorStore.setState({ compiledProgram: null });
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Keep the renderer's rig + document current. `setRig` no-ops when
  // unchanged; `setDocument` decides recompile-vs-uniform-write itself.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setRig(doc.previewRig);
    renderer.setDocument(doc);
  }, [doc]);

  // Keep the renderer's soloed node/layer (or full composite) current. The
  // code panel reads the same `viewerSource` from the store to display the
  // identical slice, so both always agree on what "the viewer is showing" is.
  useEffect(() => {
    rendererRef.current?.setViewerSource(viewerSource);
  }, [viewerSource]);

  // Canvas backing-store size must match its CSS box in device pixels, or
  // the render looks blurry/stretched; a ResizeObserver keeps it correct
  // across window resizes and the inspector/layer panes changing width.
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const apply = (width: number, height: number) => {
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      rendererRef.current?.resize(canvas.width, canvas.height);
    };
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      apply(width, height);
    });
    observer.observe(container);
    apply(container.clientWidth, container.clientHeight);
    return () => observer.disconnect();
  }, []);

  return (
    <footer className="sg-viewer" aria-label="Main viewer" ref={containerRef}>
      <canvas ref={canvasRef} className="sg-viewer__canvas" />
    </footer>
  );
}
