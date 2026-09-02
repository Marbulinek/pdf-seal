import { describe, it, expect } from 'vitest';
import FieldHistoryStack from '../../lib/FieldHistory';

describe('FieldHistoryStack', () => {
  it('starts with nothing to undo or redo', () => {
    const history = new FieldHistoryStack<number>();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });

  it('undo restores the last pushed snapshot and enables redo', () => {
    const history = new FieldHistoryStack<number>();
    history.push(1);
    expect(history.canUndo()).toBe(true);

    const restored = history.undo(2);
    expect(restored).toBe(1);
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
  });

  it('redo restores the state that was just undone', () => {
    const history = new FieldHistoryStack<number>();
    history.push(1);
    const undone = history.undo(2);
    const redone = history.redo(undone as number);
    expect(redone).toBe(2);
    expect(history.canRedo()).toBe(false);
    expect(history.canUndo()).toBe(true);
  });

  it('undo/redo are no-ops on empty stacks', () => {
    const history = new FieldHistoryStack<number>();
    expect(history.undo(1)).toBeNull();
    expect(history.redo(1)).toBeNull();
  });

  it('a new push clears the redo stack', () => {
    const history = new FieldHistoryStack<number>();
    history.push(1);
    history.undo(2);
    expect(history.canRedo()).toBe(true);

    history.push(3);
    expect(history.canRedo()).toBe(false);
  });

  it('supports multiple undo/redo steps in order (LIFO)', () => {
    const history = new FieldHistoryStack<string>();
    history.push('a');
    history.push('b');
    history.push('c');

    expect(history.undo('d')).toBe('c');
    expect(history.undo('c')).toBe('b');
    expect(history.undo('b')).toBe('a');
    expect(history.canUndo()).toBe(false);

    expect(history.redo('a')).toBe('b');
    expect(history.redo('b')).toBe('c');
    expect(history.redo('c')).toBe('d');
    expect(history.canRedo()).toBe(false);
  });

  it('caps the undo stack at the configured limit, dropping the oldest entries', () => {
    const history = new FieldHistoryStack<number>(3);
    history.push(1);
    history.push(2);
    history.push(3);
    history.push(4);
    expect(history.undoLength).toBe(3);

    expect(history.undo(5)).toBe(4);
    expect(history.undo(4)).toBe(3);
    expect(history.undo(3)).toBe(2);
    expect(history.canUndo()).toBe(false); // the original push(1) was evicted
  });

  it('exposes redoLength alongside undoLength', () => {
    const history = new FieldHistoryStack<number>();
    expect(history.redoLength).toBe(0);
    history.push(1);
    history.undo(2);
    expect(history.redoLength).toBe(1);
  });

  it('reset clears both stacks', () => {
    const history = new FieldHistoryStack<number>();
    history.push(1);
    history.undo(2);
    history.reset();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });
});
