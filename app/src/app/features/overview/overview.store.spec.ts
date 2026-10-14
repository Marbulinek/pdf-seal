import { TestBed } from '@angular/core/testing';
import { DocumentStore } from '../../core/document.store';
import type { DocumentOverviewData, InfoFullResponse } from '../../core/models';
import type { PdfDocument } from '../../core/pdfjs-types';
import { makeReport } from '../../testing/fixtures';
import { jsonResponse, mockFetch } from '../../testing/network';
import { provideTestApp } from '../../testing/providers';
import { CertificatesStore } from '../certificates/certificates.store';
import { OverviewStore } from './overview.store';

function overviewData(signatureCount: number): DocumentOverviewData {
  const meta = { title: 'Contract', author: 'Ann', subject: null, keywords: null, creator: null, producer: null, creationDate: null, modificationDate: null };
  return {
    documentInfo: { ...meta, pdfVersion: '1.7', fileSize: 1024, pageCount: 1 },
    features: {
      encrypted: false,
      pdfA: '',
      linearized: false,
      xfa: false,
      acroForm: true,
      signatureFieldCount: signatureCount,
      javascript: false,
      attachmentCount: 0,
      xmpMetadata: false,
      incrementalUpdates: null,
      signatureCount,
      certification: null,
      stampCount: 0,
      annotationCount: 1,
    },
    pages: [],
    attachments: [],
    xmp: null,
    documentIds: { permanent: null, changing: null, xmpDocumentId: null, xmpInstanceId: null },
  };
}

const INFO: InfoFullResponse = {
  metadata: { title: 'Contract', author: 'Ann', subject: null, keywords: null, creator: null, producer: null, creationDate: null, modificationDate: null, pageCount: 1 },
  annotations: [{ ref: '9 0 R', page: 0, rect: { x: 10, y: 10, width: 50, height: 12 }, subtype: 'Link', kind: 'link', uri: 'https://example.com' }],
  stamps: [],
  overview: overviewData(0),
};

describe('OverviewStore.loadIfNeeded', () => {
  let doc: InstanceType<typeof DocumentStore>;
  let store: OverviewStore;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: provideTestApp() });
    doc = TestBed.inject(DocumentStore);
    store = TestBed.inject(OverviewStore);
  });

  function openFile(name = 'contract.pdf'): File {
    const file = new File(['%PDF-1.7'], name, { type: 'application/pdf' });
    // The summary only needs a parsed document to exist; pdf.js isn't involved.
    doc.update({ activeFile: file, pdfDoc: {} as PdfDocument });
    return file;
  }

  it('fetches the /api/info summary once per file', async () => {
    const calls = mockFetch(() => jsonResponse(INFO));
    const file = openFile();

    await store.loadIfNeeded();
    await store.loadIfNeeded();

    expect(calls.map((c) => c.url)).toEqual(['/api/info']);
    expect((calls[0].init.body as FormData).get('pdfDocument')).toBe(file);
    expect(doc.documentMeta()?.title).toBe('Contract');
    expect(doc.documentMetaLoadedFor()).toBe(file);
    expect(store.items().map((i) => `${i.kind}:${i.label}`)).toEqual(['link:https://example.com']);
    expect(store.loading()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it('also loads the certificate report for a signed document', async () => {
    const calls = mockFetch((url) =>
      url === '/api/certificates' ? jsonResponse({ report: makeReport() }) : jsonResponse({ ...INFO, overview: overviewData(1) }),
    );
    openFile();

    await store.loadIfNeeded();
    await vi.waitFor(() => expect(TestBed.inject(CertificatesStore).reportForActiveFile()).not.toBeNull());

    expect(calls.map((c) => c.url)).toEqual(['/api/info', '/api/certificates']);
  });

  it('shows the server error', async () => {
    mockFetch(() => jsonResponse({ error: 'Failed to parse PDF.' }, 400));
    openFile();

    await store.loadIfNeeded();

    expect(store.error()).toBe('Failed to parse PDF.');
    expect(doc.documentMetaLoadedFor()).toBeNull();
    expect(store.loading()).toBe(false);
  });

  it('drops a response for a file that was replaced meanwhile', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mockFetch(async () => {
      await gate;
      return jsonResponse(INFO);
    });
    openFile('first.pdf');
    const pending = store.loadIfNeeded();
    const second = openFile('second.pdf');
    release();
    await pending;

    expect(doc.activeFile()).toBe(second);
    expect(doc.documentMeta()).toBeNull();
    expect(doc.documentMetaLoadedFor()).toBeNull();
  });

  it('clears the summary when no document is open', async () => {
    const calls = mockFetch(() => jsonResponse(INFO));
    doc.update({ documentMeta: INFO.metadata ?? null });

    await store.loadIfNeeded();

    expect(calls).toEqual([]);
    expect(doc.documentMeta()).toBeNull();
  });
});
