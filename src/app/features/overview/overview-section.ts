import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { curateRawEntries } from '../../../../lib/DocumentOverview';
import { DocumentStore } from '../../core/document.store';
import { UiService } from '../../core/ui.service';
import { formatFileSize } from '../../core/util/format';
import { dateFact, OvFacts, type FactModel } from '../../shared/ov-ui';
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
  template: `
    <div class="panel docinfo-panel" id="docInfoPanel">
      <div class="panel-overlay" id="docInfoPanelOverlay" [class.is-hidden]="!!doc.pdfDoc()">
        <div class="panel-overlay-text">Upload a document first to see its overview</div>
      </div>
      <h3><span class="panel-dot dot-ocean"></span>Overview</h3>

      <div class="meta-overview" id="metaOverview">
        @if (!doc.pdfDoc()) {
          <p class="field-details-empty">No document loaded yet.</p>
        } @else if (overview.error()) {
          <p class="field-details-empty">Error loading overview: {{ overview.error() }}</p>
        } @else if (overview.loading() && !doc.documentOverview()) {
          <div class="panel-loading"><span class="spinner" aria-hidden="true"></span> Loading overview…</div>
        } @else {
          <div class="overview-header">
            <div class="ov-hero is-document">
              <span class="ov-hero-lead" aria-hidden="true"><span class="icon icon-file-text"></span></span>
              <div class="ov-hero-main">
                <h4 class="ov-hero-label">{{ header().title }}</h4>
                @if (header().subtitle) {
                  <p class="ov-hero-sub">{{ header().subtitle }}</p>
                }
              </div>
              @if (header().pdfVersion) {
                <span class="ov-pill is-neutral">PDF {{ header().pdfVersion }}</span>
              }
            </div>
            <app-ov-facts [facts]="header().facts" />
          </div>

          @if (chips().length) {
            <div class="overview-chips">
              @for (chip of chips(); track chip.id) {
                @if (chip.goto) {
                  <button type="button" class="overview-chip is-{{ chip.tone }}" [attr.data-goto-section]="chip.goto" title="Open the Versions panel" (click)="goto(chip.goto)">
                    {{ chip.label }}
                  </button>
                } @else {
                  <span class="overview-chip is-{{ chip.tone }}" [attr.title]="chip.title || null">{{ chip.label }}</span>
                }
              }
            </div>
          }

          <div class="overview-list">
            <h4 class="overview-list-title">On this document</h4>
            @for (group of overview.groups(); track group.id) {
              <section class="overview-group">
                <div class="overview-group-head">
                  <h4>
                    {{ group.title }} <span class="overview-count">{{ group.rows.length }}</span>
                  </h4>
                  <button
                    type="button"
                    class="overview-eye"
                    [class.is-off]="group.hidden"
                    [attr.data-ov-toggle]="group.id"
                    [attr.aria-pressed]="!group.hidden"
                    [attr.aria-label]="(group.hidden ? 'Show ' : 'Hide ') + group.title.toLowerCase() + ' on the page'"
                    [title]="(group.hidden ? 'Show' : 'Hide') + ' on the page'"
                    (click)="overview.toggleGroup(group.id)"
                  >
                    <span class="icon {{ group.hidden ? 'icon-eye-off' : 'icon-eye' }}" aria-hidden="true"></span>
                  </button>
                </div>
                <ul class="overview-rows">
                  @for (item of group.rows; track item.kind + ':' + item.key) {
                    <li>
                      <button
                        type="button"
                        class="overview-row"
                        [class.is-selected]="isSelected(item)"
                        [attr.data-ov-kind]="item.kind"
                        [attr.data-ov-key]="item.key"
                        (click)="overview.activateItem(item.kind, item.key)"
                        (mouseenter)="hover(item, true)"
                        (mouseleave)="hover(item, false)"
                      >
                        <span class="overview-dot is-{{ item.kind }}" aria-hidden="true"></span>
                        <span class="icon {{ kinds[item.kind].icon }}" aria-hidden="true"></span>
                        <span class="overview-row-label">{{ item.label }}</span>
                        <span class="meta-badge {{ badgeClass(item) }}">{{ item.status }}</span>
                        <span class="overview-row-page">p. {{ item.page + 1 }}</span>
                      </button>
                    </li>
                  }
                </ul>
              </section>
            } @empty {
              <p class="field-details-empty">Nothing on this document yet — no signatures, stamps, form fields, links or comments.</p>
            }
          </div>

          @if (attachments().length) {
            <div class="meta-card">
              <h4 class="meta-card-title"><span class="icon icon-copy" aria-hidden="true"></span> Attachments</h4>
              @for (a of attachments(); track $index) {
                <div class="meta-attachment-row">
                  <span class="meta-attachment-name">{{ a.filename || 'attachment' }}</span>
                  <span class="meta-attachment-meta">{{ attachmentMeta(a.mimeType, a.size) }}</span>
                </div>
              }
              <p class="meta-card-subhead">Total: {{ attachments().length }} attachment{{ attachments().length === 1 ? '' : 's' }}</p>
            </div>
          }

          @if (moreRows().length || xmpRaw()) {
            <details class="overview-more">
              <summary>More details</summary>
              <div class="overview-more-body">
                @if (moreRows().length) {
                  <table class="field-details-table meta-kv-table">
                    @for (row of moreRows(); track $index) {
                      <tr>
                        <th>{{ row.label }}</th>
                        <td>{{ row.value }}</td>
                      </tr>
                    }
                  </table>
                }
                @if (xmpRaw(); as raw) {
                  <button type="button" class="btn btn-ghost meta-view-raw-btn" id="btnViewRawXmp" (click)="ui.xmpRaw.set(raw)">
                    <span class="icon icon-eye" aria-hidden="true"></span> View raw XMP
                  </button>
                }
              </div>
            </details>
          }

          @if (!doc.documentOverview()) {
            <p class="field-details-empty">Detailed info isn't available for this document (it was loaded without a server round-trip).</p>
          }
        }
      </div>
    </div>
  `,
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
