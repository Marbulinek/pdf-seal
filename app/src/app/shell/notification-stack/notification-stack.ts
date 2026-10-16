import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NotificationService, type NotificationType } from '../../core/notification.service';

const ICON_CLASS: Record<Exclude<NotificationType, 'loading'>, string> = {
  success: 'icon icon-check-circle',
  error: 'icon icon-alert-circle',
  info: 'icon icon-info-circle-notif',
};

/** Top-right toast stack; hovering a toast pauses its countdown. */
@Component({
  selector: 'div[appNotificationStack]',
  template: `
    @for (n of notifications.items(); track n.id) {
      <div
        class="notification notification-{{ n.type }}"
        [class.is-visible]="n.visible"
        [class.is-leaving]="n.leaving"
        [class.notification-subtle]="n.subtle"
        [attr.role]="n.type === 'error' ? 'alert' : 'status'"
        (mouseenter)="notifications.pause(n.id)"
        (mouseleave)="notifications.resume(n.id)"
      >
        <span class="notification-icon">
          @if (n.type === 'loading') {
            <span class="spinner notification-spinner" aria-hidden="true"></span>
          } @else {
            <span [class]="iconClass(n.type)" aria-hidden="true"></span>
          }
        </span>
        <span class="notification-message">{{ n.message }}</span>
        @if (n.closable) {
          <button type="button" class="notification-close" aria-label="Dismiss notification" (click)="notifications.dismiss(n.id)">&times;</button>
        }
        <span
          class="notification-progress"
          [style.display]="n.duration <= 0 ? 'none' : null"
          [style.animation-duration.ms]="n.duration"
          [style.animation-play-state]="n.paused ? 'paused' : 'running'"
        ></span>
      </div>
    }
  `,
  styleUrl: './notification-stack.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { id: 'notificationStack', class: 'notification-stack', 'aria-live': 'polite', 'aria-atomic': 'false' },
})
export class NotificationStack {
  protected readonly notifications = inject(NotificationService);

  protected iconClass(type: NotificationType): string {
    return type === 'loading' ? '' : ICON_CLASS[type];
  }
}
