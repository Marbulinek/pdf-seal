import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';
import { PORT_PROVIDERS } from './core/port-providers';
import { UiService } from './core/ui.service';

describe('App', () => {
  beforeEach(() => {
    localStorage.setItem('pdfseal-ext-modal-seen', '1');
    TestBed.configureTestingModule({ providers: [provideRouter(routes), ...PORT_PROVIDERS] });
  });

  it('renders the shell: top bar, empty viewer and the four sections', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('header.topbar')).not.toBeNull();
    expect(el.querySelector('#emptyStateViewer')).not.toBeNull();
    const nav = Array.from(el.querySelectorAll('.section-nav-btn')).map((b) => b.textContent?.trim());
    expect(nav).toEqual(['Overview', 'Signatures', 'Versions', 'Certificates']);
  });

  it('lazily loads a section per route and tracks it as the active section', async () => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    const ui = TestBed.inject(UiService);

    await router.navigateByUrl('/');
    await fixture.whenStable();
    expect(ui.activeSection()).toBe('metadata');
    expect(fixture.nativeElement.querySelector('#sectionMetaData')).not.toBeNull();

    await router.navigateByUrl('/versions');
    await fixture.whenStable();
    expect(ui.activeSection()).toBe('revisions');
    expect(document.body.dataset['activeSection']).toBe('revisions');
    expect(fixture.nativeElement.querySelector('#sectionRevisions')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('#sectionMetaData')).toBeNull();
  });

  it('closes the open modal on Escape before touching sheets', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const ui = TestBed.inject(UiService);
    ui.helpModalOpen.set(true);
    ui.openSheet('overview');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(ui.helpModalOpen()).toBe(false);
    expect(ui.sheets.overview()).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(ui.sheets.overview()).toBe(false);
  });

  it('shows the "Page not found" page, without the workspace, for an unknown URL', async () => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/no-such-page');
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('main h1')?.textContent).toBe('Page not found');
    expect(el.querySelector('header.topbar')).toBeNull();

    await router.navigateByUrl('/');
    await fixture.whenStable();
    expect(el.querySelector('main h1')).toBeNull();
    expect(el.querySelector('header.topbar')).not.toBeNull();
  });

  it('treats a malformed share link as not found', async () => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/share/bad!');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('main h1')?.textContent).toBe('Page not found');
  });
});
