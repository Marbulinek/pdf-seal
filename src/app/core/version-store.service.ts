import { Injectable, inject } from '@angular/core';
import {
  classifySave,
  findRevisionEndOffsets,
  parseRevisionChain,
  versionReadPlan,
  type SaveKind,
  type VersionSource,
} from '../../../lib/VersionHistory';
import { DocumentStore } from './document.store';
import type { RevisionSummary } from './models';
import { NotificationService } from './notification.service';
import { PdfJsService } from './pdfjs.service';
import { base64ToBytes } from './util/base64';
import { runAtIdle } from './util/dom';
import { createSessionId } from './util/ids';

export interface VersionMeta {
  sessionId: string;
  index: number;
  versionKey: string;
  savedAt: number;
  source: VersionSource;
  saveKind: SaveKind;
  byteLength: number;
  storage: 'full' | 'delta';
  baseKey: string | null;
  summary: RevisionSummary | null;
}

export interface VersionWriteMeta {
  source: VersionSource;
  saveKind: SaveKind;
  versionKey: string;
  storage: 'full' | 'delta';
  baseKey: string | null;
  byteLength: number;
}

interface HydrateState {
  prevBytes: Uint8Array | null;
  storedIndex: number;
  versionKey: string | null;
}

export interface HydrationResult {
  count: number;
  versionKey: string | null;
}

// `pdfseal-versions` is a new database name rather than a version bump on the
// old `pdfseal-revisions` -- an IndexedDB upgrade blocks until every other tab
// with the old database closes it; a fresh name sidesteps that. All three
// stores are keyed [sessionId, index] except versionSessions (sessionId):
//   versionMeta     {sessionId, index, versionKey, savedAt, source, saveKind, byteLength, storage, baseKey, summary}
//   versionBytes    {sessionId, index, buffer}
//   versionSessions {sessionId, lastSavedAt}
const VERSION_DB_NAME = 'pdfseal-versions';
const VERSION_META_STORE = 'versionMeta';
const VERSION_BYTES_STORE = 'versionBytes';
const VERSION_SESSIONS_STORE = 'versionSessions';
const OLD_REVISION_DB_NAME = 'pdfseal-revisions';
const STALE_SESSION_MS = 6 * 60 * 60 * 1000; // 6 hours

/** The view's backing buffer when it spans all of it, else a tight copy. */
export function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer as ArrayBuffer;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Cheap pre-filter for hydrateBundledChain: if neither string appears in the
 * raw bytes, this app's chain format (a literal JSON string under a custom
 * Info key) cannot be present -- nor hidden inside a compressed object
 * stream (that would need an /ObjStm).
 */
const BUNDLED_CHAIN_HINT_STRINGS = ['PdfSealRevisionChain', '/ObjStm'];

/**
 * Local version history, entirely in this browser (IndexedDB). Every edit's
 * resulting PDF is cached here per document session, so the server only ever
 * sees the current document; history is bundled back into a PDF only on an
 * explicit export.
 */
@Injectable({ providedIn: 'root' })
export class VersionStoreService {
  private readonly store = inject(DocumentStore);
  private readonly notifications = inject(NotificationService);
  private readonly pdfjs = inject(PdfJsService);

  private dbPromise: Promise<IDBDatabase> | null = null;
  /**
   * The most recently started version write's completion promise --
   * consulted before building a delta against activeVersionKey, so a delta is
   * only ever based on a write confirmed to have landed.
   */
  lastVersionWriteCompletion: Promise<void> | null = null;

  constructor() {
    if (typeof indexedDB === 'undefined') return;
    // The pre-v2 database, deleted at idle (another tab still on old code
    // holding it open would otherwise block this indefinitely).
    runAtIdle(
      () => {
        try {
          indexedDB.deleteDatabase(OLD_REVISION_DB_NAME);
        } catch {
          /* best-effort */
        }
      },
      5000,
      2000,
    );
    this.sweepStaleSessions().catch(() => {});
  }

