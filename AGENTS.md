# ShadeGraph — agent contract

Personal repo (`personal-solo`). This tree is the product. Do not treat it as the Sean vault at `~/Projects/Workspace`. If this process cannot read files outside this worktree, follow **this file + README.md** only.

## What this is

Node-based, backend-agnostic shader tool. Same `ShaderDocument` compiles to GLSL ES, WGSL, and Three TSL. Previews must run the **actual target program** (fidelity is compiler + shared GPU renderer, not the diagram library). Legion (`snds/legion`) is the first consumer; this repo stays generic.

## Layout

| Path | Owns |
|---|---|
| `src/model/` | Durable document. Pure data. No React, GPU handles, or DOM. |
| `src/compiler/` | Pluggable backends. Headless-capable. |
| `src/preview/` | One shared renderer for main viewer and per-node thumbnails. Dirty + visible only. |
| `src/nodes/` | Node-type registry. |
| `src/ui/` | React 18 + React Flow 12 shell. |
| `src/adapters/legion/` | Import/export plan. Not a Legion dependency. |

Swap the graph view later (canvas/litegraph) without touching model, compiler, or preview.

## Do

- Keep two surfaces: **layer stack** (Photoshop-like) and **node graph** (inside a layer). Do not flatten both into one mega-graph.
- Type-check sockets. Reject illegal links at connect time (`SOCKET_COMPATIBILITY` in `src/model/document.ts`).
- JSON round-trip the document losslessly.
- `pnpm` scripts: `dev` (Vite :5180), `test`, `typecheck`.
- Current build target: **Phase 1 — Graph MVP** (React Flow wired to zustand store; add/connect/delete typed nodes; starter set `input.uv`, `math.mix/add/mul`, `noise.fbm`, `color.ramp`, `output.surface`; inspector; save/load JSON). Do not skip ahead to Legion adapter or WGSL backends unless the task says so.

## Do not

- Import Legion as a package or write into `~/Projects/Legion` except via an explicit export action (`src/adapters/legion/README.md`).
- Put shading-language source in the document model. Intent lives in the graph; backends lower it.
- Render thumbnails by screenshotting DOM or inventing a second shader path “for the editor.”
- Add a second editor framework. React Flow is the shell; canvas is the documented escape hatch only if DOM count actually bottlenecks.
- Re-open named vs zustand vs TSL-as-IR vs live-bridge unless the task is that decision.

## Profile

Direct commits are fine here. No employer (`c8`) content in this repo.
