import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DocumentService } from '../../core/document.service';
import { DocumentStore, type StoreField } from '../../core/document.store';
import {
  SMALL_FIELD_NO_DELETE_HANDLE,
  choiceFieldIconClass,
  isEditableField,
  isRectPracticallyInvisible,
} from '../../core/field-rules';
import type { PdfRect } from '../../core/models';
import { UiService } from '../../core/ui.service';
import { MIN_MEASURABLE_VIEWER_WIDTH, ViewerService, type ScreenRect } from '../../core/viewer.service';
import { OVERVIEW_KINDS } from '../../features/overview/overview-model';
import { OverviewStore } from '../../features/overview/overview.store';
import { isFieldStaged } from '../../features/signatures/field-ops';
import { SignaturesStore } from '../../features/signatures/signatures.store';
import { DOCUMENT_FIELD_DRAG_MIME, TemplatesStore } from '../../features/signatures/templates.store';
import { TourService } from '../../features/tour/tour.service';

interface DragState {
  uid: string;
  box: ScreenRect;
}

/** Edge inset that clears .pdf-container's 14px border-radius. */
const PIN_EDGE_INSET = 10;
const PIN_GAP = 4;
const INVISIBLE_PIN_RADIUS = 11;
const INVISIBLE_PIN_LABEL_GAP = 8;

/**
 * The document viewer on the left: toolbar, the shared canvas, and every
 * overlay drawn over it -- field overlays (select / drag / resize / delete /
 * drag-to-template), Overview hotspots, and the diff markers the Versions
 * section draws while it owns the canvas.
 */
