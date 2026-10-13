import { Routes } from '@angular/router';
import type { SectionId } from './core/ui.service';

/**
 * Each document section (the right-hand column) is its own lazily-loaded
 * route. The viewer on the left, the sheets and the modals live in the shell
 * (`App`) and survive every section switch, exactly like the original
 * single-page layout where only the right-hand column swapped content.
 */
export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'PDF Seal :: Workspace',
    data: { section: 'metadata' satisfies SectionId },
    loadComponent: () => import('./features/overview/overview-section').then((m) => m.OverviewSection),
  },
  {
    path: 'signatures',
    title: 'PDF Seal :: Signatures',
    data: { section: 'signatures' satisfies SectionId },
    loadComponent: () => import('./features/signatures/signatures-section').then((m) => m.SignaturesSection),
  },
  {
    path: 'versions',
    title: 'PDF Seal :: Versions',
    data: { section: 'revisions' satisfies SectionId },
    loadComponent: () => import('./features/versions/versions-section').then((m) => m.VersionsSection),
  },
  {
    path: 'certificates',
    title: 'PDF Seal :: Certificates',
    data: { section: 'certificates' satisfies SectionId },
    loadComponent: () => import('./features/certificates/certificates-section').then((m) => m.CertificatesSection),
  },
  {
    // A recipient's share link: the workspace opens on Overview and the
    // receive flow starts automatically (see App.onNavigated).
    path: 'share/:sessionId',
    title: 'PDF Seal :: Receiving a PDF',
    data: { section: 'metadata' satisfies SectionId, share: true },
    loadComponent: () => import('./features/overview/overview-section').then((m) => m.OverviewSection),
  },
  { path: '**', redirectTo: '' },
];
