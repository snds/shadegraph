# Legion adapter

Binds ShadeGraph to the Legion game repo (`~/Projects/Legion`, `snds/legion`).
Legion is the first real consumer; this adapter proves the tool against a
shipping, uniform-driven, layered planet renderer.

## What Legion already exposes (the seam we hook into)

- **Composable GLSL chunks** — `GLSL_SIMPLEX`, `GLSL_FBM`, `GLSL_PLATES`,
  `GLSL_TERRAIN`, `GLSL_RAMP`, `GLSL_CLOUDS` (`src/render/planet/glsl.ts`),
  concatenated in `src/render/planet/shaders.ts`. These map 1:1 to ShadeGraph
  **`legion.chunk.*` nodes**.
- **Uniform-driven materials** — `uDisplacement`, `uNormalStrength`,
  `uCloudShadow`, `uOceanShallow/Deep`, … → ShadeGraph **exposed params** with
  `bindUniform`.
- **Per-archetype lab-store** (`src/render/planet/lab-store.ts`, localStorage
  v4; rocky / continuum / star / blackhole / nebula) with Save/Revert → maps to
  ShadeGraph **documents per archetype** + **blackboard export**.
- **Conceptual layers** — surface globe, atmosphere, clouds, rings, giant
  bands, distant impostor → ShadeGraph **layer stack**.

## Adapter surface (to build — Phase 4)

1. `importGlslChunks()` — read Legion's `glsl.ts` chunk exports and register a
   `legion.chunk.<NAME>` node definition for each (inputs/uniforms parsed from
   the chunk signature).
2. `importArchetype(type)` — build a `ShaderDocument` from an archetype's
   current shader + lab-store dials, so the existing look loads as a graph.
3. `exportBlackboard(doc)` — emit a lab-store-compatible dial set (the existing
   Save/Revert path keeps working; ShadeGraph just authors it).
4. `exportProgram(doc, 'glsl-es')` — regenerate `shaders.ts`-shaped source, or
   feed uniforms live via a dev bridge (see below).

## Live bridge (optional, dev only)

A tiny websocket/postMessage channel so editing in ShadeGraph updates a running
Legion dev server in real time (mirrors the `__continuumAccept` hooks already in
Legion). Off by default; ShadeGraph is fully usable standalone.

## Boundary

ShadeGraph never imports Legion as a dependency and never writes to the Legion
repo without an explicit export action. Legion consumes ShadeGraph output; the
tool stays generic.
