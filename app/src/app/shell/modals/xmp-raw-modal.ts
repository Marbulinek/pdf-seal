import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { UiService } from '../../core/ui.service';
import { isBackdropClick } from './backdrop-click';

@Component({
  selector: 'div[appXmpRawModal]',
  template: `
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="xmpRawModalTitle">
      <div class="modal-header">
        <h3 id="xmpRawModalTitle">Raw XMP metadata</h3>
        <button type="button" class="modal-close" id="closeXmpRawModalBtn" aria-label="Close" (click)="ui.xmpRaw.set(null)">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <pre class="xmp-raw-body" id="xmpRawBody">{{ ui.xmpRaw() }}</pre>
    </div>
  `,
  styleUrl: './xmp-raw-modal.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'xmpRawModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'ui.xmpRaw() !== null',
    '[attr.aria-hidden]': 'ui.xmpRaw() === null',
    '(click)': 'onBackdrop($event)',
  },
})
export class XmpRawModal {
  protected readonly ui = inject(UiService);

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.ui.xmpRaw.set(null);
  }
}
