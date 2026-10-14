import { TestBed } from '@angular/core/testing';
import { buildTemplateExport } from './signature-templates';
import { DocumentStore } from '../../core/document.store';
import { makeField } from '../../testing/fixtures';
import { provideTestApp } from '../../testing/providers';
import { TEMPLATES_STORAGE_KEY, TemplatesStore, templateItemSummary } from './templates.store';

describe('TemplatesStore', () => {
  let store: TemplatesStore;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: provideTestApp() });
    store = TestBed.inject(TemplatesStore);
  });

  function create(name: string): void {
    store.openNameModal(null);
    store.submitTemplateName(name);
  }

  it('creates, selects and persists a template', () => {
    create('Contract');
    expect(store.templates().map((t) => t.name)).toEqual(['Contract']);
    expect(store.selectedTemplate()?.name).toBe('Contract');
    expect(store.nameModal().open).toBe(false);
    expect(JSON.parse(localStorage.getItem(TEMPLATES_STORAGE_KEY) ?? '{}').templates).toHaveLength(1);
  });

  it('rejects empty and duplicate names', () => {
    create('Contract');
    store.openNameModal(null);
    store.submitTemplateName('  ');
    expect(store.nameModal().status).toBe('Give the template a name.');
    store.submitTemplateName('contract');
    expect(store.nameModal().status).toBe('A template named "contract" already exists.');
  });

  it('captures a placed field into the selected template', () => {
    create('Contract');
    const doc = TestBed.inject(DocumentStore);
    doc.resetFieldsFromServer([makeField('Client')]);
    store.beginDocumentFieldDrag(doc.fields()[0]);
    expect(document.body.classList.contains('is-capturing-field')).toBe(false); // effects flush on tick
    TestBed.tick();
    expect(document.body.classList.contains('is-capturing-field')).toBe(true);
    store.dropCapturedField();
    TestBed.tick();
    expect(document.body.classList.contains('is-capturing-field')).toBe(false);
    const item = store.selectedTemplate()?.items[0];
    expect(item).toMatchObject({ name: 'Client', page: 0, width: 200, height: 60 });
    expect(templateItemSummary(item!)).toContain('200 × 60 pt');
  });

  it('asks for a name when a field is dropped before any template exists', () => {
    const doc = TestBed.inject(DocumentStore);
    doc.resetFieldsFromServer([makeField('Client')]);
    store.beginDocumentFieldDrag(doc.fields()[0]);
    store.dropCapturedField();
    expect(store.nameModal().open).toBe(true);
    expect(store.capturedFieldName()).toBe('Client');
    store.submitTemplateName('Fresh');
    expect(store.selectedTemplate()?.items.map((i) => i.name)).toEqual(['Client']);
  });

  it('imports a backup by merging, renaming clashes', async () => {
    create('Contract');
    const incoming = buildTemplateExport({ version: 1, templates: [{ id: 'x', name: 'Contract', createdAt: 0, updatedAt: 0, items: [] }] });
    await store.importFile(new File([JSON.stringify(incoming)], 'backup.json', { type: 'application/json' }));
    expect(store.importModal()?.fileName).toBe('backup.json');
    store.applyImport('merge');
    expect(store.templates()).toHaveLength(2);
    expect(store.templates()[1].name).not.toBe('Contract');
  });

  it('deletes a template after confirmation', () => {
    create('One');
    create('Two');
    const id = store.templates()[0].id;
    store.openDeleteModal(id);
    expect(store.deleteTemplateId()).toBe(id);
    store.confirmDelete();
    expect(store.templates().map((t) => t.name)).toEqual(['Two']);
  });

  it('sandboxes templates for the tour and restores them afterwards', () => {
    create('Mine');
    store.activateSandbox();
    expect(store.templates()).toEqual([]);
    expect(store.backupTemplateCount()).toBe(1); // backups read the real store
    store.ensureDemoTemplate(null);
    expect(store.templates().map((t) => t.name)).toEqual(['Demo template']);
    store.restoreSandbox();
    expect(store.templates().map((t) => t.name)).toEqual(['Mine']);
  });
});
