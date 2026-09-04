# ShadeGraph

A node-based, **backend-agnostic** shader design tool. Compose layered shaders
as a live node graph, see every node's output on the node itself, solo any node
or layer to a full preview, and compile the same document to **GLSL ES**,
**WGSL** (vgpu / native WebGPU), or **Three TSL** — because previews run the
*actual* target program, the graph is an accurate live representation of the
final output.

> Working name. Standalone + reusable; **Legion** (`snds/legion`) is the first
> consumer, driving its layered planet materials.

## Why it exists

Inspired by the read-only render-pipeline visualizer in
[Codrops: "From Rays to Meshes — Building Vercel's Prism with vgpu"](https://tympanus.net/codrops/2026/09/03/from-rays-to-meshes-building-vercels-prism-with-vgpu/)
and [vgpu.sh](https://vgpu.sh). That article's author built a graph just to
*see* how shader layers mixed. ShadeGraph is the **editable, interactive**
version — and it's built to scale to any WebGPU shader work, not one hero.

## Architecture (one line each)

- **`src/model/`** — the durable, framework/backend-neutral `ShaderDocument`
  (node graph + Photoshop-style layer stack). Serializes to JSON.
- **`src/compiler/`** — pluggable backends lower the document to a target
  language (`glsl-es`, `wgsl`, `tsl`). Headless-capable for CI / agentic use.
- **`src/preview/`** — one shared renderer feeds the main viewer *and* every
  per-node thumbnail; a scheduler renders only dirty + visible nodes so large
  graphs stay interactive.
- **`src/nodes/`** — the node-type registry (palette, validation, emitters).
- **`src/ui/`** — React + React Flow 12 editor shell.
- **`src/adapters/legion/`** — imports Legion's GLSL chunks + lab-store; exports
  back. See its README.

Agents: read [AGENTS.md](AGENTS.md) before editing.

## Design plan & project state

Full design/research doc and continuity baton live in the workspace vault:
`~/Projects/Workspace/07-projects/21-shadegraph/` →
`docs/DESIGN-PLAN.md` and `SESSION-STATE.md`.

## Status

Scaffold. Contracts (model, compiler, node registry, preview scheduler) are in
place; the editor, backends, and preview runtime are the phased build (see the
design plan).

## Dev

```bash
pnpm install
pnpm dev      # vite on :5180
pnpm test
```
