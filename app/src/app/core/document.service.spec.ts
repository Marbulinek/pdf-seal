import { TestBed } from '@angular/core/testing';
import { jsonResponse, mockFetch } from '../testing/network';
import { provideTestApp } from '../testing/providers';
import { DocumentService } from './document.service';
import { DocumentStore } from './document.store';
import { NotificationService } from './notification.service';

describe('DocumentService.handleApiUpdate', () => {
  let service: DocumentService;
  let doc: InstanceType<typeof DocumentStore>;
  let processNewFile: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: provideTestApp() });
    service = TestBed.inject(DocumentService);
    doc = TestBed.inject(DocumentStore);
    doc.update({ activeFile: new File(['%PDF-1.7'], 'contract.pdf', { type: 'application/pdf' }) });
    // Re-opening the returned PDF needs pdf.js; the server round trip is what's under test.
    processNewFile = vi.spyOn(service, 'processNewFile').mockResolvedValue();
  });

  const messages = () => TestBed.inject(NotificationService).items().map((n) => `${n.type}: ${n.message}`);

  it('replaces the open file with the PDF the server returns', async () => {
    const calls = mockFetch(() => new Response('%PDF-1.7 updated', { headers: { 'Content-Type': 'application/pdf' } }));
    const form = new FormData();

    expect(await service.handleApiUpdate('/api/apply-changes', form, 'Applied 1 change.')).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/apply-changes');
    expect(calls[0].init).toMatchObject({ method: 'POST', body: form });
    const [file, options] = processNewFile.mock.calls[0] as [File, unknown];
    expect(file.name).toBe('contract.pdf');
    expect(await file.text()).toBe('%PDF-1.7 updated');
    expect(options).toEqual({ preservePage: true, isEdit: true, knownFields: null });
    expect(messages()).toContain('success: Applied 1 change.');
    expect(doc.isDocumentUpdating()).toBe(false);
  });

  it('takes the field list from a multipart withFields response', async () => {
    const fields = [{ name: 'Sig1', type: 'Signature', page: 0, rect: { x: 1, y: 2, width: 3, height: 4 } }];
    const parts = new FormData();
    parts.append('pdfDocument', new Blob(['%PDF-1.7 with fields'], { type: 'application/pdf' }), 'modified.pdf');
    parts.append('fields', JSON.stringify(fields));
    mockFetch(() => new Response('(multipart body)', { headers: { 'Content-Type': 'multipart/form-data; boundary=b' } }));
    // Decoding multipart is the browser's job; jsdom's File and Node's
    // multipart parser don't mix, so hand the service the decoded parts.
    vi.stubGlobal(
      'Response',
      class extends Response {
        override formData(): Promise<FormData> {
          return Promise.resolve(parts);
        }
      },
    );

    expect(await service.handleApiUpdate('/api/apply-changes?withFields=true', new FormData())).toBe(true);

    const [file, options] = processNewFile.mock.calls[0] as [File, { knownFields: unknown }];
    expect(file.name).toBe('contract.pdf');
    expect(await file.text()).toBe('%PDF-1.7 with fields');
    expect(options.knownFields).toEqual(fields);
  });

  it('rejects a multipart response without the PDF part', async () => {
    mockFetch(() => new Response('(multipart body)', { headers: { 'Content-Type': 'multipart/form-data; boundary=b' } }));
    vi.stubGlobal(
      'Response',
      class extends Response {
        override formData(): Promise<FormData> {
          return Promise.resolve(new FormData());
        }
      },
    );

    expect(await service.handleApiUpdate('/api/apply-changes?withFields=true', new FormData())).toBe(false);
    expect(processNewFile).not.toHaveBeenCalled();
    expect(messages()).toContain('error: Error: Could not read the server response.');
  });

  it('reports the server error and leaves the document alone', async () => {
    mockFetch(() => jsonResponse({ error: 'Field "Sig1" is signed and cannot be edited.' }, 400));

    expect(await service.handleApiUpdate('/api/apply-changes', new FormData())).toBe(false);

    expect(processNewFile).not.toHaveBeenCalled();
    expect(messages()).toContain('error: Error: Field "Sig1" is signed and cannot be edited.');
    expect(doc.isDocumentUpdating()).toBe(false);
  });

  it('reports a failed request when no server answers', async () => {
    // No mockFetch: the real network is blocked in unit tests (test-setup.ts).
    expect(await service.handleApiUpdate('/api/apply-changes', new FormData())).toBe(false);
    expect(messages().some((m) => m.startsWith('error: Error: Unit tests never reach a server'))).toBe(true);
  });
});
