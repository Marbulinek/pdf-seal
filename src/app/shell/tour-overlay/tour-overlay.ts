import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { computePopoverPosition, spotlightRect, type Rect } from '../../../../lib/DemoTour';
import { UiService } from '../../core/ui.service';
import { TourService } from '../../features/tour/tour.service';

/**
 * The tour's dimming spotlight over the current target plus the popover card
 * (progress, Back/Next/Exit). Re-positions every frame while active so it
 * follows sheets sliding in and panels scrolling.
 */
@Component({
  selector: 'app-tour-overlay',
  template: `
    <div
      class="tour-spotlight"
      id="tourSpotlight"
      aria-hidden="true"
      [hidden]="!spot()"
      [style.top.px]="spot()?.top"
      [style.left.px]="spot()?.left"
      [style.width.px]="spot()?.width"
      [style.height.px]="spot()?.height"
    ></div>
    <div
      #popover
      class="tour-popover"
      id="tourPopover"
      role="dialog"
      aria-modal="false"
      aria-labelledby="tourPopoverTitle"
      tabindex="-1"
      [hidden]="!ui.tourActive()"
      [class.tour-popover-switching]="tour.switching()"
      [style.top.px]="pos().top"
      [style.left.px]="pos().left"
    >
      <div class="tour-popover-body">
        <div class="tour-popover-spinner" id="tourPopoverSpinner" [hidden]="!tour.spinnerVisible()" aria-hidden="true"></div>
        <h4 class="tour-popover-title" id="tourPopoverTitle">{{ tour.title() }}</h4>
        <p class="tour-popover-text" id="tourPopoverText">{{ tour.text() }}</p>
      </div>
      <div class="tour-popover-footer">
        <span class="tour-popover-progress" id="tourPopoverProgress">{{ tour.index() + 1 }} / {{ tour.steps().length }}</span>
        <div class="tour-popover-actions">
          <button type="button" class="btn btn-ghost btn-small" id="btnTourExit" (click)="tour.exit()">Exit</button>
          <button type="button" class="btn btn-ghost btn-small" id="btnTourBack" [disabled]="tour.index() === 0" (click)="tour.back()">Back</button>
          <button type="button" class="btn btn-primary btn-small" id="btnTourNext" (click)="tour.advance()">
            {{ tour.index() === tour.steps().length - 1 ? 'Finish' : 'Next' }}
          </button>
        </div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown)': 'onKeydown($event)',
    '(window:resize)': 'reposition()',
  },
})
export class TourOverlay {
  protected readonly tour = inject(TourService);
  protected readonly ui = inject(UiService);
  private readonly document = inject(DOCUMENT);
  private readonly popover = viewChild.required<ElementRef<HTMLElement>>('popover');

  protected readonly spot = signal<Rect | null>(null, {
    equal: (a, b) => a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height),
  });
  protected readonly pos = signal({ top: 0, left: 0 });
  private rafId: number | null = null;

  constructor() {
    effect(() => {
      const active = this.ui.tourActive();
      untracked(() => (active ? this.startLoop() : this.stopLoop()));
    });
    // A new step: focus the card and measure once the DOM settles.
    effect(() => {
      this.tour.positionTick();
      untracked(() => {
        if (!this.ui.tourActive()) return;
        this.popover().nativeElement.focus({ preventScroll: true });
        requestAnimationFrame(() => this.reposition());
      });
    });
    inject(DestroyRef).onDestroy(() => this.stopLoop());
  }

  private startLoop(): void {
    if (this.rafId !== null) return;
    const loop = () => {
      if (!this.ui.tourActive()) {
        this.rafId = null;
        return;
      }
      this.reposition();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stopLoop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.spot.set(null);
  }

  protected reposition(): void {
    if (!this.ui.tourActive()) return;
    const step = this.tour.currentStep();
    if (!step) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const flash = this.tour.flashSpotlight();

    let targetRect: Rect | null = null;
    if (step.target) {
      const targetEl = this.document.querySelector(step.target);
      if (targetEl) {
        targetEl.scrollIntoView({ block: 'nearest' });
        const rect = targetEl.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) targetRect = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
      }
    }
    this.spot.set(flash ?? spotlightRect(targetRect, 8, viewport));

    const el = this.popover().nativeElement;
    const position = computePopoverPosition({
      target: targetRect,
      popover: { width: el.offsetWidth || 340, height: el.offsetHeight || 140 },
      viewport,
      preferred: step.placement || 'bottom',
      gap: 14,
      margin: 16,
    });
    const next = { top: position.top, left: position.left };
    const prev = this.pos();
    if (prev.top !== next.top || prev.left !== next.left) this.pos.set(next);
  }

  protected onKeydown(e: KeyboardEvent): void {
    if (!this.ui.tourActive()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.tour.exit();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.tour.advance();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.tour.back();
    }
  }
}
