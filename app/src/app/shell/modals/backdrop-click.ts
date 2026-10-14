/** True when a click landed on the backdrop itself, not inside the box. */
export function isBackdropClick(event: MouseEvent): boolean {
  return event.target === event.currentTarget;
}
