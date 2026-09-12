import { describe, it, expect } from 'vitest';
import {
  computePopoverPosition,
  spotlightRect,
  findStepIndex,
  chapterStartIndex,
  mergeSettingsOverride,
  type Rect,
} from '../../lib/DemoTour';

const viewport = { width: 1000, height: 800 };
const popover = { width: 200, height: 100 };

function rectAt(top: number, left: number, width = 100, height = 40): Rect {
  return { top, left, width, height };
}

describe('computePopoverPosition', () => {
  it('centers the popover when there is no target', () => {
    const pos = computePopoverPosition({ target: null, popover, viewport, preferred: 'top', gap: 8, margin: 16 });
    expect(pos.placement).toBe('center');
    expect(pos.left).toBeCloseTo((1000 - 200) / 2);
    expect(pos.top).toBeCloseTo((800 - 100) / 2);
  });

  it('uses the preferred placement when it fits', () => {
    const target = rectAt(400, 400);
    const pos = computePopoverPosition({ target, popover, viewport, preferred: 'bottom', gap: 10, margin: 16 });
    expect(pos.placement).toBe('bottom');
    expect(pos.top).toBe(400 + 40 + 10);
  });

  it('falls back to the opposite side when the preferred side does not fit', () => {
    // Target near the top edge -- placing "top" would go negative.
    const target = rectAt(5, 400);
    const pos = computePopoverPosition({ target, popover, viewport, preferred: 'top', gap: 10, margin: 16 });
    expect(pos.placement).toBe('bottom');
  });

  it('falls back to the cross axis when neither preferred nor opposite fits vertically but a side does', () => {
    // Target sits in the vertical middle with plenty of horizontal room, but a
    // narrow viewport height rules out both top and bottom.
    const shortViewport = { width: 1000, height: 200 };
    const target = rectAt(90, 400, 100, 20);
    const pos = computePopoverPosition({ target, popover, viewport: shortViewport, preferred: 'top', gap: 10, margin: 16 });
    expect(['left', 'right']).toContain(pos.placement);
  });

  it('falls back to the preferred side, clamped, when nothing fits at all', () => {
    const tinyViewport = { width: 220, height: 120 };
    const target = rectAt(50, 50, 20, 20);
    const pos = computePopoverPosition({ target, popover, viewport: tinyViewport, preferred: 'top', gap: 10, margin: 16 });
    expect(pos.placement).toBe('top');
    expect(pos.left).toBeGreaterThanOrEqual(0);
    expect(pos.top).toBeGreaterThanOrEqual(0);
  });

  it('supports left/right preferred placements', () => {
    const target = rectAt(400, 500);
    const left = computePopoverPosition({ target, popover, viewport, preferred: 'left', gap: 10, margin: 16 });
    expect(left.placement).toBe('left');
    expect(left.left).toBe(500 - 10 - 200);

    const right = computePopoverPosition({ target, popover, viewport, preferred: 'right', gap: 10, margin: 16 });
    expect(right.placement).toBe('right');
    expect(right.left).toBe(500 + 100 + 10);
  });
});

describe('spotlightRect', () => {
  it('returns null for a null target', () => {
    expect(spotlightRect(null, 8, viewport)).toBeNull();
  });

  it('pads the target rect', () => {
    const rect = spotlightRect(rectAt(100, 100, 50, 50), 10, viewport);
    expect(rect).toEqual({ top: 90, left: 90, width: 70, height: 70 });
  });

  it('clamps padding to the viewport edges', () => {
    const rect = spotlightRect(rectAt(5, 5, 20, 20), 20, viewport);
    expect(rect!.top).toBe(0);
    expect(rect!.left).toBe(0);
  });

  it('clamps the far edge to the viewport too', () => {
    const rect = spotlightRect(rectAt(780, 980, 30, 30), 20, viewport);
    expect(rect!.width).toBeLessThanOrEqual(viewport.width - rect!.left);
    expect(rect!.height).toBeLessThanOrEqual(viewport.height - rect!.top);
  });
});

describe('findStepIndex', () => {
  const steps = [0, 1, 2, 3, 4];

  it('advances forward', () => {
    expect(findStepIndex(steps, 1, 'next')).toBe(2);
  });

  it('steps backward', () => {
    expect(findStepIndex(steps, 1, 'back')).toBe(0);
  });

  it('clamps at the end', () => {
    expect(findStepIndex(steps, 4, 'next')).toBe(4);
  });

  it('clamps at the start', () => {
    expect(findStepIndex(steps, 0, 'back')).toBe(0);
  });

  it('handles an empty step list', () => {
    expect(findStepIndex([], 0, 'next')).toBe(0);
  });
});

describe('chapterStartIndex', () => {
  const steps = [
    { chapter: 'intro' },
    { chapter: 'intro' },
    { chapter: 'signatures' },
    { chapter: 'templates' },
  ];

  it('finds the first step of a chapter', () => {
    expect(chapterStartIndex(steps, 'signatures')).toBe(2);
  });

  it('returns -1 for an unknown chapter', () => {
    expect(chapterStartIndex(steps, 'nope')).toBe(-1);
  });
});

describe('mergeSettingsOverride', () => {
  it('returns the stored settings unchanged when there is no override', () => {
    const stored = { a: 1, b: 2 };
    expect(mergeSettingsOverride(stored, null)).toBe(stored);
    expect(mergeSettingsOverride(stored, undefined)).toBe(stored);
  });

  it('layers the override on top of stored settings', () => {
    const stored = { a: 1, b: 2 };
    expect(mergeSettingsOverride(stored, { b: 5 })).toEqual({ a: 1, b: 5 });
  });
});
