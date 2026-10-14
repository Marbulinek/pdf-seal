import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, untracked, viewChild } from '@angular/core';
import { UiService } from '../../core/ui.service';
import { ExportService } from '../../features/export/export.service';
import { isBackdropClick } from './backdrop-click';

/** Download under a chosen file name (applying staged edits / bundling history first). */
@Component({
  selector: 'div[appSaveAsModal]',
  template: `
    <div class="modal-box">
      <div class="modal-header">
        <h3>Save As</h3>
        <button type="button" class="modal-close" id="closeSaveAsModalBtn" aria-label="Close" (click)="exporter.closeSaveAs()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <p class="modal-hint">Choose a name for the downloaded PDF file.</p>
      <label for="saveAsFileName" class="modal-label">File name</label>
      <div class="save-as-input-group">
        <input
          #nameInput
          type="text"
          class="modal-text-input"
          id="saveAsFileName"
          spellcheck="false"
          autocomplete="off"
          [value]="exporter.saveAsName()"
          (input)="exporter.saveAsName.set(nameInput.value)"
          (keydown.enter)="submit($event)"
        />
        <span class="save-as-ext">.pdf</span>
      </div>
      <p class="modal-hint settings-hint settings-hint-flush" id="saveAsHistoryHint">
        Whether version history is bundled into this export is controlled by "Include versions when exporting / sharing document" in Settings.
      </p>
      <div class="modal-status {{ exporter.saveAsStatus()?.type ?? '' }}" id="saveAsModalStatus">{{ exporter.saveAsStatus()?.message }}</div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelSaveAsBtn" (click)="exporter.closeSaveAs()">Cancel</button>
        <button type="button" class="btn btn-primary" id="confirmSaveAsBtn" [disabled]="exporter.saveAsBusy()" (click)="exporter.doSaveAs()">Save</button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'saveAsModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'ui.saveAsModalOpen()',
    '(click)': 'onBackdrop($event)',
  },
})
export class SaveAsModal {
  protected readonly ui = inject(UiService);
  protected readonly exporter = inject(ExportService);
  private readonly nameInput = viewChild.required<ElementRef<HTMLInputElement>>('nameInput');

  constructor() {
    effect(() => {
      if (!this.ui.saveAsModalOpen()) return;
      untracked(() =>
        setTimeout(() => {
          const el = this.nameInput().nativeElement;
          el.value = this.exporter.saveAsName();
          el.focus();
          el.select();
        }, 0),
      );
    });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    void this.exporter.doSaveAs();
  }

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.exporter.closeSaveAs();
  }
}
