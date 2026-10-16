import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { curateRawEntries } from './document-overview';
import { DocumentStore } from '../../core/document.store';
import { UiService } from '../../core/ui.service';
import { formatFileSize } from '../../core/util/format';
import { dateFact, OvFacts, type FactModel } from '../../shared/ov-facts';
import { CertificatesStore } from '../certificates/certificates.store';
import { FIELD_STATE_FILLED, OVERVIEW_KINDS, OVERVIEW_STANDARD_INFO_KEYS, groupPages, type OverviewItem } from './overview-model';
import { OverviewStore } from './overview.store';

interface KvRow {
  label: string;
  value: string | null | undefined;
}

/**
 * Overview: what the PDF is (hero + facts), the at-a-glance chips, and a
 * list of everything on it. The same list drives the hotspots outlined on
 * the page while this section is open, and the detail sheet.
 */
@Component({
  selector: 'section[appOverviewSection]',
  imports: [OvFacts],
  templateUrl: './overview-section.html',
  styleUrl: './overview-section.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'sectionMetaData',
    class: 'section-panel active section-panel-enter',
    'data-section-panel': 'metadata',
  },
})
export class OverviewSection {
  protected readonly ui = inject(UiService);
  protected readonly doc = inject(DocumentStore);
  protected readonly overview = inject(OverviewStore);
  private readonly certificates = inject(CertificatesStore);

  protected readonly kinds = OVERVIEW_KINDS;

  protected readonly header = computed(() => {
    const ov = this.doc.documentOverview();
    const info = ov?.documentInfo ?? null;
    const fileName = this.doc.activeFile()?.name || '';
    const title = (info?.title || '').trim() || fileName || 'Untitled document';
    const pageCount = info?.pageCount ?? this.doc.pdfDoc()?.numPages ?? null;

    const pages = ov?.pages || [];
    const groups = pages.length ? groupPages(pages) : [];
    let format: FactModel = { label: 'Format', value: null, wide: true };
    if (groups.length === 1) {
      const p = pages[0];
      const [w, h] = p.rotation % 180 ? [p.height, p.width] : [p.width, p.height];
      const mm = (pt: number) => Math.round((pt * 25.4) / 72);
      format = { label: 'Format', value: groups[0].sizeName, sub: `${groups[0].orientation} · ${mm(w)} × ${mm(h)} mm`, wide: true };
    } else if (groups.length > 1) {
      format = { label: 'Format', value: 'Mixed sizes', wide: true };
    }
    const madeWith = [...new Set([info?.creator, info?.producer].filter((v): v is string => !!v))].join(' / ');
    const subtitle = [info?.author, title !== fileName ? fileName : null].filter(Boolean).join(' · ');
    const facts: FactModel[] = [
      { label: 'Pages', value: pageCount ? String(pageCount) : null },
      { label: 'File size', value: formatFileSize(info?.fileSize ?? this.doc.activeFile()?.size ?? null) },
      format,
      dateFact('Created', info?.creationDate),
      dateFact('Modified', info?.modificationDate),
      { label: 'Made with', value: madeWith, wide: true },
    ];
    return { title, subtitle, pdfVersion: info?.pdfVersion ?? null, facts };
  });

  /** At-a-glance chips; the "Signed" one carries the Certificates headline once known. */
  protected readonly chips = computed(() => {
    const report = this.certificates.reportForActiveFile();
    return this.overview.chips().map((c) => {
      if (c.id !== 'signed' || !report?.summary) return c;
      const status = report.summary.status;
      return {
        ...c,
        title: report.summary.headline || '',
        tone: status === 'pass' ? ('positive' as const) : status === 'fail' ? ('warning' as const) : ('neutral' as const),
      };
    });
  });

  protected readonly attachments = computed(() => this.doc.documentOverview()?.attachments ?? []);

  protected readonly moreRows = computed<KvRow[]>(() => {
    const ov = this.doc.documentOverview();
    const info = ov?.documentInfo;
    const xmp = ov?.xmp;
    const ids = ov?.documentIds;
    const features = ov?.features;
    const rows: KvRow[] = [
      { label: 'Subject', value: info?.subject },
      { label: 'Keywords', value: Array.isArray(info?.keywords) ? info.keywords.join(', ') : info?.keywords },
      { label: 'Linearized', value: features?.linearized ? 'Yes' : '' },
      { label: 'XFA forms', value: features?.xfa ? 'Yes' : '' },
      { label: 'XMP title', value: xmp?.title },
      { label: 'XMP creator tool', value: xmp?.creatorTool },
      { label: 'Permanent document ID', value: ids?.permanent },
      { label: 'Changing document ID', value: ids?.changing },
      { label: 'XMP document ID', value: ids?.xmpDocumentId },
      { label: 'XMP instance ID', value: ids?.xmpInstanceId },
    ];
    const custom: Record<string, string> = {};
    Object.entries(this.doc.documentRawInfo() || {}).forEach(([k, v]) => {
      if (!OVERVIEW_STANDARD_INFO_KEYS.has(k)) custom[k] = typeof v === 'string' ? v : JSON.stringify(v);
    });
    curateRawEntries(custom).forEach((r) => rows.push({ label: r.label, value: r.value }));
    return rows.filter((r) => r.value !== null && r.value !== undefined && r.value !== '');
  });

  protected readonly xmpRaw = computed(() => this.doc.documentOverview()?.xmp?.raw || null);

  protected badgeClass(item: OverviewItem): string {
    const fieldish = item.kind === 'signature' || item.kind === 'field';
    return fieldish && FIELD_STATE_FILLED.has(item.status) ? 'meta-badge-yes' : 'meta-badge-no';
  }

  protected isSelected(item: OverviewItem): boolean {
    const active = this.overview.activeItem();
    return !!active && this.ui.sheets.overview() && active.kind === item.kind && active.key === item.key;
  }

  protected hover(item: OverviewItem, on: boolean): void {
    this.overview.setHover(on ? { kind: item.kind, key: item.key } : null);
  }

  protected attachmentMeta(mimeType: string | null, size: number | null): string {
    return [mimeType, formatFileSize(size)].filter(Boolean).join(' · ') || '—';
  }

  protected goto(section: string): void {
    if (section === 'revisions' || section === 'signatures' || section === 'certificates' || section === 'metadata') {
      void this.ui.goToSection(section);
    }
  }
}
