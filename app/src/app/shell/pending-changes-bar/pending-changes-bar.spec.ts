import { TestBed } from '@angular/core/testing';
import { DocumentStore } from '../../core/document.store';
import { SignaturesStore } from '../../features/signatures/signatures.store';
import { makeField } from '../../testing/fixtures';
import { provideTestApp } from '../../testing/providers';
import { PendingChangesBar } from './pending-changes-bar';

describe('PendingChangesBar', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: provideTestApp() }));

  it('appears with a recap once a change is staged and lists it in the details', async () => {
    const fixture = TestBed.createComponent(PendingChangesBar);
    await fixture.whenStable();
    const host: HTMLElement = fixture.nativeElement;
    expect(host.hidden).toBe(true);

    TestBed.inject(DocumentStore).resetFieldsFromServer([makeField('A')]);
    const signatures = TestBed.inject(SignaturesStore);
    signatures.stageNewField({ name: 'B', page: 0, rect: { x: 0, y: 0, width: 100, height: 40 } });
    await fixture.whenStable();

    expect(host.hidden).toBe(false);
    expect(host.querySelector('#pendingChangesLabel')?.textContent?.trim()).toBe('1 unsaved change');
    expect(host.querySelector('#pendingChangesDescription')?.textContent?.trim()).toBe('Added 1 field');

    signatures.togglePendingDetails();
    await fixture.whenStable();
    expect(host.querySelector('.pending-change-name')?.textContent?.trim()).toBe('B');
    expect(host.querySelector('.pending-change-tag')?.textContent?.trim()).toBe('Added');
  });
});
