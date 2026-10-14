import { TestBed } from '@angular/core/testing';
import { ApiService } from '../../core/api.service';
import { DocumentStore } from '../../core/document.store';
import { UiService } from '../../core/ui.service';
import { check, makeCert, makeReport } from '../../testing/fixtures';
import { provideTestApp } from '../../testing/providers';
import { CertificatesStore } from './certificates.store';

describe('CertificatesStore', () => {
  const report = makeReport({
    certificates: [makeCert('leaf', { checks: [check('cert.validity.window', 'fail', 'Expired')] }), makeCert('ca', { role: 'root' })],
    summary: { status: 'fail', headline: 'Problems', counts: { pass: 4, warn: 1, fail: 1, unknown: 0 } },
  });
  let calls: string[];

  beforeEach(() => {
    calls = [];
    TestBed.configureTestingModule({
      providers: [
        ...provideTestApp(),
        {
          provide: ApiService,
          useValue: {
            postForm: async (url: string) => {
              calls.push(url);
              return new Response(JSON.stringify({ report }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            },
          },
        },
      ],
    });
  });

  async function loaded(): Promise<CertificatesStore> {
    const doc = TestBed.inject(DocumentStore);
    doc.update({ activeFile: new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' }) });
    const store = TestBed.inject(CertificatesStore);
    await store.loadIfNeeded();
    return store;
  }

  it('loads the report once per file', async () => {
    const store = await loaded();
    expect(store.reportForActiveFile()?.summary.headline).toBe('Problems');
    await store.loadIfNeeded();
    expect(calls).toEqual(['/api/certificates']);
  });

  it('filters the check list by status and text', async () => {
    const store = await loaded();
    const total = store.allChecks().length;
    expect(store.filterActive()).toBe(false);
    expect(store.shownCheckCount()).toBe(total);

    store.toggleFilterStatus('pass');
    expect(store.filterActive()).toBe(true);
    expect(store.shownCheckCount()).toBe(store.allChecks().filter((c) => c.status !== 'pass').length);

    store.setFilterText('expired');
    expect(store.shownCheckCount()).toBe(1);

    store.clearFilter();
    expect(store.filterActive()).toBe(false);
  });

  it('opens one certificate in the sheet, closing the others', async () => {
    const store = await loaded();
    const ui = TestBed.inject(UiService);
    store.openTimelineSheet('Sig1');
    expect(ui.sheets.certificateTimeline()).toBe(true);
    store.openCertificateSheet('ca', 'validation');
    expect(ui.sheets.certificate()).toBe(true);
    expect(ui.sheets.certificateTimeline()).toBe(false);
    expect(store.activeCert()?.id).toBe('ca');
    expect(store.activeTab()).toBe('validation');
    store.closeCertificateSheet();
    expect(store.activeCert()).toBeNull();
  });

  it('starts a modification only for a known signature and operation', async () => {
    const store = await loaded();
    store.openModifySheet('remove-certificate', 'Nope');
    expect(store.modify()).toBeNull();
    store.openModifySheet('remove-certificate', 'Sig1');
    expect(store.modify()).toMatchObject({ op: 'remove-certificate', fieldName: 'Sig1', targetFingerprint: null });
    store.setModifyTarget('ca');
    expect(store.modify()?.targetFingerprint).toBe('ca');
  });
});
