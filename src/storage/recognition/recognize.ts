// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset storage: shader-object recognition
// ───────────────────────────────────────────────────────────────────────────
// Phase 5's "recognition is a general, configurable strategy — a specific
// source is a configuration, not code" decision, applied. This module knows
// three source-agnostic things: file extensions, a bundled-export-name
// pattern, and generic GLSL `uniform` syntax. It knows nothing about any one
// source's naming conventions or doc-comment prose — those live entirely in
// the `RecognitionConfig` a caller supplies, built at that caller's own call
// site, never in here.
//
// This is a pure function over already-read data: an `AssetTreeNode` list
// plus a `sourceByNodeId` map of file text. It does not read the file
// system itself — that stays `src/storage/assetStore.ts`'s job via
// `DirectoryReader`, keeping this module unit-testable with literal string
// fixtures and no real disk/File System Access API.
// ═══════════════════════════════════════════════════════════════════════════

import type { AssetTreeNode } from '../tree';
import type { RecognitionConfig, RecognizedShaderObject } from './types';

/** Generic GLSL syntax, not source-specific: `uniform <type> <name>;`.
 *  Needs no configuration, per the task brief. */
const UNIFORM_DECLARATION = /\buniform\s+[A-Za-z_][\w]*\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*;/g;

/** `export const <Name> = <quote>` — the generic shape of a bundled
 *  string-constant chunk. Which export *names* count as shader objects is
 *  entirely config-driven via `exportNamePattern`. */
const EXPORTED_CONST = /export\s+const\s+([A-Za-z_]\w*)\s*=\s*(`|"|')/g;

function detectUniforms(source: string): string[] {
  const seen = new Set<string>();
  const uniforms: string[] = [];
  UNIFORM_DECLARATION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = UNIFORM_DECLARATION.exec(source)) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      uniforms.push(name);
    }
  }
  return uniforms;
}

function matchesExtension(fileName: string, extensions: string[]): boolean {
  const lower = fileName.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext.toLowerCase()));
}

interface BundledChunk {
  name: string;
  body: string;
}

/** Extracts each `export const <Name> = <quote>...<quote>` chunk whose name
 *  matches `pattern`. Generic across the three JS/TS string-quote styles;
 *  does not attempt to parse escapes inside the string, which is fine for
 *  shader-source chunks (no author is escaping the closing backtick inside
 *  a GLSL snippet in a way this needs to survive for uniform-name parsing). */
function extractBundledChunks(source: string, pattern: RegExp): BundledChunk[] {
  const chunks: BundledChunk[] = [];
  // Rebuilt without a `g`/`y` flag so repeated `.test()` calls below can't
  // trip over shared `lastIndex` state on a pattern the caller reuses.
  const nameTest = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
  EXPORTED_CONST.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXPORTED_CONST.exec(source)) !== null) {
    const [full, name, quote] = match;
    if (!nameTest.test(name)) continue;
    const bodyStart = match.index + full.length;
    const bodyEnd = source.indexOf(quote, bodyStart);
    if (bodyEnd === -1) continue;
    chunks.push({ name, body: source.slice(bodyStart, bodyEnd) });
    EXPORTED_CONST.lastIndex = bodyEnd + 1;
  }
  return chunks;
}

/** Recognizes which of `nodes` (typically a flattened `AssetTreeNode` list)
 *  look like shader source per `config`, detecting each recognized object's
 *  uniforms and any config-declared `requires`. Nodes without an entry in
 *  `sourceByNodeId` (folders, or files whose text hasn't been read/opted
 *  into recognition) are silently skipped — this never forces a read. */
export function recognizeShaderObjects(
  nodes: AssetTreeNode[],
  sourceByNodeId: Record<string, string>,
  config: RecognitionConfig,
): RecognizedShaderObject[] {
  const fileExtensions = config.fileExtensions ?? [];
  const bundledExtensions = config.bundledExtensions ?? [];
  const requiresMap = config.requires ?? {};
  const objects: RecognizedShaderObject[] = [];

  for (const node of nodes) {
    if (node.kind !== 'file') continue;
    const source = sourceByNodeId[node.id];
    if (source === undefined) continue;

    if (fileExtensions.length > 0 && matchesExtension(node.name, fileExtensions)) {
      objects.push({
        id: node.id,
        name: node.name,
        nodeId: node.id,
        path: node.path,
        uniforms: detectUniforms(source),
        requires: requiresMap[node.name] ?? [],
      });
      continue;
    }

    if (config.exportNamePattern && matchesExtension(node.name, bundledExtensions)) {
      for (const chunk of extractBundledChunks(source, config.exportNamePattern)) {
        objects.push({
          id: `${node.id}#${chunk.name}`,
          name: chunk.name,
          nodeId: node.id,
          path: node.path,
          uniforms: detectUniforms(chunk.body),
          requires: requiresMap[chunk.name] ?? [],
        });
      }
    }
  }

  return objects;
}