  open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(VERSION_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(VERSION_META_STORE)) {
          db.createObjectStore(VERSION_META_STORE, { keyPath: ['sessionId', 'index'] });
        }
        if (!db.objectStoreNames.contains(VERSION_BYTES_STORE)) {
          db.createObjectStore(VERSION_BYTES_STORE, { keyPath: ['sessionId', 'index'] });
        }
        if (!db.objectStoreNames.contains(VERSION_SESSIONS_STORE)) {
          db.createObjectStore(VERSION_SESSIONS_STORE, { keyPath: 'sessionId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Could not open the local version store.'));
    }).catch((err) => {
      // Don't cache a failed open forever -- a transient failure would
      // otherwise disable local version tracking for the page's life.
      this.dbPromise = null;
      throw err;
    });
    return this.dbPromise;
  }

  /**
   * Starts a version write: opens one readwrite transaction across all three
   * stores and -- synchronously, no await in between -- put()s each row and
   * deletes any rows above `index` (orphaned by an undo/redo that reused the
   * index). put() structured-clones its value immediately, so as long as this
   * runs before `dataBuffer` is handed to pdf.js (which detaches it) the
   * stored copy is unaffected.
   *
   * Resolves once the put()s are queued, with the transaction's completion
   * promise wrapped in an object -- so awaiting this call does *not* wait for
   * the write to land; callers join `completion` later, off the critical path.
   */
  async startWrite(sessionId: string, index: number, dataBuffer: ArrayBuffer, meta: VersionWriteMeta): Promise<{ completion: Promise<void> }> {
    const db = await this.open();
    const now = Date.now();

    const tx = db.transaction([VERSION_META_STORE, VERSION_BYTES_STORE, VERSION_SESSIONS_STORE], 'readwrite');
    const metaStore = tx.objectStore(VERSION_META_STORE);
    const bytesStore = tx.objectStore(VERSION_BYTES_STORE);
    const sessionsStore = tx.objectStore(VERSION_SESSIONS_STORE);

    bytesStore.put({ sessionId, index, buffer: dataBuffer });
    metaStore.put({
      sessionId,
      index,
      versionKey: meta.versionKey,
      savedAt: now,
      source: meta.source,
      saveKind: meta.saveKind,
      byteLength: meta.byteLength,
      storage: meta.storage,
      baseKey: meta.baseKey,
      summary: null,
    });
    // Backs sweepStaleSessions(): a session with no writes for a long time is
    // one whose tab was closed (or crashed) without cleaning up.
    sessionsStore.put({ sessionId, lastSavedAt: now });

    const orphanedAbove = IDBKeyRange.bound([sessionId, index + 1], [sessionId, Infinity]);
    metaStore.delete(orphanedAbove);
    bytesStore.delete(orphanedAbove);

    const completion = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(tx.error || new Error('Could not save this version locally -- the browser may be low on storage space.'));
      tx.onerror = () => reject(tx.error || new Error('Could not save this version locally.'));
    });
    this.lastVersionWriteCompletion = completion;
    // Observed here so an unjoined failure never surfaces as an unhandled rejection.
    completion.catch(() => {});
    return { completion };
  }

  /** Starts a write and waits for it to land. */
  async beginWrite(sessionId: string, index: number, dataBuffer: ArrayBuffer, meta: VersionWriteMeta): Promise<void> {
    const { completion } = await this.startWrite(sessionId, index, dataBuffer, meta);
    await completion;
  }

  /** Surfaces a version write's eventual failure instead of letting it disappear. */
  reportWriteFailure = (err: unknown): void => {
    this.notifications.show(`Could not save this version locally: ${(err as Error)?.message ?? err}`, 'error', 8000);
  };

  private async getBytesRow(sessionId: string, index: number): Promise<{ buffer: ArrayBuffer } | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(VERSION_BYTES_STORE, 'readonly');
      const req = tx.objectStore(VERSION_BYTES_STORE).get([sessionId, index]);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('Could not read a local version.'));
    });
  }

  /**
   * Reconstructs the version at `index` as a Blob: its own bytes if stored in
   * full, or its base followed by each delta (versionReadPlan walks that chain,
   * base first). Null for anything not cleanly reconstructable.
   */
  async getBlob(sessionId: string, index: number): Promise<Blob | null> {
    let chain: { index: number }[];
    try {
      const metas = await this.listMeta(sessionId);
      chain = versionReadPlan(metas, index);
    } catch {
      return null;
    }
    const rows = await Promise.all(chain.map((meta) => this.getBytesRow(sessionId, meta.index)));
    if (rows.some((row) => !row)) return null;
    return new Blob(
      rows.map((row) => row!.buffer),
      { type: 'application/pdf' },
    );
  }

  /** pdf.js wants an ArrayBuffer for `data`, not a Blob. */
  async getBytes(sessionId: string, index: number): Promise<ArrayBuffer | null> {
    const blob = await this.getBlob(sessionId, index);
    return blob ? await blob.arrayBuffer() : null;
  }

  /** Meta rows only (no PDF bytes), oldest first. */
  async listMeta(sessionId: string | null): Promise<VersionMeta[]> {
    if (!sessionId) return [];
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(VERSION_META_STORE, 'readonly');
      const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]);
      const req = tx.objectStore(VERSION_META_STORE).getAll(range);
      req.onsuccess = () => resolve(((req.result || []) as VersionMeta[]).sort((a, b) => a.index - b.index));
      req.onerror = () => reject(req.error || new Error('Could not read local versions.'));
    });
  }

  /**
   * Persists a computed summary into that version's row -- only if its
   * versionKey still matches (an overwritten index must not be mislabelled).
   */
  async saveSummary(sessionId: string, index: number, versionKey: string, summary: RevisionSummary): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(VERSION_META_STORE, 'readwrite');
      const store = tx.objectStore(VERSION_META_STORE);
      const req = store.get([sessionId, index]);
      req.onsuccess = () => {
        const row = req.result;
        if (row && row.versionKey === versionKey) {
          row.summary = summary;
          store.put(row);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Could not save this version's summary."));
    });
  }

  /** Deletes exactly one stored version -- undoes a speculative write. */
  async deleteVersion(sessionId: string | null, index: number): Promise<void> {
    if (!sessionId) return;
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([VERSION_META_STORE, VERSION_BYTES_STORE], 'readwrite');
      tx.objectStore(VERSION_META_STORE).delete([sessionId, index]);
      tx.objectStore(VERSION_BYTES_STORE).delete([sessionId, index]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Could not remove that local version.'));
    });
  }

  async clearSession(sessionId: string | null): Promise<void> {
    if (!sessionId) return;
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([VERSION_META_STORE, VERSION_BYTES_STORE, VERSION_SESSIONS_STORE], 'readwrite');
      const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]);
      tx.objectStore(VERSION_META_STORE).delete(range);
      tx.objectStore(VERSION_BYTES_STORE).delete(range);
      tx.objectStore(VERSION_SESSIONS_STORE).delete(sessionId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Could not clear local versions.'));
    });
  }

  /**
   * A closed/crashed tab leaves its session's rows behind; this startup sweep
   * deletes every session whose newest write is older than STALE_SESSION_MS.
   * Reads versionSessions only, so it costs nothing proportional to history.
   */
  async sweepStaleSessions(): Promise<void> {
    const db = await this.open();
    const sessions = await new Promise<{ sessionId: string; lastSavedAt: number }[]>((resolve, reject) => {
      const tx = db.transaction(VERSION_SESSIONS_STORE, 'readonly');
      const req = tx.objectStore(VERSION_SESSIONS_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error('Could not scan local versions.'));
    }).catch(() => []);

    const cutoff = Date.now() - STALE_SESSION_MS;
    for (const s of sessions) {
      if ((s.lastSavedAt || 0) < cutoff) await this.clearSession(s.sessionId).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------
  // Hydration: unpack whichever revision history a freshly opened file
  // carries into local versions 1..N-1, one version at a time.
  // ---------------------------------------------------------------------

  private stillCurrent(sessionId: string): boolean {
    return sessionId === this.store.documentSessionId();
  }

  /**
   * Classifies `currBytes` against the previous step and stores it (unless
   * byte-identical), threading state into the next call -- never holding more
   * than the current and previous version's bytes together.
   */
  private async hydrateStoreStep(sessionId: string, state: HydrateState, currBytes: Uint8Array, source: VersionSource): Promise<HydrateState> {
    const saveKind = classifySave(state.prevBytes, currBytes);
    if (saveKind === 'identical') return state;
    const index = state.storedIndex + 1;
    const versionKey = createSessionId();
    const buffer = ownBuffer(currBytes);
    await this.beginWrite(sessionId, index, buffer, {
      source,
      saveKind,
      versionKey,
      storage: 'full',
      baseKey: null,
      byteLength: currBytes.byteLength,
    }).catch(this.reportWriteFailure);
    return { prevBytes: currBytes, storedIndex: index, versionKey };
  }

  /**
   * This app's own bundled chain (an export with "Include versions" on).
   * Decodes, classifies, stores and releases one entry at a time. Null when
   * there's nothing usable, so the caller can fall back to native detection.
   */
  private async hydrateBundledChain(sessionId: string, file: Blob, currentFileBytes: Uint8Array): Promise<HydrationResult | null> {
    let rawChain: string | null = await this.pdfjs.readBundledChainRaw(file);
    if (!rawChain) return null;
    const entries = parseRevisionChain(rawChain);
    rawChain = null; // multi-MB string; let go of it now that it's parsed
    if (!entries.length) return null;
    if (!this.stillCurrent(sessionId)) return null;

    let state: HydrateState = { prevBytes: null, storedIndex: 0, versionKey: null };
    const priorEntries = entries.slice(0, -1); // the last entry is the current file itself
    for (const entry of priorEntries) {
      if (!this.stillCurrent(sessionId)) return null;
      const currBytes = base64ToBytes(entry.bytes as string);
      (entry as { bytes: string | null }).bytes = null;
      state = await this.hydrateStoreStep(sessionId, state, currBytes, 'imported');
    }
    if (!this.stillCurrent(sessionId)) return null;
    state = await this.hydrateStoreStep(sessionId, state, currentFileBytes, 'upload');
    return { count: state.storedIndex, versionKey: state.versionKey };
  }

  /**
   * A file incrementally updated by another tool: genuine `startxref ... %%EOF`
   * boundaries are exact append points, so the first is stored in full and
   * each later one as the literal delta between consecutive boundaries (read
   * via file.slice() so the full byte array can fall out of scope).
   */
  private async hydrateNativeChain(sessionId: string, file: Blob, bytes: Uint8Array | null): Promise<HydrationResult | null> {
    const boundaries = findRevisionEndOffsets(bytes!);
    bytes = null;
    if (boundaries.length < 2) return null;

    let storedIndex = 0;
    let versionKey: string | null = null;
    let priorVersionKey: string | null = null;
    let start = 0;

    for (let i = 0; i < boundaries.length; i++) {
      if (!this.stillCurrent(sessionId)) return null;
      const isLast = i === boundaries.length - 1;
      const end = isLast ? file.size : boundaries[i];
      const segment = await file.slice(start, end).arrayBuffer();

      storedIndex += 1;
      versionKey = createSessionId();
      await this.beginWrite(sessionId, storedIndex, segment, {
        source: isLast ? 'upload' : 'imported',
        saveKind: i === 0 ? 'initial' : 'incremental',
        versionKey,
        storage: i === 0 ? 'full' : 'delta',
        baseKey: i === 0 ? null : priorVersionKey,
        byteLength: end, // the full reconstructed size, not just this segment's
      }).catch(this.reportWriteFailure);

      priorVersionKey = versionKey;
      start = end;
    }
    return { count: storedIndex, versionKey };
  }

  /**
   * This app's bundled chain first, then a native incremental chain; nothing
   * for a file with neither.
   */
  async hydrateRevisions(sessionId: string, file: Blob): Promise<HydrationResult | null> {
    const arrayBuffer = await file.arrayBuffer();
    const currentFileBytes = new Uint8Array(arrayBuffer);
    if (!this.stillCurrent(sessionId)) return null;

    const latin1Text = new TextDecoder('latin1').decode(currentFileBytes);
    if (BUNDLED_CHAIN_HINT_STRINGS.some((needle) => latin1Text.includes(needle))) {
      const bundled = await this.hydrateBundledChain(sessionId, file, currentFileBytes);
      if (bundled) return bundled;
      if (!this.stillCurrent(sessionId)) return null;
    }
    return this.hydrateNativeChain(sessionId, file, currentFileBytes);
  }
}
