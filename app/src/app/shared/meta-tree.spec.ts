import { TestBed } from '@angular/core/testing';
import { highlightParts } from './meta-highlight';
import { MetaTree } from './meta-tree';
import { filterMetaTree, metaEntriesOf } from './meta-value';

describe('meta tree', () => {
  it('lists object and array entries', () => {
    expect(metaEntriesOf({ a: 1 })).toEqual([['a', 1]]);
    expect(metaEntriesOf(['x', 'y'])).toEqual([
      ['[0]', 'x'],
      ['[1]', 'y'],
    ]);
  });

  it('keeps only matching keys/values, whole branches on a key match', () => {
    const tree = { Type: '/Annot', Rect: [0, 0, 10, 10], MK: { BG: [1], Caption: 'Sign' } };
    expect(filterMetaTree(tree, 'sign')).toEqual({ MK: { Caption: 'Sign' } });
    expect(filterMetaTree(tree, 'rect')).toEqual({ Rect: [0, 0, 10, 10] });
    expect(filterMetaTree(tree, 'zzz')).toEqual({});
  });

  it('splits text around the first case-insensitive match', () => {
    expect(highlightParts('Hello World', 'world')).toEqual({ before: 'Hello ', match: 'World', after: '' });
    expect(highlightParts('Hello', '')).toEqual({ before: 'Hello', match: '', after: '' });
  });

  it('renders lazily: collapsed branches have no children until opened', async () => {
    const fixture = TestBed.createComponent(MetaTree);
    fixture.componentRef.setInput('node', { Outer: { Inner: 'value' }, Leaf: 'x' });
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('details.meta-branch')).toHaveLength(1);
    expect(el.textContent).not.toContain('Inner');

    fixture.componentRef.setInput('term', 'inner');
    await fixture.whenStable();
    expect(el.querySelector('mark.meta-highlight')?.textContent).toBe('Inner');
  });

  it('says what is missing', async () => {
    const fixture = TestBed.createComponent(MetaTree);
    fixture.componentRef.setInput('node', null);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Not present on this side.');
  });
});
