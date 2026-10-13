import { TestBed } from '@angular/core/testing';
import { DocumentService } from '../../core/document.service';
import { UiService } from '../../core/ui.service';
import { provideTestApp } from '../../testing/providers';
import { Base64Modal } from './base64-modal';

describe('Base64Modal', () => {
  let loaded: File[];

  beforeEach(() => {
    loaded = [];
    TestBed.configureTestingModule({
      providers: [...provideTestApp(), { provide: DocumentService, useValue: { processNewFile: async (file: File) => void loaded.push(file) } }],
    });
  });

  async function open() {
    const fixture = TestBed.createComponent(Base64Modal);
    TestBed.inject(UiService).base64ModalOpen.set(true);
    await fixture.whenStable();
    return fixture;
  }

  it('explains what is wrong with the pasted text', async () => {
    const fixture = await open();
    const el: HTMLElement = fixture.nativeElement;
    (el.querySelector('#loadBase64Btn') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(el.querySelector('#base64ModalStatus')?.textContent).toBe('Paste a Base64 string first.');

    const input = el.querySelector('#base64Input') as HTMLTextAreaElement;
    input.value = btoa('just text');
    (el.querySelector('#loadBase64Btn') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(el.querySelector('#base64ModalStatus')?.textContent).toBe('Decoded data does not look like a PDF file.');
    expect(loaded).toEqual([]);
  });

  it('loads a valid Base64 PDF and closes', async () => {
    const fixture = await open();
    const el: HTMLElement = fixture.nativeElement;
    (el.querySelector('#base64Input') as HTMLTextAreaElement).value = `data:application/pdf;base64,${btoa('%PDF-1.7\n')}`;
    (el.querySelector('#loadBase64Btn') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(loaded.map((f) => f.name)).toEqual(['uploaded-document.pdf']);
    expect(TestBed.inject(UiService).base64ModalOpen()).toBe(false);
  });
});
