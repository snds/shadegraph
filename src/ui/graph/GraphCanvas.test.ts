// Regression coverage for the "any graph with a node group renders
// completely empty" bug: every node got stuck with inline
// `visibility: hidden` forever as soon as `ShaderGraph.groups` was non-empty.
//
// Root cause (verified against the installed @xyflow/react@12.11.6 /
// @xyflow/system@0.0.82 sources): `toFlowGroups`/`toFlowNodes` build brand
// new node objects on every call, so React Flow's `<ReactFlow nodes>` prop
// gets a fresh array reference on every store update. React Flow's
// `StoreUpdater` only re-adopts nodes when that reference changes, and
// `adoptUserNodes`' identity-based `checkEquality` then resets EVERY node's
// `measured` dimensions to `undefined` (since none of our node objects are
// referentially the same as last time) — which is what drives
// `visibility: hasDimensions ? 'visible' : 'hidden'` per node. Immediately
// after, the frame's ResizeObserver reports its real (UNCHANGED) size as a
// "dimensions changed" NodeChange purely because it differs from the
// just-reset `undefined`. `onNodesChange` used to commit that back via
// `setGroupBounds` unconditionally, mutating the store and producing a new
// `graph` -> a new `rfNodes` array -> another adoption pass -> another reset
// -> another spurious report — forever. Only the frame reaches back into the
// store this way (shader-node dimension changes are ignored), which is why
// only groups triggered it, but the reset/hide hit every node sharing that
// one `<ReactFlow>` instance.
//
// This file is a plain-node unit test (no DOM/ResizeObserver/React Flow
// runtime — see `vite.config.ts`'s `test.environment: 'node'`), so it can
// only cover the fix's actual guard — `groupBoundsChanged` — directly. The
// full loop above requires a real browser to reproduce/observe (confirmed
// live via screenshot per the task's verification step); it is not
// reachable from this repo's current unit-test environment without adding
// jsdom/React Testing Library, which is out of this task's scope.

import { describe, expect, it } from 'vitest';

import { groupBoundsChanged } from './GraphCanvas';

const bounds = { x: 10, y: 20, w: 100, h: 60 };

describe('groupBoundsChanged', () => {
  it('is false for an empty patch', () => {
    expect(groupBoundsChanged(bounds, {})).toBe(false);
  });

  it('is false when every patched field equals its current value — the exact spurious NodeChange React Flow reports on every re-render once a group exists', () => {
    expect(groupBoundsChanged(bounds, { w: 100, h: 60 })).toBe(false);
    expect(groupBoundsChanged(bounds, { x: 10, y: 20, w: 100, h: 60 })).toBe(false);
  });

  it('is true when a patched dimension genuinely differs — a real resize must still commit', () => {
    expect(groupBoundsChanged(bounds, { w: 120 })).toBe(true);
    expect(groupBoundsChanged(bounds, { h: 61 })).toBe(true);
  });

  it('is true when a patched position genuinely differs — a real drag must still commit', () => {
    expect(groupBoundsChanged(bounds, { x: 11 })).toBe(true);
    expect(groupBoundsChanged(bounds, { y: 19 })).toBe(true);
  });
});
