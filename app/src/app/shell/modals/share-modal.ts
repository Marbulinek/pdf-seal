import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RECEIVER_STEPS, SENDER_STEPS, ShareService } from '../../features/share/share.service';
import { isBackdropClick } from './simple-modals';

/**
 * Hybrid share modal. The PDF is always encrypted in the browser; WebRTC is
 * preferred and the encrypted WebSocket relay is the resilient fallback. The
 * same box doubles as the recipient's progress view on /share/:id.
 */
@Component({
  selector: 'div[appShareModal]',
  templateUrl: './share-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'shareModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'share.modalOpen()',
    '[attr.aria-hidden]': '!share.modalOpen()',
    '(click)': 'onBackdrop($event)',
  },
})
export class ShareModal {
  protected readonly share = inject(ShareService);
  protected readonly senderSteps = SENDER_STEPS;
  protected readonly receiverSteps = RECEIVER_STEPS;

  protected activeIndex(): number {
    return this.share.stepIndex();
  }

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.share.close();
  }
}
