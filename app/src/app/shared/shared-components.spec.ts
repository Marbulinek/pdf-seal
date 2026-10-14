import { TestBed } from '@angular/core/testing';
import { chainNodes, byteMapOf, validityTimeline } from '../features/certificates/certificates-model';
import { check, makeCert, makeChain, makeSignature } from '../testing/fixtures';
import { provideTestApp } from '../testing/providers';
import { CertBadge } from './cert-badge';
import { CertByteMap } from './cert-byte-map';
import { CertChain } from './cert-chain';
import { CheckCounts } from './check-counts';
import { DictionaryChanges } from './dictionary-changes';
import { Evidence } from './evidence';
import { ObjectBadges } from './object-badges';
import { OvFacts } from './ov-facts';
import { OvFlags } from './ov-flags';
import { OvHero } from './ov-hero';
import { StreamDiff } from './stream-diff';
import { ValidationList } from './validation-list';
import { ValidityTimeline } from './validity-timeline';
import { bareRawObject } from '../features/versions/versions-model';
import { UiService } from '../core/ui.service';

const byId = (id: string) => (id === 'leaf' ? makeCert('leaf') : id === 'ca' ? makeCert('ca', { role: 'root' }) : null);

describe('shared components', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: provideTestApp() }));

  it('renders a hero with a pill or a certificate badge', async () => {
    const fixture = TestBed.createComponent(OvHero);
    fixture.componentRef.setInput('hero', { kind: 'signature', icon: 'icon-pen', label: 'Sig', subtitle: 'Sub', badge: { type: 'pill', text: 'Unsigned', tone: 'pending' } });
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.ov-hero.is-signature .ov-hero-label')?.textContent).toBe('Sig');
    expect(el.querySelector('.ov-pill.is-pending')?.textContent).toBe('Unsigned');

    fixture.componentRef.setInput('hero', { kind: 'x', icon: 'i', label: 'L', avatar: 'AM', badge: { type: 'cert', status: 'fail' } });
    await fixture.whenStable();
    expect(el.querySelector('.ov-hero-lead.is-avatar')?.textContent).toBe('AM');
    expect(el.querySelector('.cert-badge.is-fail')?.textContent?.trim()).toBe('✕ Failed');

    const badge = TestBed.createComponent(CertBadge);
    badge.componentRef.setInput('status', 'pass');
    await badge.whenStable();
    expect(badge.nativeElement.textContent.trim()).toBe('✓ Pass');
  });

  it('drops empty facts and renders flags', async () => {
    const facts = TestBed.createComponent(OvFacts);
    facts.componentRef.setInput('facts', [
      { label: 'Pages', value: '2' },
      { label: 'Empty', value: '' },
      { label: 'Format', value: 'A4', sub: 'Portrait', wide: true },
      { label: 'Opacity', value: '50%', meter: 50 },
    ]);
    await facts.whenStable();
    const el: HTMLElement = facts.nativeElement;
    expect(Array.from(el.querySelectorAll('dt')).map((d) => d.textContent)).toEqual(['Pages', 'Format', 'Opacity']);
    expect(el.querySelector('.ov-fact.is-wide .ov-fact-sub')?.textContent).toBe('Portrait');
    expect(el.querySelector('.ov-meter span')).not.toBeNull();

    const flags = TestBed.createComponent(OvFlags);
    flags.componentRef.setInput('flags', [
      ['Required', true],
      ['Read-only', false],
    ]);
    await flags.whenStable();
    expect(flags.nativeElement.querySelectorAll('.ov-flag.is-on')).toHaveLength(1);
  });

  it('renders a chain and emits open/show events', async () => {
    const fixture = TestBed.createComponent(CertChain);
    fixture.componentRef.setInput('nodes', chainNodes(makeChain(), makeSignature(), byId));
    const opened: string[] = [];
    const shown: string[] = [];
    fixture.componentInstance.openCert.subscribe((id) => opened.push(id));
    fixture.componentInstance.showField.subscribe((f) => shown.push(f));
    await fixture.whenStable();
    const buttons = fixture.nativeElement.querySelectorAll('button.cert-node-body') as NodeListOf<HTMLButtonElement>;
    expect(buttons).toHaveLength(3);
    buttons[0].click();
    buttons[2].click();
    expect(opened).toEqual(['ca']);
    expect(shown).toEqual(['Sig1']);
  });

  it('renders the byte map and the validity timeline', async () => {
    const map = TestBed.createComponent(CertByteMap);
    map.componentRef.setInput('map', byteMapOf(makeSignature())!);
    await map.whenStable();
    expect(map.nativeElement.querySelectorAll('.cert-bytemap-seg')).toHaveLength(5);

    const timeline = TestBed.createComponent(ValidityTimeline);
    timeline.componentRef.setInput('timeline', validityTimeline(makeChain(), makeSignature(), byId, new Date('2024-06-01'))!);
    let expanded = 0;
    timeline.componentInstance.expand.subscribe(() => expanded++);
    await timeline.whenStable();
    const el: HTMLElement = timeline.nativeElement;
    expect(el.querySelectorAll('.cert-timeline-bar')).toHaveLength(2);
    (el.querySelector('.cert-timeline-expand') as HTMLButtonElement).click();
    expect(expanded).toBe(1);
  });

  it('lists checks, opening a certificate from a sourced row', async () => {
    const fixture = TestBed.createComponent(ValidationList);
    fixture.componentRef.setInput('checks', [
      { ...check('a', 'fail', 'Broken'), source: { kind: 'certificate', label: 'leaf', certificateId: 'leaf' } },
      check('b', 'pass', 'Fine'),
    ]);
    fixture.componentRef.setInput('showSource', true);
    const opened: string[] = [];
    fixture.componentInstance.openCert.subscribe((id) => opened.push(id));
    await fixture.whenStable();
    const rows = fixture.nativeElement.querySelectorAll('.cert-check-row') as NodeListOf<HTMLElement>;
    expect(rows[0].classList.contains('is-openable')).toBe(true);
    rows[0].click();
    rows[1].click();
    expect(opened).toEqual(['leaf']);

    const counts = TestBed.createComponent(CheckCounts);
    counts.componentRef.setInput('checks', [check('a', 'fail'), check('b', 'pass'), check('c', 'pass')]);
    await counts.whenStable();
    const pills = Array.from(counts.nativeElement.querySelectorAll('.cert-check-count') as NodeListOf<HTMLElement>);
    expect(pills.map((p) => [p.className, p.textContent?.trim()])).toEqual([
      ['cert-check-count is-fail', '✕ 1'],
      ['cert-check-count is-pass', '✓ 2'],
    ]);
  });

  it('shows evidence rows and offers the after-signing compare only for a native chain', async () => {
    const fixture = TestBed.createComponent(Evidence);
    fixture.componentRef.setInput('rows', [{ label: 'Later revisions', text: '1 later revision', slot: { from: 1, to: 2 } }]);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[data-evidence-action]')).toBeNull();
    fixture.componentRef.setInput('nativeChain', { 2: true });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[data-evidence-action]')?.textContent?.trim()).toBe('Show changes after signing');
  });

  it('renders dictionary changes with explainers and a stream diff', async () => {
    const dict = TestBed.createComponent(DictionaryChanges);
    dict.componentRef.setInput('changes', [
      { key: 'Rect', before: '[0 0 1 1]', after: '[0 0 2 2]', status: 'changed' },
      { key: 'Zzz', before: '', after: 'x', status: 'added' },
    ]);
    dict.componentRef.setInput('withExplainers', true);
    await dict.whenStable();
    const help = dict.nativeElement.querySelectorAll('.diff-dict-change-help') as NodeListOf<HTMLButtonElement>;
    expect(help).toHaveLength(1);
    help[0].click();
    expect(TestBed.inject(UiService).fieldInfoKey()).toBe('Rect');
    expect(dict.nativeElement.querySelector('.diff-dict-added')?.textContent).toBe('new: x');

    const stream = TestBed.createComponent(StreamDiff);
    stream.componentRef.setInput('diff', { available: true, contentUnchanged: false, added: ['BT'], removed: ['ET'], truncated: false, rawByteLengthBefore: 10, rawByteLengthAfter: 12 });
    await stream.whenStable();
    expect(stream.nativeElement.querySelector('.diff-stream-size-note')?.textContent).toBe('Stream size: 10 → 12 bytes');
    expect(stream.nativeElement.querySelectorAll('.diff-stream-line')).toHaveLength(2);

    const badges = TestBed.createComponent(ObjectBadges);
    badges.componentRef.setInput('item', { ...bareRawObject('1 0 R'), classifications: ['signing'], rects: [{ x: 0, y: 0, width: 0, height: 0 }] });
    await badges.whenStable();
    expect(badges.nativeElement.textContent).toContain('Signing');
    expect(badges.nativeElement.textContent).toContain('Invisible field');
  });
});
