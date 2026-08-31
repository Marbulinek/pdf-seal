// Pure undo/redo stack semantics for the Signatures panel's History section.
// public/index.html inlines this same push/undo/redo/reset/cap logic
// directly (the app has no frontend build step to import from here),
// against full document snapshots (file/pdfDoc/fields/baseline/etc, see
// captureDocumentSnapshot() there) so undo/redo can reach back across an
// "Apply changes" boundary, not just a plain staged field edit -- this
// module exists so that logic has unit coverage; keep the two in sync by
// hand if either changes.
export default class FieldHistoryStack<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  private readonly limit: number;

  constructor(limit = 100) {
    this.limit = limit;
  }

  // Records `snapshot` as the state to return to on the next undo, and
  // discards any redo history -- a fresh edit invalidates whatever was
  // previously undone.
  push(snapshot: T): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  // Pops the most recent snapshot off the undo stack, pushing `current`
  // onto the redo stack so it can be restored later. Returns null if
  // there's nothing to undo.
  undo(current: T): T | null {
    if (this.undoStack.length === 0) return null;
    const previous = this.undoStack.pop() as T;
    this.redoStack.push(current);
    return previous;
  }

  // Inverse of undo(): pops the redo stack, pushing `current` back onto
  // the undo stack. Returns null if there's nothing to redo.
  redo(current: T): T | null {
    if (this.redoStack.length === 0) return null;
    const next = this.redoStack.pop() as T;
    this.undoStack.push(current);
    return next;
  }

  reset(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLength(): number {
    return this.undoStack.length;
  }

  get redoLength(): number {
    return this.redoStack.length;
  }
}
