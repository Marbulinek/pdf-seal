import { curateRawEntries, type OverviewItem, type OverviewKind } from './document-overview';
import type { CertificateReport, DocAnnotation, DocField, DocStamp } from '../../core/models';
import { cssEscape } from '../../core/util/dom';
import { ovInitials, ovShortDate } from '../../core/util/format';
import { dateFact, type FactModel } from '../../shared/ov-facts';
import type { HeroBadge, HeroModel, PillTone } from '../../shared/ov-hero';
import { signatureEvidenceRows, type EvidenceRow } from '../certificates/certificates-model';

export const OVERVIEW_KINDS: Record<OverviewKind, { single: string; icon: string }> = {
  signature: { single: 'Signature', icon: 'icon-pen' },
  stamp: { single: 'Stamp', icon: 'icon-stamp' },
  field: { single: 'Form field', icon: 'icon-file-text' },
  link: { single: 'Link', icon: 'icon-arrow-right' },
  comment: { single: 'Comment', icon: 'icon-chat' },
};

export interface OverviewGroup {
  id: string;
  title: string;
  kinds: OverviewKind[];
}

export const OVERVIEW_GROUPS: OverviewGroup[] = [
  { id: 'signature', title: 'Signatures', kinds: ['signature'] },
  { id: 'stamp', title: 'Stamps', kinds: ['stamp'] },
  { id: 'field', title: 'Form fields', kinds: ['field'] },
  { id: 'linkcomment', title: 'Links & comments', kinds: ['link', 'comment'] },
];

export const FIELD_STATE_FILLED = new Set(['Signed', 'Filled', 'Checked']);

export const OVERVIEW_STANDARD_INFO_KEYS = new Set([
  'Title',
  'Author',
  'Subject',
  'Keywords',
  'Creator',
  'Producer',
  'CreationDate',
  'ModDate',
  'Trapped',
]);

export const FIELD_TYPE_LABELS: Record<string, string> = {
  TextField: 'Text field',
  CheckBox: 'Checkbox',
  RadioGroup: 'Radio group',
  Dropdown: 'Dropdown',
  OptionList: 'List box',
  Button: 'Button',
};

/** The element on the page that represents an item (for flashing it). */
export function overviewSelector(item: Pick<OverviewItem, 'kind' | 'key'>): string {
  return item.kind === 'signature' || item.kind === 'field'
    ? `.field-overlay[data-field-name="${cssEscape(item.key)}"]`
    : `.overview-hotspot[data-kind="${item.kind}"][data-key="${cssEscape(item.key)}"]`;
}

export interface PageGroup {
  from: number;
  to: number;
  sizeName: string;
  orientation: string;
  rotation: number;
}

/** Consecutive pages sharing size/orientation/rotation fold into one range. */
export function groupPages(pages: { index: number; sizeName: string; orientation: string; rotation: number }[]): PageGroup[] {
  const groups: PageGroup[] = [];
  pages.forEach((page) => {
    const last = groups[groups.length - 1];
    if (last && last.sizeName === page.sizeName && last.orientation === page.orientation && last.rotation === page.rotation) {
      last.to = page.index;
    } else {
      groups.push({ from: page.index, to: page.index, sizeName: page.sizeName, orientation: page.orientation, rotation: page.rotation });
    }
  });
  return groups;
}

export type { OverviewItem, OverviewKind };

// ---------------------------------------------------------------------------
// Detail sheet view model
// ---------------------------------------------------------------------------

export type OverviewAction =
  | { kind: 'open-certificates'; field: string }
  | { kind: 'edit-signature'; field: string }
  | { kind: 'copy'; text: string }
  | { kind: 'goto-page'; page: number };

export interface OverviewSheetModel {
  title: string;
  icon: string;
  subject: string;
  hero: HeroModel;
  placement: { lines: string[]; title: string | null; hasRect: boolean };
  quote: string | null;
  url: { host: string; full: string } | null;
  facts: FactModel[];
  flags: [string, boolean][] | null;
  emptyNote: string | null;
  evidence: EvidenceRow[] | null;
  actions: OverviewAction[];
  /** Signatures, fields and stamps can be traced through stored versions. */
  traceable: boolean;
  tech: { label: string; key: string; value: string }[];
}

