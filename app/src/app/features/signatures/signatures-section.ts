import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import type { SignatureTemplate, TemplateItem } from '@shared/SignatureTemplates';
import { DocumentStore } from '../../core/document.store';
import { SettingsService } from '../../core/settings.service';
import { UiService, type SignatureTab } from '../../core/ui.service';
import { ViewerService } from '../../core/viewer.service';
import { OvHero, type HeroModel } from '../../shared/ov-hero';
import { SignaturesStore } from './signatures.store';
import { TEMPLATE_DRAG_MIME, TemplatesStore, templateItemSummary } from './templates.store';

const PLACEMENT_HINT_PLACING = 'Click anywhere on the PDF to drop the field.';

/**
 * Signatures: undo/redo strip, then one panel with two tabs -- add a field by
 * placing it on the page, or reuse fields saved in a local template. Editing
 * a selected field happens in the Edit sheet.
 */
@Component({
  selector: 'section[appSignaturesSection]',
  imports: [OvHero],
  templateUrl: './signatures-section.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'sectionSignatures',
    class: 'section-panel active section-panel-enter',
    'data-section-panel': 'signatures',
  },
})
export class SignaturesSection {
  protected readonly ui = inject(UiService);
  protected readonly doc = inject(DocumentStore);
  protected readonly signatures = inject(SignaturesStore);
  protected readonly templates = inject(TemplatesStore);
  private readonly settings = inject(SettingsService);
  private readonly viewer = inject(ViewerService);
  private readonly document = inject(DOCUMENT);

  protected readonly placingHint = PLACEMENT_HINT_PLACING;
  protected readonly summary = templateItemSummary;

  protected readonly hasDoc = computed(() => !!this.doc.pdfDoc());
  protected readonly tab = this.ui.signatureTab;
  protected readonly templatesEnabled = computed(() => this.settings.effective().templatesEnabled);
  protected readonly selected = this.templates.selectedTemplate;

  protected readonly hero = computed<HeroModel | null>(() => {
    if (!this.doc.activeFile()) return null;
    const { total, unsigned, signed } = this.signatures.hero();
    return {
      kind: 'signature',
      icon: 'icon-pen',
      label: `${total} signature field${total === 1 ? '' : 's'}`,
      subtitle: total ? `${unsigned} unsigned · ${signed} signed` : 'Add one below, then place it on the page',
      badge: !total
        ? { type: 'pill', text: 'None yet', tone: 'neutral' }
        : unsigned
          ? { type: 'pill', text: `${unsigned} to sign`, tone: 'pending' }
          : { type: 'pill', text: 'All signed', tone: 'positive' },
    };
  });

  protected setTab(tab: SignatureTab): void {
    this.ui.signatureTab.set(tab);
  }

  protected setSize(key: 'addWidth' | 'addHeight', raw: string): void {
    const value = parseFloat(raw);
    // A half-typed number isn't written back (that would overwrite the input mid-edit).
    if (Number.isFinite(value)) this.signatures.setAddForm({ [key]: value });
  }

  protected rename(): void {
    const id = this.selected()?.id;
    if (id) this.templates.openNameModal(id);
  }

  protected remove(): void {
    const id = this.selected()?.id;
    if (id) this.templates.openDeleteModal(id);
  }

  protected onListToggle(event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    if (open !== this.templates.itemListOpen()) this.templates.setItemListOpen(open);
  }

  // ---- Capture: a field dragged off the page into the panel ----

  protected onDropzoneOver(event: DragEvent): void {
    if (!this.templates.draggingDocumentFieldUid()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    if (!this.templates.dropzoneActive()) this.templates.setDropzoneActive(true);
  }

  protected onDropzoneLeave(event: DragEvent): void {
    if (!this.templates.draggingDocumentFieldUid()) return;
    const related = event.relatedTarget;
    if (related instanceof Node && (event.currentTarget as HTMLElement).contains(related)) return;
    this.templates.setDropzoneActive(false);
  }

  protected onDropzoneDrop(event: DragEvent): void {
    const uid = this.templates.draggingDocumentFieldUid();
    if (!uid) return;
    event.preventDefault();
    this.templates.dropCapturedField();
    // The capture is done: land the panel back on its default view.
    if (this.signatures.activeFieldUid() === uid) this.signatures.deselect();
  }

  // ---- Manual placement: an item dragged from the panel onto the page ----

  protected onItemDragStart(event: DragEvent, item: TemplateItem, template: SignatureTemplate): void {
    if (!this.templates.rowsDraggable() || !event.dataTransfer) return;
    this.templates.beginTemplateItemDrag(item, template.id);
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(TEMPLATE_DRAG_MIME, item.id);
    // Some browsers need a plain-text payload to start a drag at all.
    event.dataTransfer.setData('text/plain', item.name);
    this.setDragImage(event.dataTransfer, item);
  }

  /** A field-sized ghost at the current zoom, so the drop lands where it looks like it will. */
  private setDragImage(dataTransfer: DataTransfer, item: TemplateItem): void {
    const viewport = this.viewer.viewport();
    const scaleX = viewport?.scaleX ?? viewport?.scale ?? 1;
    const scaleY = viewport?.scaleY ?? scaleX;
    const MIN_PX = 32;
    const width = Math.max(MIN_PX, Math.round(item.width * scaleX));
    const height = Math.max(MIN_PX, Math.round(item.height * scaleY));

    const ghost = this.document.createElement('div');
    ghost.className = `field-overlay${item.required ? ' required' : ''}`;
    Object.assign(ghost.style, { position: 'fixed', left: '-9999px', top: '-9999px', width: `${width}px`, height: `${height}px` });
    const icon = this.document.createElement('span');
    icon.className = `icon ${item.type === 'text' ? 'icon-file-text' : 'icon-pen'}`;
    icon.setAttribute('aria-hidden', 'true');
    const label = this.document.createElement('div');
    label.className = 'field-label';
    label.style.display = 'block';
    label.textContent = item.name;
    ghost.append(icon, label);

    this.document.body.appendChild(ghost);
    dataTransfer.setDragImage(ghost, width / 2, height / 2);
    // The browser snapshots the drag image synchronously.
    setTimeout(() => ghost.remove(), 0);
  }
}
