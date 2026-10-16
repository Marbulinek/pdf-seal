import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { DocumentService } from '../../core/document.service';
import { DocumentStore } from '../../core/document.store';
import { SECTION_NAV, UiService } from '../../core/ui.service';
import { ExportService } from '../../features/export/export.service';
import { ShareService } from '../../features/share/share.service';
import { TourService } from '../../features/tour/tour.service';

/** Brand, section tabs, Help/Settings, Upload and Share/Download. */
@Component({
  selector: 'header[appTopbar]',
  templateUrl: './topbar.html',
  styleUrl: './topbar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'topbar', '(document:click)': 'actionsOpen.set(false)' },
})
export class Topbar {
  protected readonly ui = inject(UiService);
  protected readonly doc = inject(DocumentStore);
  protected readonly share = inject(ShareService);
  protected readonly exporter = inject(ExportService);
  protected readonly tour = inject(TourService);
  private readonly documents = inject(DocumentService);
  private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  protected readonly nav = SECTION_NAV;

  protected toggleDropdown(which: 'upload' | 'download', event: Event, disabled = false): void {
    event.stopPropagation();
    if (disabled) return;
    this.ui.openDropdown.set(this.ui.openDropdown() === which ? null : which);
  }

  /** Help/Settings/Upload/Share/Download collapse into this menu at 641-838px. */
  protected readonly actionsOpen = signal(false);

  protected toggleActions(event: Event): void {
    event.stopPropagation();
    this.actionsOpen.update((v) => !v);
  }

  protected toggleNav(event: Event): void {
    event.stopPropagation();
    this.ui.sectionNavOpen.set(!this.ui.sectionNavOpen());
  }

  protected pickFile(): void {
    this.ui.openDropdown.set(null);
    this.fileInput().nativeElement.click();
  }

  protected onFileChosen(input: HTMLInputElement): void {
    const file = input.files?.[0];
    if (file) this.documents.processNewFile(file);
    input.value = ''; // allow re-selecting the same file later
  }

  protected openBase64(): void {
    this.ui.openDropdown.set(null);
    this.ui.base64ModalOpen.set(true);
  }

  protected exportPdf(): void {
    this.ui.openDropdown.set(null);
    this.exporter.openSaveAs();
  }

  protected copyBase64(): void {
    this.ui.openDropdown.set(null);
    this.exporter.copyBase64();
  }
}