type SheetSource = Partial<DocField> & Partial<DocStamp> & Partial<DocAnnotation>;

function pill(text: string, tone: PillTone): HeroBadge {
  return { type: 'pill', text, tone };
}

/** Page, physical size and any extra widget pages -- under the snippet. */
export function placementLines(item: OverviewItem): OverviewSheetModel['placement'] {
  const r = item.rect;
  const source = item.source as SheetSource;
  const mm = (n: number) => Math.round((n * 25.4) / 7.2) / 10;
  const lines = [`Page ${item.page + 1}`];
  if (r && Number.isFinite(r.width)) lines.push(`${mm(r.width)} × ${mm(r.height)} mm`);
  const extra = (source.extraWidgets || []).filter((w) => w.page !== null && Number.isInteger(w.page));
  if (extra.length) lines.push(`Also on ${[...new Set(extra.map((w) => `page ${(w.page as number) + 1}`))].join(', ')}`);
  const title = r
    ? `${Math.round(r.width * 10) / 10} × ${Math.round(r.height * 10) / 10} pt at ${Math.round(r.x)}, ${Math.round(r.y)} pt from bottom-left`
    : null;
  return { lines, title, hasRect: !!r };
}

/**
 * Everything the Overview detail sheet shows for one item. `report` is the
 * Certificates report for the open file (signed signatures read it);
 * `settled` says the report request finished (so "Loading…" can give up).
 */
