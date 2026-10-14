import { decodeFlags, ANNOTATION_FLAG_BITS, FIELD_FLAG_BITS } from './field-keys';
import { choiceFieldIconClass, isEditableField, isRectPracticallyInvisible, isRemovableField, rectsEqual } from './field-rules';
import type { DocField } from './models';

const field = (patch: Partial<DocField>): DocField => ({ name: 'f', type: 'Signature', page: 0, rect: null, ...patch });

describe('field rules', () => {
  it('only unsigned signature fields are editable', () => {
    expect(isEditableField(field({}))).toBe(true);
    expect(isEditableField(field({ signed: true }))).toBe(false);
    expect(isEditableField(field({ type: 'TextField' }))).toBe(false);
    expect(isEditableField(null)).toBe(false);
  });

  it('any named field is removable, signed and non-signature ones included', () => {
    expect(isRemovableField(field({}))).toBe(true);
    expect(isRemovableField(field({ signed: true }))).toBe(true);
    expect(isRemovableField(field({ type: 'TextField' }))).toBe(true);
    expect(isRemovableField(field({ name: '' }))).toBe(false);
    expect(isRemovableField(null)).toBe(false);
  });

  it('treats near-zero rects as invisible, with a smaller threshold for choice widgets', () => {
    expect(isRectPracticallyInvisible({ x: 0, y: 0, width: 0, height: 0 })).toBe(true);
    expect(isRectPracticallyInvisible({ x: 0, y: 0, width: 200, height: 60 })).toBe(false);
    expect(isRectPracticallyInvisible({ x: 0, y: 0, width: 8, height: 8 }, 'CheckBox')).toBe(false);
    expect(isRectPracticallyInvisible(null)).toBe(false);
  });

  it('compares rects within a small epsilon', () => {
    expect(rectsEqual({ x: 1, y: 1, width: 10, height: 10 }, { x: 1.001, y: 1, width: 10, height: 10 })).toBe(true);
    expect(rectsEqual({ x: 1, y: 1, width: 10, height: 10 }, { x: 2, y: 1, width: 10, height: 10 })).toBe(false);
    expect(rectsEqual(null, null)).toBe(true);
  });

  it('picks icons for choice fields only', () => {
    expect(choiceFieldIconClass('CheckBox')).toBe('icon-check-square');
    expect(choiceFieldIconClass('RadioGroup')).toBe('icon-radio');
    expect(choiceFieldIconClass('Signature')).toBeNull();
  });

  it('decodes annotation and field flag bits', () => {
    expect(decodeFlags('4', ANNOTATION_FLAG_BITS)).toEqual(['Print']);
    expect(decodeFlags('3', FIELD_FLAG_BITS)).toEqual(['ReadOnly', 'Required']);
    expect(decodeFlags('0', FIELD_FLAG_BITS)).toEqual(['None']);
    expect(decodeFlags('1024', FIELD_FLAG_BITS)).toEqual(['Unknown (1024)']);
  });
});
