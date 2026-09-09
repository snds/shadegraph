# Legion adapter

Binds ShadeGraph to the Legion game repo (`~/Projects/Legion`, `snds/legion`).
Legion is the first real consumer; this adapter proves the tool against a
shipping, uniform-driven, layered planet renderer.

Phase 5 reframed the whole approach: recognition is a **general, configurable
strategy** (`src/storage/recognition/`), and any one source tree — Legion
included — is a **configuration passed to it, never code baked into the
tool** (see `src/storage/recognition/recognize.ts`'s header). This directory
holds Legion's half of that config, and nothing else.

## What Legion actually looks like (confirmed against real source)

Legion bundles shader source as `export const GLSL_<NAME> = /* glsl */ \`...\``
string constants across two real files:

- `src/render/planet/glsl.ts` — `GLSL_SIMPLEX`, `GLSL_FBM`, `GLSL_CLOUDS`,
  `GLSL_PLATES`, `GLSL_TERRAIN`, `GLSL_RAMP` (6 chunks).
- `src/render/star/kelvin.ts` — `GLSL_KELVIN` (1 chunk).

7 chunks total. Two real ordering dependencies, declared in doc-comment prose
next to the export (never parsed out of that prose — see below): `GLSL_CLOUDS`
and `GLSL_TERRAIN` each require `GLSL_FBM` and `GLSL_PLATES` to be included
before them.

## What's actually built (Phase 5)

- **`recognitionConfig.ts`** — `legionRecognitionConfig`, a plain
  `RecognitionConfig` value (`bundledExtensions`, `exportNamePattern`, the 2
  `requires` entries above) matching Legion's real bundling convention. Pure
  data; imports only the `RecognitionConfig` *type* from
  `src/storage/recognition`. A caller (app code, a script) supplies this
  config to the generic `recognizeShaderObjects` — this file never runs
  recognition itself.
- **`recognitionConfig.test.ts`** — proves the config against literal
  fixture text copied verbatim from Legion's real chunks (real
  `/* glsl */`-tagged bundling syntax, real uniform lines, the real
  "Requires ..." doc-comment wording) — never a live read of
  `~/Projects/Legion` at build or runtime.
- **`src/storage/recognition/recognize.ts`** (generic, not Legion-specific) —
  scans already-read file text for standalone shader files and bundled
  `export const GLSL_*` chunks per whatever `RecognitionConfig` it's given,
  extracting `uniform <type> <name>;` declarations and surfacing each
  object's config-declared `requires`.
- **`chunk.raw`** (`src/nodes/definitions/chunk.ts`) — the one generic node
  type every recognized object becomes when a user selectively graphs it
  (`graphFromRecognizedObject`, `src/storage/recognition/graphFromRecognizedObject.ts`).
  No per-source node types — Legion's chunks and any other source's chunks
  land as the same `chunk.raw` shape, text passed through verbatim via
  `EmitContext.prelude`.
- **`ProjectManifest`** (`src/model/projectManifest.ts`, UI in
  `src/ui/manifest/`) — tracks connected folders and per-object discovery
  state (draft/saved) across a project; the shareable, committable artifact
  that discovery and selective graphing write into.

## Boundary

ShadeGraph never imports Legion as a dependency and never writes to the Legion
repo without an explicit export action. Legion consumes ShadeGraph output; the
tool stays generic. `legionRecognitionConfig`'s shape is hand-confirmed
against Legion's source at the time it was written, not fetched live.