export function overviewSheetModel(item: OverviewItem, report: CertificateReport | null, settled: boolean): OverviewSheetModel {
  const s = item.source as SheetSource;
  const meta = OVERVIEW_KINDS[item.kind];
  const base = { kind: item.kind, label: item.label, icon: meta.icon };
  const model: OverviewSheetModel = {
    title: meta.single,
    icon: meta.icon,
    subject: `Page ${item.page + 1}`,
    hero: base,
    placement: placementLines(item),
    quote: null,
    url: null,
    facts: [],
    flags: null,
    emptyNote: null,
    evidence: null,
    actions: [],
    traceable: item.kind === 'signature' || item.kind === 'field' || item.kind === 'stamp',
    tech: [],
  };

  if (item.kind === 'signature') {
    if (item.status === 'Signed') {
      const sig = report?.signatures.find((x) => x.fieldName === s.name);
      if (sig) {
        const slot = sig.cmsSlot;
        const coverage = slot
          ? slot.coversWholeFile
            ? 'Covers the whole file'
            : `${slot.trailingBytes} byte${slot.trailingBytes === 1 ? '' : 's'} added after signing`
          : null;
        const when = sig.signedAttributes?.signingTime || sig.signingTimeClaimed;
        model.hero = {
          ...base,
          avatar: sig.name ? ovInitials(sig.name) : null,
          subtitle: [sig.name ? `Signed by ${sig.name}` : 'Signed', ovShortDate(when)].filter(Boolean).join(' · '),
          badge: { type: 'cert', status: sig.status },
        };
        model.facts = [
          dateFact('Signed', when, true),
          { label: 'Reason', value: sig.reason, wide: true },
          { label: 'Location', value: sig.location },
          { label: 'Coverage', value: coverage },
          { label: 'Field', value: s.name },
        ];
        model.flags = [['Timestamped', sig.hasTimestampToken]];
        model.evidence = signatureEvidenceRows(sig);
        model.actions.push({ kind: 'open-certificates', field: s.name ?? '' });
      } else {
        model.hero = { ...base, subtitle: 'Signed', badge: pill('Signed', 'positive') };
        model.emptyNote = settled ? 'Signature details could not be read.' : 'Loading signature details…';
      }
    } else {
      model.hero = { ...base, subtitle: 'Waiting to be signed', badge: pill('Unsigned', 'pending'), required: !!s.required };
      model.facts = [{ label: 'Tooltip', value: s.tooltip, wide: true }];
      model.flags = [
        ['Required', !!s.required],
        ['Read-only', !!s.readOnly],
      ];
      model.actions.push({ kind: 'edit-signature', field: s.name ?? '' });
    }
  } else if (item.kind === 'field') {
    const typeLabel = (s.type && FIELD_TYPE_LABELS[s.type]) || s.type || 'Form field';
    model.hero = { ...base, subtitle: typeLabel, badge: pill(item.status, FIELD_STATE_FILLED.has(item.status) ? 'positive' : 'neutral') };
    model.facts = [{ label: 'Tooltip', value: s.tooltip, wide: true }];
    model.flags = [
      ['Required', !!s.required],
      ['Read-only', !!s.readOnly],
    ];
  } else if (item.kind === 'stamp') {
    const kindLabel = s.kind === 'text' ? 'Text stamp' : s.kind === 'image' ? 'Image stamp' : 'Stamp from another tool';
    const opacity = Math.round((s.opacity ?? 1) * 100);
    model.hero = { ...base, subtitle: [kindLabel, s.author].filter(Boolean).join(' · '), badge: pill(item.status, 'neutral') };
    model.quote = s.text || null;
    model.facts = [
      { label: 'Note', value: s.note === item.label ? null : s.note, wide: true },
      { label: 'Opacity', value: `${opacity}%`, meter: opacity },
    ];
    model.flags = [['Locked', !!s.locked]];
  } else if (item.kind === 'link') {
    if (s.uri) {
      let host = '';
      try {
        host = new URL(s.uri).host;
      } catch {
        /* not a URL pdf-seal can parse; show it raw */
      }
      model.hero = { ...base, subtitle: host || 'External link', badge: pill('URL', 'neutral') };
      // Plain text on purpose: this is untrusted content from the PDF.
      model.url = { host, full: s.uri };
      model.actions.push({ kind: 'copy', text: s.uri });
    } else if (s.destPage !== undefined && Number.isInteger(s.destPage)) {
      model.hero = { ...base, subtitle: `Goes to page ${s.destPage + 1}`, badge: pill(`Page ${s.destPage + 1}`, 'neutral') };
      model.actions.push({ kind: 'goto-page', page: s.destPage });
    } else {
      model.hero = { ...base, subtitle: 'No destination' };
      model.emptyNote = 'This link has no destination pdf-seal can show.';
    }
  } else {
    const type = s.subtype === 'Text' ? 'Note' : s.subtype === 'FreeText' ? 'Text box' : (s.subtype ?? '');
    // The comment text gets its own quote, so the hero names only the type.
    model.hero = {
      ...base,
      label: s.contents ? type : item.label,
      avatar: s.author ? ovInitials(s.author) : null,
      subtitle: [s.author, ovShortDate(s.modified)].filter(Boolean).join(' · '),
    };
    model.quote = s.contents || null;
    model.facts = [dateFact('Modified', s.modified)];
  }

  const ref = s.ref || (s.objectRefs && s.objectRefs[0]) || null;
  model.tech = [...(ref ? [{ label: 'Object', key: 'ref', value: ref }] : []), ...curateRawEntries(s.raw)];
  return model;
}

/** "Open in Certificates" etc. -- the footer buttons' copy. */
export function overviewActionLabel(action: OverviewAction): { label: string; icon: string | null; primary: boolean } {
  switch (action.kind) {
    case 'open-certificates':
      return { label: 'Open in Certificates', icon: null, primary: true };
    case 'edit-signature':
      return { label: 'Edit in Signatures', icon: null, primary: true };
    case 'copy':
      return { label: 'Copy link', icon: 'icon-copy', primary: false };
    case 'goto-page':
      return { label: `Go to page ${action.page + 1}`, icon: null, primary: true };
  }
}
