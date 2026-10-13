import { Injectable, signal } from '@angular/core';

export type NotificationType = 'success' | 'error' | 'info' | 'loading';

export interface AppNotification {
  id: number;
  type: NotificationType;
  message: string;
  /** ms before auto-dismiss, or <= 0 for a persistent notification. */
  duration: number;
  closable: boolean;
  subtle: boolean;
  visible: boolean;
  leaving: boolean;
  paused: boolean;
}

export interface NotificationHandle {
  dismiss(): void;
  setMessage(message: string): void;
}

interface Timing {
  remaining: number;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Global toast stack (top-right). A toast stays for `duration` ms, pausing its
 * countdown while hovered and resuming with whatever time was left.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  readonly items = signal<AppNotification[]>([]);
  private seq = 0;
  private timing = new Map<number, Timing>();

  /**
   * duration: ms before auto-dismiss, or 0 for a persistent notification the
   * caller dismisses itself via the returned handle.
   * closable: false hides the dismiss button, for notifications tied to an
   * in-flight operation the user shouldn't close early.
   */
  show(
    message: string,
    type: NotificationType = 'info',
    duration = 6000,
    closable = true,
    opts: { subtle?: boolean } = {},
  ): NotificationHandle {
    const id = ++this.seq;
    const item: AppNotification = {
      id,
      type,
      message,
      duration,
      closable,
      subtle: !!opts.subtle,
      visible: false,
      leaving: false,
      paused: false,
    };
    this.items.update((list) => [...list, item]);
    this.timing.set(id, { remaining: duration, startedAt: Date.now(), timer: null });
    requestAnimationFrame(() => this.patch(id, { visible: true }));
    this.startCountdown(id);
    return {
      dismiss: () => this.dismiss(id),
      setMessage: (text: string) => this.patch(id, { message: text }),
    };
  }

  dismiss(id: number): void {
    const t = this.timing.get(id);
    if (t?.timer) clearTimeout(t.timer);
    this.timing.delete(id);
    this.patch(id, { visible: false, leaving: true });
    setTimeout(() => this.items.update((list) => list.filter((n) => n.id !== id)), 220);
  }

  pause(id: number): void {
    const item = this.items().find((n) => n.id === id);
    const t = this.timing.get(id);
    if (!item || !t || item.duration <= 0) return;
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    t.remaining -= Date.now() - t.startedAt;
    this.patch(id, { paused: true });
  }

  resume(id: number): void {
    this.startCountdown(id);
  }

  private startCountdown(id: number): void {
    const item = this.items().find((n) => n.id === id);
    const t = this.timing.get(id);
    if (!item || !t || item.duration <= 0) return;
    t.startedAt = Date.now();
    t.timer = setTimeout(() => this.dismiss(id), t.remaining);
    if (item.paused) this.patch(id, { paused: false });
  }

  private patch(id: number, changes: Partial<AppNotification>): void {
    this.items.update((list) => list.map((n) => (n.id === id ? { ...n, ...changes } : n)));
  }
}
