import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from '@angular/core';
import { SignaturesStore } from '../../features/signatures/signatures.store';

/**
 * "N unsaved changes" bar pinned under the viewer column, with the per-field
 * "View changes" breakdown, Discard and Apply. Its left edge/width track the
 * viewer column so it reads as attached to that panel.
 */
@Component({
  selector: 'div[appPendingChangesBar]',
  template: `
    <div class="pending-changes-row">
      <img class="pending-changes-icon" src="/assets/images/seal-apply-changes.webp" alt="" aria-hidden="true" />
      <div class="pending-changes-summary">
        <span id="pendingChangesLabel">{{ count() }} unsaved change{{ count() === 1 ? '' : 's' }}</span>
        <span id="pendingChangesDescription" class="pending-changes-desc">{{ signatures.pendingDescription() }}</span>
      </div>
      <button
        type="button"
        class="pending-changes-view-link"
        id="pendingChangesToggle"
        [attr.aria-expanded]="signatures.pendingDetailsOpen()"
        aria-controls="pendingChangesDetails"
        (click)="signatures.togglePendingDetails()"
      >
        View changes
      </button>
      <div class="pending-changes-actions-primary">
        <button type="button" class="btn btn-ghost" id="btnDiscardFieldChanges" (click)="signatures.discardPending()">Discard</button>
        <button type="button" class="btn btn-primary" id="btnApplyFieldChanges" (click)="apply()">Apply changes</button>
      </div>
    </div>
    <div class="pending-changes-details" id="pendingChangesDetails" [hidden]="detailsHidden()" [class.is-open]="detailsOpenClass()">
      @for (row of signatures.pendingRows(); track $index) {
        <div class="pending-change-row" [style.--row-index]="$index">
          <span class="pending-change-name" [title]="row.fromName ? row.fromName + ' → ' + row.name : row.name">
            {{ row.fromName ? row.fromName + ' → ' + row.name : row.name }}
          </span>
          <span class="pending-change-tags">
            @for (tag of row.tags; track tag.cls) {
              <span class="pending-change-tag" [class]="tag.cls">{{ tag.text }}</span>
            }
          </span>
        </div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'pendingChangesBar',
    class: 'pending-changes-bar',
    '[hidden]': 'barHidden()',
    '[class.is-visible]': 'visible()',
    '[class.is-leaving-apply]': "leaving() === 'apply'",
    '[class.is-leaving-discard]': "leaving() === 'discard'",
    '[style.left.px]': 'left()',
    '[style.width.px]': 'width()',
    '(window:resize)': 'position()',
  },
})
export class PendingChangesBar {
  protected readonly signatures = inject(SignaturesStore);
  private readonly document = inject(DOCUMENT);

  protected readonly count = this.signatures.pendingCount;
  protected readonly barHidden = signal(true);
  protected readonly visible = signal(false);
  protected readonly leaving = signal<'apply' | 'discard' | null>(null);
  protected readonly left = signal<number | null>(null);
  protected readonly width = signal<number | null>(null);
  protected readonly detailsHidden = signal(true);
  protected readonly detailsOpenClass = signal(false);
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private detailsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const count = this.count();
      untracked(() => (count > 0 ? this.show() : this.hide()));
    });
    // The details popover: unhide, then (next frame) slide open; reverse on close.
    effect(() => {
      const open = this.signatures.pendingDetailsOpen();
      untracked(() => {
        if (this.detailsTimer) clearTimeout(this.detailsTimer);
        if (open) {
          this.detailsHidden.set(false);
          requestAnimationFrame(() => this.detailsOpenClass.set(true));
        } else {
          this.detailsOpenClass.set(false);
          this.detailsTimer = setTimeout(() => this.detailsHidden.set(true), 180);
        }
      });
    });
  }

  protected apply(): void {
    this.signatures.setPendingHideReason('apply');
    this.signatures.applyPending();
  }

  protected position(): void {
    if (this.barHidden()) return;
    const col = this.document.querySelector('.viewer-column');
    if (!col) return;
    const rect = col.getBoundingClientRect();
    this.left.set(Math.round(rect.left));
    this.width.set(Math.round(rect.width));
  }

  private show(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.leaving.set(null);
    if (this.barHidden()) {
      this.barHidden.set(false);
      this.visible.set(false);
      // Restart the enter animation on every fresh appearance.
      requestAnimationFrame(() => {
        this.position();
        this.visible.set(true);
      });
    } else {
      this.position();
      this.visible.set(true);
    }
  }

  private hide(): void {
    const reason = this.signatures.pendingHideReason();
    this.signatures.setPendingHideReason(null);
    if (this.barHidden()) return;
    this.visible.set(false);
    this.leaving.set(reason === 'discard' ? 'discard' : 'apply');
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.barHidden.set(true);
      this.leaving.set(null);
    }, 320);
  }
}
