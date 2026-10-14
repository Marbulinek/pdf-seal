import { TestBed } from '@angular/core/testing';
import { jsonResponse, mockFetch } from '../../testing/network';
import { provideTestApp } from '../../testing/providers';
import { Footer } from './footer';

describe('Footer', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: provideTestApp() }));

  async function versionText(): Promise<string | undefined> {
    const fixture = TestBed.createComponent(Footer);
    await fixture.whenStable();
    return fixture.nativeElement.querySelector('#footerVersion')?.textContent?.trim();
  }

  it('shows the version /api/version reports', async () => {
    const calls = mockFetch(() => jsonResponse({ version: '1.2.3', name: 'pdf-seal' }));
    expect(await versionText()).toBe('v.1.2.3');
    expect(calls.map((c) => c.url)).toEqual(['/api/version']);
  });

  it('falls back when the API errors or answers without a version', async () => {
    mockFetch(() => jsonResponse({ error: 'boom' }, 500));
    expect(await versionText()).toBe('Version unavailable');

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: provideTestApp() });
    mockFetch(() => jsonResponse({ version: '  ' }));
    expect(await versionText()).toBe('Version unavailable');
  });

  it('falls back when no server is reachable', async () => {
    // The default in every spec: test-setup.ts blocks the real network.
    expect(await versionText()).toBe('Version unavailable');
  });
});
