// Pure logic behind the in-app Help tour: popover/spotlight geometry and step
// navigation. Everything here is pure -- no DOM, no timers, no localStorage --
// so it can run headless in tests.
//
// public/index.html inlines this same logic directly (the app has no frontend
// build step to import from here), the same approach as lib/SignatureTemplates.ts
// and lib/FieldHistory.ts; keep the two in sync by hand if either changes.
//
// Rects use the same shape as DOMRect's writable fields (top/left/width/height),
// in viewport pixels.

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export type Placement = 'top' | 'bottom' | 'left' | 'right';

export interface PopoverSize {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface ComputePopoverPositionInput {
  /** The element the popover points at, or null to center the popover. */
  target: Rect | null;
  popover: PopoverSize;
  viewport: Viewport;
  preferred: Placement;
  /** Gap between the target and the popover, in pixels. */
  gap: number;
  /** Minimum distance to keep from every viewport edge, in pixels. */
  margin: number;
}

export interface PopoverPosition {
  top: number;
  left: number;
  placement: Placement | 'center';
}

const OPPOSITE: Record<Placement, Placement> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

// The other axis's two sides, tried in order, when neither the preferred side
// nor its opposite fits (e.g. a target pinned to the left edge of the screen).
const CROSS_AXIS: Record<Placement, [Placement, Placement]> = {
  top: ['right', 'left'],
  bottom: ['right', 'left'],
  left: ['top', 'bottom'],
  right: ['top', 'bottom'],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Unclamped top/left for placing `popover` on `placement`'s side of `target`. */
function placeAt(target: Rect, popover: PopoverSize, placement: Placement, gap: number): { top: number; left: number } {
  switch (placement) {
    case 'top':
      return {
        top: target.top - gap - popover.height,
        left: target.left + target.width / 2 - popover.width / 2,
      };
    case 'bottom':
      return {
        top: target.top + target.height + gap,
        left: target.left + target.width / 2 - popover.width / 2,
      };
    case 'left':
      return {
        top: target.top + target.height / 2 - popover.height / 2,
        left: target.left - gap - popover.width,
      };
    case 'right':
      return {
        top: target.top + target.height / 2 - popover.height / 2,
        left: target.left + target.width + gap,
      };
  }
}

function fitsInViewport(pos: { top: number; left: number }, popover: PopoverSize, viewport: Viewport, margin: number): boolean {
  return (
    pos.left >= margin &&
    pos.left + popover.width <= viewport.width - margin &&
    pos.top >= margin &&
    pos.top + popover.height <= viewport.height - margin
  );
}

/**
 * Positions the tour popover relative to its target, trying the preferred
 * side first, then the opposite side, then the other axis's two sides, and
 * finally clamping to the viewport if nothing fits cleanly. A null target
 * (missing or zero-size step target) centers the popover instead.
 */
export function computePopoverPosition(input: ComputePopoverPositionInput): PopoverPosition {
  const { target, popover, viewport, preferred, gap, margin } = input;

  if (!target) {
    return {
      top: Math.max(margin, (viewport.height - popover.height) / 2),
      left: Math.max(margin, (viewport.width - popover.width) / 2),
      placement: 'center',
    };
  }

  const candidates: Placement[] = [preferred, OPPOSITE[preferred], ...CROSS_AXIS[preferred]];
  for (const placement of candidates) {
    const pos = placeAt(target, popover, placement, gap);
    if (fitsInViewport(pos, popover, viewport, margin)) {
      return { ...pos, placement };
    }
  }

  const fallback = placeAt(target, popover, preferred, gap);
  return {
    top: clamp(fallback.top, margin, Math.max(margin, viewport.height - popover.height - margin)),
    left: clamp(fallback.left, margin, Math.max(margin, viewport.width - popover.width - margin)),
    placement: preferred,
  };
}

/**
 * The dimming spotlight's rect: `target` padded out and clamped to the
 * viewport. A null target hides the spotlight entirely.
 */
export function spotlightRect(target: Rect | null, padding: number, viewport: Viewport): Rect | null {
  if (!target) return null;

  const left = clamp(target.left - padding, 0, viewport.width);
  const top = clamp(target.top - padding, 0, viewport.height);
  const right = clamp(target.left + target.width + padding, 0, viewport.width);
  const bottom = clamp(target.top + target.height + padding, 0, viewport.height);

  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export type StepDirection = 'next' | 'back';

/** The next/previous step index, clamped to the array's bounds. */
export function findStepIndex(steps: unknown[], from: number, direction: StepDirection): number {
  const delta = direction === 'next' ? 1 : -1;
  return clamp(from + delta, 0, Math.max(0, steps.length - 1));
}

/** Index of the first step belonging to `chapterId`, or -1 if there is none. */
export function chapterStartIndex<T extends { chapter: string }>(steps: T[], chapterId: string): number {
  return steps.findIndex((step) => step.chapter === chapterId);
}

/**
 * Layers a temporary, in-memory settings override on top of the persisted
 * settings for the duration of the tour, without ever touching what's saved.
 * A null/undefined override hands back `stored` unchanged.
 */
export function mergeSettingsOverride<T extends object>(stored: T, override: Partial<T> | null | undefined): T {
  if (!override) return stored;
  return { ...stored, ...override };
}
