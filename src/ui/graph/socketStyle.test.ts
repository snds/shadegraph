// Handle colour is the only cue for "what plugs into what", so every socket
// type must have one, and no two may collide.

import { describe, expect, it } from 'vitest';

import { SOCKET_COMPATIBILITY, type SocketType } from '../../model/document';
import { SOCKET_COLORS, SOCKET_LEGEND, socketColor } from './socketStyle';

const ALL = Object.keys(SOCKET_COMPATIBILITY) as SocketType[];

describe('socket colours', () => {
  it('covers every socket type in the model', () => {
    expect(Object.keys(SOCKET_COLORS).sort()).toEqual([...ALL].sort());
  });

  it('assigns a distinct colour to each type', () => {
    const values = Object.values(SOCKET_COLORS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('legends every type exactly once', () => {
    expect([...SOCKET_LEGEND].sort()).toEqual([...ALL].sort());
  });

  it('never returns an empty colour for an unknown type', () => {
    expect(socketColor(undefined)).toMatch(/^#[0-9a-f]{6}$/i);
    expect(socketColor('nope' as SocketType)).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
