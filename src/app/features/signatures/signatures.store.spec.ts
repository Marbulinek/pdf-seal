import { TestBed } from '@angular/core/testing';
import { DocumentStore } from '../../core/document.store';
import { NotificationService } from '../../core/notification.service';
import { UiService } from '../../core/ui.service';
import { makeField } from '../../testing/fixtures';
import { provideTestApp } from '../../testing/providers';
import { SignaturesStore } from './signatures.store';

describe('SignaturesStore', () => {
  let store: SignaturesStore;
  let doc: DocumentStore;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: provideTestApp() });
    store = TestBed.inject(SignaturesStore);
    doc = TestBed.inject(DocumentStore);
    doc.resetFieldsFromServer([makeField('Existing'), makeField('Signed', { signed: true })]);
  });

  it('stages a new field as one pending add with an undo step', () => {
    store.stageNewField({ name: 'New', page: 0, rect: { x: 1, y: 2, width: 100, height: 40 } });
    expect(store.pendingCount()).toBe(1);
    expect(store.pendingDescription()).toBe('Added 1 field');
    expect(store.pendingRows()[0]).toMatchObject({ name: 'New', tags: [{ cls: 'add', text: 'Added' }] });
    expect(store.undoStack()).toHaveLength(1);
    expect(store.isStaged(doc.fields().find((f) => f.name === 'New')!)).toBe(true);
  });

  it('summarises the signature fields for the section hero', () => {
    expect(store.hero()).toEqual({ total: 2, unsigned: 1, signed: 1 });
  });

  it('opens the edit sheet on select and closes it on deselect', () => {
    const ui = TestBed.inject(UiService);
    const uid = doc.fields()[0].uid;
    store.select(uid);
    expect(store.activeField()?.name).toBe('Existing');
    expect(store.activeFieldEditable()).toBe(true);
    expect(ui.sheets.edit()).toBe(true);
    store.deselect();
    expect(store.activeField()).toBeNull();
    expect(ui.sheets.edit()).toBe(false);
  });

  it('renames the selected field, refusing duplicates', () => {
    const notifications = TestBed.inject(NotificationService);
    store.select(doc.fields()[0].uid);
    expect(store.renameActive('Signed')).toBe('Existing');
    expect(notifications.items().at(-1)?.message).toBe('A field named "Signed" already exists.');
    expect(store.renameActive('  Renamed  ')).toBe('Renamed');
    expect(store.pendingRows()[0]).toMatchObject({ name: 'Renamed', fromName: 'Existing' });
  });

  it('commits a dragged rect and a requirement toggle as edits', () => {
    const uid = doc.fields()[0].uid;
    store.commitRect(uid, { x: 50, y: 10, width: 200, height: 60 });
    store.select(uid);
    store.setActiveRequired(true);
    expect(store.pendingDescription()).toBe('Moved 1 field, Changed 1 field requirement');
    expect(store.undoStack()).toHaveLength(2);
  });

  it('cannot place without a document or a name', () => {
    expect(store.canPlace()).toBe(false);
    store.setAddForm({ addName: 'Sig' });
    expect(store.canPlace()).toBe(false); // still no pdf.js document open
  });
});