@Component({
  selector: 'section[appViewer]',
  imports: [NgTemplateOutlet],
  templateUrl: './viewer.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'panel viewer-panel viewer-column',
    '(document:click)': 'toolsMenuOpen.set(false)',
    '(document:keydown.escape)': 'toolsMenuOpen.set(false)',
  },
})
export class Viewer {
  protected readonly viewer = inject(ViewerService);
  protected readonly doc = inject(DocumentStore);
  protected readonly ui = inject(UiService);
  protected readonly signatures = inject(SignaturesStore);
  protected readonly templates = inject(TemplatesStore);
  protected readonly overview = inject(OverviewStore);
  protected readonly tour = inject(TourService);
  private readonly documents = inject(DocumentService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly scrollRef = viewChild.required<ElementRef<HTMLElement>>('scroll');
  private readonly overlayRef = viewChild.required<ElementRef<HTMLElement>>('overlayLayer');
  private readonly inlineRef = viewChild<ElementRef<HTMLElement>>('controlsInline');
  private readonly fileNameTextRef = viewChild<ElementRef<HTMLElement>>('fileNameText');

  protected readonly toolsMenuOpen = signal(false);
  protected readonly controlsCollapsed = signal(false);
  protected readonly inlineWidth = signal<string | null>(null);
  private collapseTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly hoveredUid = signal<string | null>(null);
  private readonly drag = signal<DragState | null>(null);
  protected readonly panning = signal(false);
  private panDrag: { pointerId: number; startX: number; startY: number; left: number; top: number } | null = null;

  protected readonly emptyDragActive = signal(false);
  protected readonly containerDragActive = signal(false);
  private readonly templateDragOver = signal(false);
  /** The drop cue lasts only while a panel item is actually being dragged. */
  protected readonly templateDropActive = computed(() => !!this.templates.draggingTemplateItem() && this.templateDragOver());

  protected readonly fileName = computed(() => (this.doc.hasDocument() ? this.doc.activeFileName() : ''));
  protected readonly zoomLabel = computed(() => `${Math.round(this.viewer.scale() * 100)}%`);
  protected readonly roundedProgress = computed(() => Math.round(this.doc.loadingProgress()));

  /** Every field overlay on the shown page, with its screen box and flags. */
  protected readonly fieldOverlays = computed(() => {
    const viewport = this.viewer.viewport();
    this.viewer.overlayRenderTick();
    if (!viewport) return [];
    const page = this.viewer.pageNum() - 1;
    const baseline = this.doc.fieldsBaseline();
    const activeUid = this.signatures.activeFieldUid();
    const hovered = this.hoveredUid();
    const drag = this.drag();
    const activeItem = this.overview.activeItem();
    const hoverItem = this.overview.hoverItem();
    return this.doc
      .fields()
      .filter((f) => f.page === page && f.rect)
      .map((field) => {
        const rect = field.rect as PdfRect;
        const invisible = isRectPracticallyInvisible(rect, field.type);
        const locked = !isEditableField(field);
        const choice = choiceFieldIconClass(field.type);
        const kind = field.type === 'Signature' ? 'signature' : 'field';
        const invisibleSuffix = invisible ? ' — invisible field, no visible footprint on the page' : '';
        const title = invisible
          ? null
          : field.signed === true
            ? `${field.name} — signed, so it can't be moved or resized without breaking the signature${invisibleSuffix}`
            : (field.tooltip ? `${field.name} — ${field.tooltip}${invisibleSuffix}` : `${field.name || 'Signature field'}${invisibleSuffix}`) +
              (field.type !== 'Signature' ? ' — shown for inspection; PDF Seal edits signature fields only' : '');
        const active = field.uid === activeUid;
        return {
          field,
          box: drag?.uid === field.uid ? drag.box : this.viewer.pdfRectToScreen(rect, viewport),
          invisible,
          locked,
          staged: isFieldStaged(field, baseline),
          active,
          labelVisible: active || hovered === field.uid,
          selected: !!activeItem && activeItem.kind === kind && activeItem.key === field.name,
          hovered: !!hoverItem && hoverItem.kind === kind && hoverItem.key === field.name,
          smallField: Math.min(rect.width, rect.height) < SMALL_FIELD_NO_DELETE_HANDLE,
          icon: field.signed === true ? 'icon-lock' : choice || (field.type === 'Signature' ? 'icon-pen' : 'icon-file-text'),
          pinIcon: field.signed === true ? 'icon-lock' : choice || 'icon-eye-off',
          title,
        };
      });
  });

  protected readonly extraWidgetMarkers = computed(() => {
    const viewport = this.viewer.viewport();
    if (!viewport) return [];
    const page = this.viewer.pageNum() - 1;
    const out: { box: ScreenRect; invisible: boolean; title: string; icon: string }[] = [];
    for (const field of this.doc.fields()) {
      if (field.type !== 'CheckBox' && field.type !== 'RadioGroup') continue;
      for (const w of field.extraWidgets || []) {
        if (w.page !== page || !w.rect) continue;
        out.push({
          box: this.viewer.pdfRectToScreen(w.rect, viewport),
          invisible: isRectPracticallyInvisible(w.rect, field.type),
          title: field.name || '',
          icon: choiceFieldIconClass(field.type) ?? 'icon-eye-off',
        });
      }
    }
    return out;
  });

  protected readonly hotspots = computed(() => {
    const viewport = this.viewer.viewport();
    if (!viewport) return [];
    const active = this.overview.activeItem();
    const hover = this.overview.hoverItem();
    return this.overview.hotspots().map(({ item, invisible }) => ({
      item,
      invisible,
      box: this.viewer.pdfRectToScreen(item.rect as PdfRect, viewport),
      title: `${OVERVIEW_KINDS[item.kind].single}: ${item.label}`,
      icon: OVERVIEW_KINDS[item.kind].icon,
      selected: !!active && active.kind === item.kind && active.key === item.key,
      hovered: !!hover && hover.kind === item.kind && hover.key === item.key,
    }));
  });

  protected readonly diffMarkerBoxes = computed(() => {
    const viewport = this.viewer.viewport();
    if (!viewport) return [];
    return this.viewer.diffMarkers().map((m) => ({ box: this.viewer.pdfRectToScreen(m.rect, viewport), invisible: m.invisible }));
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      this.viewer.attach(this.canvasRef().nativeElement, this.scrollRef().nativeElement, this.overlayRef().nativeElement);
      // Keep the page fitted to the panel unless the user zoomed. Watches the
      // column (not the window): it changes width for reasons no resize event covers.
      let lastFittedWidth: number | null = null;
      let fitTimer: ReturnType<typeof setTimeout> | null = null;
      const refit = () => {
        const width = this.viewer.computeAvailViewerSize().width;
        if (width < MIN_MEASURABLE_VIEWER_WIDTH) return;
        const widthChanged = width !== lastFittedWidth;
        lastFittedWidth = width;
        if (!widthChanged || this.viewer.userHasManuallyZoomed()) return;
        if (fitTimer) clearTimeout(fitTimer);
        fitTimer = setTimeout(() => {
          if (!this.viewer.userHasManuallyZoomed()) this.viewer.redraw();
        }, 120);
      };
      const observer = new ResizeObserver(refit);
      observer.observe(this.host.nativeElement);
      destroyRef.onDestroy(() => {
        observer.disconnect();
        this.viewer.detach();
      });
    });

    // Invisible fields get a fixed-size chip clamped inside the page instead of
    // their true (near-zero) footprint; stacked when several share a corner.
    afterRenderEffect(() => {
      this.fieldOverlays();
      this.extraWidgetMarkers();
      this.hotspots();
      this.diffMarkerBoxes();
      this.layoutInvisiblePins();
    });

    // The shown label re-anchors to whichever side has room.
    afterRenderEffect(() => {
      const overlays = this.fieldOverlays();
      const layer = this.overlayRef().nativeElement;
      for (const o of overlays) {
        if (!o.labelVisible) continue;
        const div = layer.querySelector<HTMLElement>(`.field-overlay[data-field-name="${CSS.escape(o.field.name || '')}"]`);
        const label = div?.querySelector<HTMLElement>('.field-label');
        if (div && label) this.positionLabel(div, label);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Toolbar: the name-hover wrench collapse
  // ---------------------------------------------------------------------

  private nameIsTruncated(): boolean {
    const el = this.fileNameTextRef()?.nativeElement;
    return !!el && el.scrollWidth > el.clientWidth;
  }

  protected collapseControlsSoon(): void {
    // Only worth it when the name is actually truncated.
    if (!this.nameIsTruncated()) return;
    this.cancelCollapse();
    this.collapseTimer = setTimeout(() => {
      this.collapseTimer = null;
      if (!this.doc.hasDocument() || this.controlsCollapsed() || !this.nameIsTruncated()) return;
      const inline = this.inlineRef()?.nativeElement;
      this.inlineWidth.set(inline ? `${inline.getBoundingClientRect().width}px` : null);
      requestAnimationFrame(() => {
        this.controlsCollapsed.set(true);
        this.inlineWidth.set('0px');
      });
    }, 1800);
  }

  protected expandControls(): void {
    this.cancelCollapse();
    this.toolsMenuOpen.set(false);
    this.controlsCollapsed.set(false);
    this.inlineWidth.set(null);
  }

  private cancelCollapse(): void {
    if (this.collapseTimer !== null) {
      clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
  }

  // ---------------------------------------------------------------------
  // Panning (pointer capture keeps the drag on the scroller)
  // ---------------------------------------------------------------------

  protected onPanStart(e: PointerEvent): void {
    if (!this.viewer.isPanning() || e.button !== 0) return;
    const scroll = this.scrollRef().nativeElement;
    this.panDrag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, left: scroll.scrollLeft, top: scroll.scrollTop };
    scroll.setPointerCapture(e.pointerId);
    this.panning.set(true);
    e.preventDefault();
  }

  protected onPanMove(e: PointerEvent): void {
    const drag = this.panDrag;
    if (!this.viewer.isPanning() || !drag || e.pointerId !== drag.pointerId) return;
    const scroll = this.scrollRef().nativeElement;
    scroll.scrollLeft = drag.left - (e.clientX - drag.startX);
    scroll.scrollTop = drag.top - (e.clientY - drag.startY);
    e.preventDefault();
  }

  protected onPanEnd(e: PointerEvent): void {
    const drag = this.panDrag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const scroll = this.scrollRef().nativeElement;
    if (scroll.hasPointerCapture(drag.pointerId)) scroll.releasePointerCapture(drag.pointerId);
    this.panDrag = null;
    this.panning.set(false);
  }

  protected onScrollClick(e: MouseEvent): void {
    if (this.viewer.isPanning()) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // ---------------------------------------------------------------------
  // File drag & drop (replace the document)
  // ---------------------------------------------------------------------

  private hasFiles(e: DragEvent): boolean {
    return !!e.dataTransfer?.types?.includes('Files');
  }

  protected onFileDrag(e: DragEvent, target: 'empty' | 'container', _active: boolean): void {
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragover' && e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    (target === 'empty' ? this.emptyDragActive : this.containerDragActive).set(true);
  }

  protected onFileDragLeave(e: DragEvent, target: 'empty' | 'container'): void {
    const el = e.currentTarget as HTMLElement;
    if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
    e.preventDefault();
    e.stopPropagation();
    (target === 'empty' ? this.emptyDragActive : this.containerDragActive).set(false);
  }

  protected onFileDrop(e: DragEvent, target: 'empty' | 'container'): void {
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    (target === 'empty' ? this.emptyDragActive : this.containerDragActive).set(false);
    const file = e.dataTransfer?.files[0];
    if (file) this.documents.handleDroppedFile(file);
  }

  /** A template item dragged from the panel (never a file drag). */
  private isTemplateDrag(e: DragEvent): boolean {
    return !!this.templates.draggingTemplateItem() && !this.hasFiles(e);
  }

  protected onContainerDragOver(e: DragEvent): void {
    if (this.isTemplateDrag(e)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      this.templateDragOver.set(true);
      return;
    }
    this.onFileDrag(e, 'container', true);
  }

  protected onContainerDragLeave(e: DragEvent): void {
    if (this.isTemplateDrag(e)) {
      const el = e.currentTarget as HTMLElement;
      if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
      this.templateDragOver.set(false);
      return;
    }
    if (this.hasFiles(e)) this.onFileDragLeave(e, 'container');
  }

  protected onContainerDrop(e: DragEvent): void {
    if (this.isTemplateDrag(e)) {
      e.preventDefault();
      e.stopPropagation();
      this.templateDragOver.set(false);
      const dragging = this.templates.draggingTemplateItem();
      const rect = this.canvasRef().nativeElement.getBoundingClientRect();
      if (dragging) this.templates.placeTemplateItemAt(dragging.item, e.clientX - rect.left, e.clientY - rect.top);
      return;
    }
    this.onFileDrop(e, 'container');
  }

  // ---------------------------------------------------------------------
  // Placement + overlay interactions
  // ---------------------------------------------------------------------

  protected onContainerClick(e: MouseEvent): void {
    if (!this.signatures.isPlacing()) return;
    const rect = this.canvasRef().nativeElement.getBoundingClientRect();
    this.signatures.placeFieldAt(e.clientX - rect.left, e.clientY - rect.top);
  }

  protected onOverlayEnter(e: MouseEvent, uid: string): void {
    this.hoveredUid.set(uid);
  }

  protected onOverlayLeave(uid: string): void {
    if (this.hoveredUid() === uid) this.hoveredUid.set(null);
  }

  /** preventDefault() on mousedown suppresses the name input's blur -- commit it now. */
  private commitPendingRename(): void {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && active.id === 'editName') active.blur();
  }

  protected onOverlayMouseDown(e: MouseEvent, field: StoreField): void {
    this.commitPendingRename();
    // Outside Signatures, overlays are hover-only (labels) -- non-interactive.
    if (this.ui.activeSection() !== 'signatures') return;
    if (this.viewer.isPanning()) return; // let the pointerdown reach the pan handler
    e.preventDefault();
    const wasActive = this.signatures.activeFieldUid() === field.uid;
    this.signatures.select(field.uid);
    // Selectable but not draggable: a signed /Rect is inside the signed bytes.
    if (!isEditableField(field) || !field.rect) return;

    const viewport = this.viewer.viewport();
    if (!viewport) return;
    const start = this.viewer.pdfRectToScreen(field.rect, viewport);
    const startX = e.clientX;
    const startY = e.clientY;
    const canvas = this.viewer.canvasSize();
    let moved = false;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      const left = Math.max(0, Math.min(start.left + dx, canvas.width - start.width));
      const top = Math.max(0, Math.min(start.top + dy, canvas.height - start.height));
      this.drag.set({ uid: field.uid, box: { ...start, left, top } });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const drag = this.drag();
      this.drag.set(null);
      if (moved && drag) {
        this.signatures.commitRect(field.uid, this.viewer.screenRectToPdf(drag.box.left, drag.box.top, drag.box.width, drag.box.height));
      } else if (wasActive) {
        // A plain click on the selected field toggles it off.
        this.signatures.deselect();
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  protected onResizeStart(e: MouseEvent, field: StoreField): void {
    if (this.viewer.isPanning() || !field.rect || !isEditableField(field)) return;
    this.commitPendingRename();
    e.preventDefault();
    e.stopPropagation();
    this.signatures.select(field.uid);
    const viewport = this.viewer.viewport();
    if (!viewport) return;
    const start = this.viewer.pdfRectToScreen(field.rect, viewport);
    const startX = e.clientX;
    const startY = e.clientY;
    const canvas = this.viewer.canvasSize();

    const onMove = (ev: MouseEvent) => {
      let width = Math.max(20, start.width + (ev.clientX - startX));
      let height = Math.max(20, start.height + (ev.clientY - startY));
      width = Math.min(width, canvas.width - start.left);
      height = Math.min(height, canvas.height - start.top);
      this.drag.set({ uid: field.uid, box: { ...start, width, height } });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const drag = this.drag() ?? { uid: field.uid, box: start };
      this.drag.set(null);
      this.signatures.commitRect(field.uid, this.viewer.screenRectToPdf(drag.box.left, drag.box.top, drag.box.width, drag.box.height));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  protected onOverlayClick(e: MouseEvent, field: StoreField): void {
    // Overview mode: clicking an outlined object opens its detail sheet.
    if (this.ui.activeSection() !== 'metadata') return;
    this.overview.openSheet(field.type === 'Signature' ? 'signature' : 'field', field.name);
    e.stopPropagation();
  }

  protected onDeleteHandle(e: MouseEvent, field: StoreField): void {
    e.stopPropagation();
    if (!this.doc.activeFile()) return;
    this.signatures.select(field.uid);
    this.signatures.openRemoveFieldModal(field.name);
  }

  protected onTemplateGripDragStart(e: DragEvent, field: StoreField): void {
    this.templates.beginDocumentFieldDrag(field);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData(DOCUMENT_FIELD_DRAG_MIME, field.name);
      e.dataTransfer.setData('text/plain', field.name);
    }
  }

  // ---------------------------------------------------------------------
  // Measured layout (labels, invisible pins)
  // ---------------------------------------------------------------------

  /**
   * The label defaults to centred above the field; near a page edge it
   * re-anchors to whichever side (and above/below) actually has room.
   */
  private positionLabel(div: HTMLElement, label: HTMLElement): void {
    const layer = this.overlayRef().nativeElement;
    if (div.classList.contains('is-invisible-field') && div.dataset['pinLocalX'] !== undefined) {
      this.positionInvisibleLabel(div, label, layer);
      return;
    }
    label.style.left = '50%';
    label.style.right = '';
    label.style.top = '-34px';
    label.style.transform = 'translateX(-50%)';
    const containerRect = layer.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    if (labelRect.right > containerRect.right && labelRect.left - (labelRect.right - containerRect.right) >= containerRect.left) {
      label.style.left = 'auto';
      label.style.right = '0';
      label.style.transform = 'none';
    } else if (labelRect.left < containerRect.left) {
      label.style.left = '0';
      label.style.transform = 'none';
    }
    if (label.getBoundingClientRect().top < containerRect.top) label.style.top = 'calc(100% + 8px)';
  }

  private positionInvisibleLabel(div: HTMLElement, label: HTMLElement, layer: HTMLElement): void {
    const px = parseFloat(div.dataset['pinLocalX'] ?? '0');
    const py = parseFloat(div.dataset['pinLocalY'] ?? '0');
    label.style.right = '';
    label.style.left = `${px}px`;
    label.style.top = `${py - INVISIBLE_PIN_RADIUS - INVISIBLE_PIN_LABEL_GAP}px`;
    label.style.transform = 'translate(-50%, -100%)';
    const containerRect = layer.getBoundingClientRect();
    let labelRect = label.getBoundingClientRect();
    let dx = 0;
    if (labelRect.right > containerRect.right) dx = containerRect.right - labelRect.right;
    else if (labelRect.left < containerRect.left) dx = containerRect.left - labelRect.left;
    if (dx) {
      label.style.left = `${px + dx}px`;
      labelRect = label.getBoundingClientRect();
    }
    // No room above (clamped near the top edge) -- flip below.
    if (labelRect.top < containerRect.top) {
      label.style.top = `${py + INVISIBLE_PIN_RADIUS + INVISIBLE_PIN_LABEL_GAP}px`;
      label.style.transform = 'translate(-50%, 0%)';
    }
  }

  /** Read pass first, then write pass -- no layout thrash per chip. */
  private layoutInvisiblePins(): void {
    const layer = this.overlayRef().nativeElement;
    const entries: { div: HTMLElement; pin: HTMLElement }[] = [];
    layer.querySelectorAll<HTMLElement>('.is-invisible-field').forEach((div) => {
      const pin = div.querySelector<HTMLElement>(':scope > .field-invisible-pin');
      if (pin) entries.push({ div, pin });
    });
    if (!entries.length) return;

    const containerRect = layer.getBoundingClientRect();
    const fieldRects = entries.map(({ div }) => div.getBoundingClientRect());
    const pinRects = entries.map(({ pin }) => pin.getBoundingClientRect());
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const placements = entries.map(({ div, pin }, i) => {
      const fieldRect = fieldRects[i];
      const w = pinRects[i].width;
      const h = pinRects[i].height;
      const minX = containerRect.left + PIN_EDGE_INSET + w / 2;
      const maxX = containerRect.right - PIN_EDGE_INSET - w / 2;
      const minY = containerRect.top + PIN_EDGE_INSET + h / 2;
      const maxY = containerRect.bottom - PIN_EDGE_INSET - h / 2;
      const anchorX = fieldRect.left + fieldRect.width / 2;
      const anchorY = fieldRect.top + fieldRect.height / 2;
      const cx = Math.min(Math.max(anchorX, minX), maxX);
      const baseY = Math.min(Math.max(anchorY, minY), maxY);
      const dir = anchorY < containerRect.top + containerRect.height / 2 ? 1 : -1;
      let cy = baseY;
      const overlaps = () =>
        placed.some((p) => Math.abs(p.x - cx) < (p.w + w) / 2 + PIN_GAP && Math.abs(p.y - cy) < (p.h + h) / 2 + PIN_GAP);
      for (let step = 1; step <= 12 && overlaps(); step++) {
        cy = Math.min(Math.max(baseY + dir * (h + PIN_GAP) * step, minY), maxY);
      }
      placed.push({ x: cx, y: cy, w, h });
      return { div, pin, localX: cx - fieldRect.left, localY: cy - fieldRect.top };
    });
    placements.forEach(({ div, pin, localX, localY }) => {
      pin.style.left = `${localX}px`;
      pin.style.top = `${localY}px`;
      div.dataset['pinLocalX'] = String(localX);
      div.dataset['pinLocalY'] = String(localY);
    });
  }
}

