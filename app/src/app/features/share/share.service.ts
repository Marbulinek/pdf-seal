import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service';
import { errorMessage } from '../../core/document.service';
import { DocumentStore } from '../../core/document.store';
import type { DocField } from '../../core/models';
import { SettingsService } from '../../core/settings.service';
import { base64UrlToBytes, bytesToBase64Url } from '../../core/util/base64';
import { createCompactShareToken, createSessionId } from '../../core/util/ids';
import { lazyInject } from '../../core/util/lazy';
import { DOCUMENTS, EXPORT, SIGNATURES, type SharePort } from '../../core/ports';

const SHARE_CHUNK_BYTES = 64 * 1024;
const SHARE_HIGH_WATER_MARK = 512 * 1024;
const SHARE_LOW_WATER_MARK = 256 * 1024;
const ICE_RESTART_DELAY_MS = 2500;
const WEBRTC_CONNECT_TIMEOUT_MS = 12000;
const WS_RECONNECT_MAX_MS = 8000;

export const SENDER_STEPS = [
  { key: 'prepare', label: 'Preparing' },
  { key: 'waiting', label: 'Waiting for recipient' },
  { key: 'sending', label: 'Sending' },
  { key: 'done', label: 'Sent' },
] as const;
export const RECEIVER_STEPS = [
  { key: 'connecting', label: 'Connecting' },
  { key: 'waiting', label: 'Waiting for sender' },
  { key: 'receiving', label: 'Receiving' },
  { key: 'done', label: 'Received' },
] as const;

export type ShareRole = 'sender' | 'receiver';
export type ShareStatusType = '' | 'waiting' | 'success' | 'error';

interface ShareMeta {
  sessionId: string;
  name: string;
  size: number;
  encryptedSize: number;
  sha256: string;
  iv: string;
  fields: Pick<DocField, 'name' | 'type' | 'required' | 'readOnly' | 'multiline' | 'tooltip' | 'page' | 'rect'>[];
  algorithm: 'AES-GCM';
}

/** Messages the signaling server sends (see server.ts' WebSocketServer). */
interface SignalMessage {
  type: string;
  receiverId?: string;
  fileReady?: boolean;
  fileMeta?: ShareMeta;
  role?: ShareRole;
  receiverCount?: number;
  relayReceivedBytes?: number;
  receivedBytes?: number;
  payload?: SignalPayload;
  offset?: number;
  encryptedSize?: number;
  message?: string;
}

interface SignalPayload {
  description?: RTCSessionDescriptionInit | null;
  candidate?: RTCIceCandidateInit;
}

type ReceiveMeta = ShareMeta | (SignalMessage & { encryptedSize: number; iv: string; sha256: string; name: string; fields?: DocField[] });

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function deriveShareKeyBytes(token: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token.toUpperCase()));
  return new Uint8Array(digest.slice(0, 16));
}

function concatChunks(chunks: ArrayBuffer[]): ArrayBuffer {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

/**
 * Hybrid PDF sharing. The PDF is encrypted in the browser (AES-GCM) before
 * any transport; WebRTC is the preferred direct path and the server's
 * WebSocket relay -- which only ever sees ciphertext -- is the resilient
 * fallback when a network change breaks the peer connection.
 */
@Injectable({ providedIn: 'root' })
export class ShareService implements SharePort {
  private readonly store = inject(DocumentStore);
  private readonly api = inject(ApiService);
  private readonly settings = inject(SettingsService);
  private readonly documents = lazyInject(DOCUMENTS);
  private readonly signatures = lazyInject(SIGNATURES);
  private readonly exporter = lazyInject(EXPORT);

  // ---- UI state ----
  readonly modalOpen = signal(false);
  readonly role = signal<ShareRole | null>(null);
  readonly isReceiverView = signal(false);
  readonly step = signal<string>('prepare');
  readonly status = signal<{ message: string; type: ShareStatusType }>({ message: '', type: '' });
  readonly progress = signal<{ visible: boolean; text: string; percent: number }>({ visible: false, text: 'Preparing…', percent: 0 });
  readonly connectedUsers = signal(0);
  readonly link = signal('');
  readonly linkVisible = signal(false);
  readonly startVisible = signal(true);
  readonly copiedVisible = signal(false);

  // ---- Transport state ----
  private socket: WebSocket | null = null;
  private peers = new Map<string, RTCPeerConnection>();
  private channels = new Map<string, RTCDataChannel>();
  private sessionId: string | null = null;
  private encryptedData: ArrayBuffer | null = null;
  private meta: ShareMeta | null = null;
  private transferStarted = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private closedByUser = false;
  private webRtcTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private peerFailed = new Set<string>();
  private uploadInFlight = false;
  private receiveMeta: ReceiveMeta | null = null;
  private receiveChunks: ArrayBuffer[] = [];
  private receiveBytes = 0;
  private receiveRelayActive = false;
  private receiveUsingRelay = false;
  private receiveCompleted = false;
  private receiveKey: CryptoKey | null = null;
  private receiverId: string | null = null;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  /** The share key, read from the URL before the router can rewrite it. */
  private urlKey: string | null = null;

  // ---------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------

  private setStatus(message: string, type: ShareStatusType = ''): void {
    this.status.set({ message, type });
  }

  private setProgress(current: number, total: number, label: string): void {
    const percent = total ? Math.min(100, Math.round((current / total) * 100)) : 0;
    this.progress.set({ visible: true, text: label, percent });
  }

  private resetProgress(): void {
    this.progress.set({ visible: false, text: 'Preparing…', percent: 0 });
  }

  private showIdleProgress(label = 'Waiting for recipient…'): void {
    this.progress.set({ visible: true, text: label, percent: 0 });
  }

  /** The step list index the current step sits at (for is-active / is-done). */
  stepIndex(): number {
    const order: readonly { key: string }[] = this.role() === 'receiver' || this.isReceiverView() ? RECEIVER_STEPS : SENDER_STEPS;
    return order.findIndex((s) => s.key === this.step());
  }

  open(): void {
    this.modalOpen.set(true);
    if (!this.role()) {
      this.isReceiverView.set(false);
      this.startVisible.set(true);
      this.step.set('prepare');
      this.setStatus('', '');
    }
  }

  close(): void {
    this.modalOpen.set(false);
    if (this.role()) this.teardown();
  }

  async copyLink(input: HTMLInputElement | null): Promise<void> {
    const showCopied = () => {
      this.copiedVisible.set(true);
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => this.copiedVisible.set(false), 1800);
    };
    try {
      await navigator.clipboard.writeText(this.link());
      showCopied();
    } catch {
      input?.select();
      document.execCommand('copy');
      showCopied();
    }
  }

  /** The document changed under an active send -- the link would serve stale bytes. */
  resetForChangedDocument(): void {
    if (this.role() === 'sender') this.teardown('The document changed. Create a new share link for the new version.');
  }

  /** Captures `?k=` / `#k=` at startup, before any navigation can drop it. */
  captureUrlKey(): void {
    const params = new URLSearchParams(location.search);
    const queryKey = params.get('k') || params.get('key');
    if (queryKey) {
      this.urlKey = queryKey;
      return;
    }
    const hashParams = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash);
    this.urlKey = hashParams.get('k') || hashParams.get('key') || null;
  }

  private websocketUrl(): string {
    return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signal`;
  }

  private closePeer(peerId: string): void {
    const timer = this.webRtcTimers.get(peerId);
    if (timer) clearTimeout(timer);
    this.webRtcTimers.delete(peerId);
    try {
      this.channels.get(peerId)?.close();
    } catch {
      /* already closed */
    }
    this.channels.delete(peerId);
    try {
      this.peers.get(peerId)?.close();
    } catch {
      /* already closed */
    }
    this.peers.delete(peerId);
  }

  private teardown(statusMessage?: string): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const peerId of Array.from(this.peers.keys())) this.closePeer(peerId);
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = null;
    this.role.set(null);
    this.sessionId = null;
    this.encryptedData = null;
    this.meta = null;
    this.receiverId = null;
    this.transferStarted = false;
    this.reconnectAttempt = 0;
    this.uploadInFlight = false;
    this.peerFailed.clear();
    this.receiveMeta = null;
    this.receiveChunks = [];
    this.receiveBytes = 0;
    this.receiveUsingRelay = false;
    this.receiveRelayActive = false;
    this.receiveCompleted = false;
    this.receiveKey = null;
    this.startVisible.set(true);
    this.linkVisible.set(false);
    this.connectedUsers.set(0);
    this.resetProgress();
    this.step.set(this.isReceiverView() ? 'connecting' : 'prepare');
    if (statusMessage) this.setStatus(statusMessage, 'waiting');
  }

  // ---------------------------------------------------------------------
  // Encryption
  // ---------------------------------------------------------------------

  private async encryptFile(file: Blob & { name?: string }, keyBytes: Uint8Array): Promise<{ ciphertext: ArrayBuffer; meta: ShareMeta }> {
    const plaintext = await file.arrayBuffer();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return {
      ciphertext,
      meta: {
        sessionId: this.sessionId ?? '',
        name: file.name || 'shared-document.pdf',
        size: plaintext.byteLength,
        encryptedSize: ciphertext.byteLength,
        sha256: await sha256Hex(plaintext),
        iv: bytesToBase64Url(iv),
        fields: this.store.fields().map(({ name, type, required, readOnly, multiline, tooltip, page, rect }) => ({
          name,
          type,
          required,
          readOnly,
          multiline,
          tooltip,
          page,
          rect,
        })),
        algorithm: 'AES-GCM',
      },
    };
  }

  private async importReceiveKey(): Promise<void> {
    const rawKey = this.urlKey;
    if (!rawKey) throw new Error('This share link is missing its encryption key. Ask the sender for a new link.');
    const keyBytes = /^[A-Z0-9]{4,8}$/i.test(rawKey) ? await deriveShareKeyBytes(rawKey) : base64UrlToBytes(rawKey);
    this.receiveKey = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'AES-GCM' }, false, ['decrypt']);
  }

  // ---------------------------------------------------------------------
  // Signaling socket
  // ---------------------------------------------------------------------

  private async waitForSocketSpace(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount <= SHARE_HIGH_WATER_MARK) return;
    await new Promise<void>((resolve) => {
      const poll = () => {
        const s = this.socket;
        if (!s || s.readyState !== WebSocket.OPEN || s.bufferedAmount <= SHARE_LOW_WATER_MARK) return resolve();
        setTimeout(poll, 10);
      };
      poll();
    });
  }

  private connect(): void {
    if (this.closedByUser || !this.sessionId || !this.role()) return;
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;

    const socket = new WebSocket(this.websocketUrl());
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      socket.send(JSON.stringify({ type: 'join', sessionId: this.sessionId, role: this.role(), receiverId: this.receiverId }));
      this.setStatus(
        this.role() === 'sender' ? 'Waiting for someone to open your link…' : 'Connected. Looking for the sender…',
        'waiting',
      );
    };

    socket.onmessage = async (event: MessageEvent<string | ArrayBuffer | Blob>) => {
      if (typeof event.data !== 'string') return this.receiveRelayChunk(event.data);
      let message: SignalMessage;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      await this.handleMessage(message);
    };

    socket.onerror = () => {
      if (!this.closedByUser) this.setStatus('Reconnecting…', 'waiting');
    };

    socket.onclose = () => {
      this.socket = null;
      this.receiveRelayActive = false;
      if (this.closedByUser) return;
      // The relay resume happens once the reconnect gets a fresh 'joined'.
      this.scheduleReconnect();
    };
  }

  private async handleMessage(message: SignalMessage): Promise<void> {
    const role = this.role();
    if (message.type === 'joined') {
      if (role === 'receiver') {
        this.receiverId = message.receiverId || this.receiverId;
        if (message.fileReady) {
          this.receiveMeta = message.fileMeta ?? null;
          if (this.receiveUsingRelay || this.receiveBytes > 0) {
            // A relay transfer was under way before the socket dropped -- resume it.
            this.setStatus('Reconnected — resuming…', 'waiting');
            this.step.set('receiving');
            this.startRelayDownload(this.receiveBytes);
          } else {
            this.setStatus('Sender is ready. Connecting…', 'waiting');
            this.step.set('receiving');
            this.startReceiverFallbackTimer();
          }
        } else if (message.role === 'receiver') {
          this.setStatus('Waiting for the sender…', 'waiting');
          this.step.set('waiting');
        }
      } else {
        this.connectedUsers.set(message.receiverCount || 0);
        if (
          this.transferStarted &&
          this.encryptedData &&
          this.meta &&
          typeof message.relayReceivedBytes === 'number' &&
          message.relayReceivedBytes < this.encryptedData.byteLength
        ) {
          // The sender's socket reconnected mid-upload; resume where the server is.
          this.showIdleProgress('Reconnected — resuming…');
          this.continueRelayUpload(message.relayReceivedBytes);
        }
      }
      return;
    }

    if (message.type === 'file-upload-started' && role === 'sender') {
      await this.continueRelayUpload(Number(message.receivedBytes) || 0);
      return;
    }

    if (message.type === 'file-stored' && role === 'sender') {
      // Confirms relay buffering finished -- don't touch the transfer's progress.
      const count = message.receiverCount || 0;
      this.connectedUsers.set(count);
      this.setStatus(count > 0 ? `${count} connected — sending…` : 'Waiting for someone to open your link…', 'success');
      this.step.set(count > 0 ? 'sending' : 'waiting');
      return;
    }

    if (message.type === 'receiver-joined' && role === 'sender') {
      this.connectedUsers.set(message.receiverCount || 0);
      if (!this.transferStarted && this.encryptedData && this.meta && this.socket?.readyState === WebSocket.OPEN) {
        this.transferStarted = true;
        this.showIdleProgress('Preparing to send…');
        this.socket.send(JSON.stringify({ type: 'file-meta', ...this.meta }));
      }
      if (message.receiverId) this.createPeerForReceiver(message.receiverId);
      this.setStatus(`${message.receiverCount || 0} connected — sending…`, 'success');
      this.step.set('sending');
      return;
    }

    if (message.type === 'receiver-left' && role === 'sender') {
      if (message.receiverId) this.closePeer(message.receiverId);
      const count = message.receiverCount || 0;
      this.connectedUsers.set(count);
      this.setStatus(count > 0 ? `${count} connected — sending…` : 'Waiting for someone to open your link…', 'success');
      this.step.set(count > 0 ? 'sending' : 'waiting');
      return;
    }

    if (message.type === 'signal' && role === 'receiver') {
      await this.handleReceiverSignal(message.payload ?? {});
      return;
    }
    if (message.type === 'signal' && role === 'sender') {
      if (message.receiverId) await this.handleSenderSignal(message.receiverId, message.payload ?? {});
      return;
    }
    if (message.type === 'relay-meta' || message.type === 'relay-complete') {
      await this.receiveRelayControl(message);
      return;
    }
    if (message.type === 'relay-available' && role === 'receiver') {
      this.startRelayDownload(this.receiveBytes);
      return;
    }
    if (message.type === 'sender-left' && role === 'receiver') {
      this.setStatus('Sender disconnected — finishing up…', 'waiting');
      this.startRelayDownload(this.receiveBytes);
      return;
    }
    if (message.type === 'waiting-for-file') {
      this.setStatus('Waiting for the sender…', 'waiting');
      this.step.set('waiting');
      return;
    }
    if (message.type === 'expired') {
      this.setStatus(message.message || 'This share session has expired.', 'error');
      return;
    }
    if (message.type === 'error') {
      this.setStatus(message.message || 'Something went wrong.', 'error');
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = Math.min(WS_RECONNECT_MAX_MS, 500 * 2 ** Math.min(this.reconnectAttempt, 4));
    const jitter = Math.floor(Math.random() * 350);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempt += 1;
      this.connect();
    }, delay + jitter);
  }

  private sendSignal(targetReceiverId: string | undefined, payload: SignalPayload): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'signal', sessionId: this.sessionId, receiverId: targetReceiverId, payload }));
    }
  }

  // ---------------------------------------------------------------------
  // Relay (encrypted WebSocket fallback)
  // ---------------------------------------------------------------------

  private async continueRelayUpload(offset: number): Promise<void> {
    const data = this.encryptedData;
    if (this.role() !== 'sender' || !data || !this.meta || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    // 'file-upload-started' and a reconnect's resume must not interleave chunks.
    if (this.uploadInFlight) return;
    this.uploadInFlight = true;
    try {
      const safeOffset = Math.max(0, Math.min(offset, data.byteLength));
      this.setProgress(safeOffset, data.byteLength, 'Uploading…');
      for (let cursor = safeOffset; cursor < data.byteLength; cursor += SHARE_CHUNK_BYTES) {
        await this.waitForSocketSpace();
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        const end = Math.min(cursor + SHARE_CHUNK_BYTES, data.byteLength);
        this.socket.send(data.slice(cursor, end));
        this.setProgress(end, data.byteLength, 'Uploading…');
      }
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'file-complete', sessionId: this.sessionId }));
    } finally {
      this.uploadInFlight = false;
    }
  }

  private async receiveRelayControl(message: SignalMessage): Promise<void> {
    if (message.type === 'relay-meta') {
      const offset = Number(message.offset) || 0;
      if (offset === 0) this.receiveChunks = [];
      this.receiveMeta = message as ReceiveMeta;
      this.receiveBytes = offset;
      this.setProgress(this.receiveBytes, message.encryptedSize ?? 0, 'Receiving…');
      this.setStatus('Using a backup secure connection…', 'waiting');
      this.step.set('receiving');
      return;
    }
    if (message.type === 'relay-complete') {
      this.receiveRelayActive = false;
      await this.finishReceivedFile();
    }
  }

  private async receiveRelayChunk(data: ArrayBuffer | Blob): Promise<void> {
    if (!this.receiveMeta || this.receiveCompleted) return;
    const chunk = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
    this.receiveChunks.push(chunk);
    this.receiveBytes += chunk.byteLength;
    if (this.receiveBytes > this.receiveMeta.encryptedSize) {
      this.setStatus('Something went wrong with the transfer. Please try again.', 'error');
      return;
    }
    this.setProgress(this.receiveBytes, this.receiveMeta.encryptedSize, 'Receiving…');
  }

  private async finishReceivedFile(): Promise<void> {
    const meta = this.receiveMeta;
    if (!meta || this.receiveBytes !== meta.encryptedSize) {
      this.setStatus('Connection dropped — resuming…', 'waiting');
      this.startRelayDownload(this.receiveBytes);
      return;
    }
    try {
      let ciphertext: ArrayBuffer | null = concatChunks(this.receiveChunks);
      // The chunks and ciphertext are dead weight once decrypted -- don't keep
      // them resident while the document opens.
      this.receiveChunks = [];
      const iv = base64UrlToBytes(meta.iv);
      if (!this.receiveKey) throw new Error('Missing decryption key.');
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, this.receiveKey, ciphertext);
      ciphertext = null;
      if ((await sha256Hex(plaintext)) !== meta.sha256) throw new Error('Integrity check failed. The PDF was not opened.');
      this.receiveCompleted = true;
      this.setProgress(meta.encryptedSize, meta.encryptedSize, 'Done');
      this.setStatus('PDF received and opened.', 'success');
      this.step.set('done');
      await this.documents().processNewFile(new File([plaintext], meta.name, { type: 'application/pdf' }), {
        skipServerInfo: true,
        transferredFields: (meta.fields as DocField[] | undefined) ?? [],
      });
      history.replaceState({}, '', location.pathname);
    } catch (error) {
      const message = errorMessage(error);
      this.setStatus(message ? `Could not open the received PDF: ${message}` : 'Could not open the received PDF. Ask for a new link.', 'error');
    }
  }

  private startRelayDownload(offset = 0): void {
    if (this.role() !== 'receiver' || !this.socket || this.socket.readyState !== WebSocket.OPEN || this.receiveCompleted) return;
    // Several triggers can fire together; one download request at a time.
    if (this.receiveRelayActive && offset === this.receiveBytes) return;
    this.receiveRelayActive = true;
    this.receiveUsingRelay = true;
    this.socket.send(JSON.stringify({ type: 'download', sessionId: this.sessionId, offset }));
  }

  private startReceiverFallbackTimer(): void {
    setTimeout(() => {
      if (this.role() !== 'receiver' || this.receiveCompleted || this.receiveUsingRelay) return;
      if (!this.peers.size) this.startRelayDownload(this.receiveBytes);
    }, WEBRTC_CONNECT_TIMEOUT_MS);
  }

  // ---------------------------------------------------------------------
  // WebRTC
  // ---------------------------------------------------------------------

  private async iceServers(): Promise<RTCIceServer[]> {
    const response = await this.api.fetch('/api/share-config');
    const config = (await response.json()) as { iceServers?: RTCIceServer[] };
    return config.iceServers || [];
  }

  private async createPeerForReceiver(peerId: string): Promise<void> {
    if (this.role() !== 'sender' || !peerId || this.peers.has(peerId)) return;
    const peer = new RTCPeerConnection({ iceServers: await this.iceServers() });
    this.peers.set(peerId, peer);
    peer.onicecandidate = (event) => {
      if (event.candidate) this.sendSignal(peerId, { candidate: event.candidate.toJSON() });
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        const timer = this.webRtcTimers.get(peerId);
        if (timer) clearTimeout(timer);
        this.webRtcTimers.delete(peerId);
        this.setStatus('Connected directly to your recipient.', 'success');
      } else if (peer.connectionState === 'failed') {
        this.restartOrFallbackPeer(peerId);
      }
    };
    this.setupSenderChannel(peerId, peer.createDataChannel('pdf-seal-transfer', { ordered: true }));
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    this.sendSignal(peerId, { description: peer.localDescription?.toJSON() ?? null });
    this.webRtcTimers.set(peerId, setTimeout(() => this.restartOrFallbackPeer(peerId), WEBRTC_CONNECT_TIMEOUT_MS));
  }

  private setupSenderChannel(peerId: string, channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = SHARE_LOW_WATER_MARK;
    this.channels.set(peerId, channel);
    channel.onopen = async () => {
      const data = this.encryptedData;
      if (!data || !this.meta) return;
      this.setProgress(0, data.byteLength, 'Sending…');
      this.setStatus('Connected. Sending your PDF…', 'success');
      this.step.set('sending');
      channel.send(JSON.stringify({ type: 'file-meta', ...this.meta }));
      for (let offset = 0; offset < data.byteLength; offset += SHARE_CHUNK_BYTES) {
        await this.waitForChannelSpace(channel);
        if (channel.readyState !== 'open') return this.restartOrFallbackPeer(peerId);
        const end = Math.min(offset + SHARE_CHUNK_BYTES, data.byteLength);
        channel.send(data.slice(offset, end));
        this.setProgress(end, data.byteLength, 'Sending…');
      }
      if (channel.readyState === 'open') {
        channel.send(JSON.stringify({ type: 'file-complete' }));
        this.setProgress(data.byteLength, data.byteLength, 'Sent');
        this.setStatus('Your PDF was sent successfully.', 'success');
        this.step.set('done');
      }
    };
    channel.onerror = () => this.restartOrFallbackPeer(peerId);
    channel.onclose = () => {
      if (!this.receiveCompleted) this.restartOrFallbackPeer(peerId);
    };
  }

  private waitForChannelSpace(channel: RTCDataChannel): Promise<void> {
    if (channel.bufferedAmount <= SHARE_HIGH_WATER_MARK) return Promise.resolve();
    return new Promise((resolve) => {
      const onLow = () => {
        channel.removeEventListener('bufferedamountlow', onLow);
        resolve();
      };
      channel.addEventListener('bufferedamountlow', onLow);
    });
  }

  private async restartOrFallbackPeer(peerId: string): Promise<void> {
    if (this.peerFailed.has(peerId)) return;
    this.peerFailed.add(peerId);
    const peer = this.peers.get(peerId);
    if (!peer) return;
    try {
      peer.restartIce();
      const offer = await peer.createOffer({ iceRestart: true });
      await peer.setLocalDescription(offer);
      this.sendSignal(peerId, { description: peer.localDescription?.toJSON() ?? null });
      this.setStatus('Network changed — reconnecting…', 'waiting');
      setTimeout(() => {
        if (peer.connectionState !== 'connected') this.setStatus('Switched to a backup secure connection.', 'waiting');
        this.peerFailed.delete(peerId);
      }, ICE_RESTART_DELAY_MS);
    } catch {
      this.setStatus('Switched to a backup secure connection.', 'waiting');
    }
  }

  private async handleSenderSignal(peerId: string, payload: SignalPayload): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    try {
      if (payload.description) {
        await peer.setRemoteDescription(payload.description);
        if (payload.description.type === 'answer') return;
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        this.sendSignal(peerId, { description: peer.localDescription?.toJSON() ?? null });
      } else if (payload.candidate) {
        await peer.addIceCandidate(payload.candidate);
      }
    } catch {
      this.restartOrFallbackPeer(peerId);
    }
  }

  private async createReceiverPeer(): Promise<void> {
    const peer = new RTCPeerConnection({ iceServers: await this.iceServers() });
    this.peers.set('sender', peer);
    peer.onicecandidate = (event) => {
      if (event.candidate) this.sendSignal(undefined, { candidate: event.candidate.toJSON() });
    };
    peer.ondatachannel = (event) => this.setupReceiverChannel(event.channel);
    peer.onconnectionstatechange = () => {
      if (['failed', 'disconnected'].includes(peer.connectionState) && !this.receiveCompleted) {
        try {
          peer.restartIce();
        } catch {
          /* not supported */
        }
        this.setStatus('Network changed — reconnecting…', 'waiting');
        setTimeout(() => {
          if (peer.connectionState !== 'connected' && !this.receiveCompleted) this.startRelayDownload(this.receiveBytes);
        }, ICE_RESTART_DELAY_MS);
      }
    };
  }

  private async handleReceiverSignal(payload: SignalPayload): Promise<void> {
    if (!this.peers.has('sender')) await this.createReceiverPeer();
    const peer = this.peers.get('sender');
    if (!peer) return;
    try {
      if (payload.description) {
        await peer.setRemoteDescription(payload.description);
        if (payload.description.type === 'offer') {
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          this.sendSignal(undefined, { description: peer.localDescription?.toJSON() ?? null });
        }
      } else if (payload.candidate) {
        await peer.addIceCandidate(payload.candidate);
      }
    } catch {
      this.startRelayDownload(this.receiveBytes);
    }
  }

  private setupReceiverChannel(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      if (this.receiveBytes > 0 || this.receiveUsingRelay || this.receiveCompleted) {
        try {
          channel.close();
        } catch {
          /* already closed */
        }
        if (!this.receiveCompleted) this.startRelayDownload(this.receiveBytes);
        return;
      }
      this.receiveUsingRelay = false;
      this.setStatus('Connected directly to the sender.', 'success');
      this.step.set('receiving');
    };
    channel.onmessage = async (event: MessageEvent<string | ArrayBuffer>) => {
      if (this.receiveUsingRelay || this.receiveCompleted) return;
      if (typeof event.data === 'string') {
        let message: ShareMeta & { type: string };
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'file-meta') {
          if (this.receiveBytes > 0 || this.receiveUsingRelay || this.receiveCompleted) return;
          this.receiveMeta = message;
          this.receiveChunks = [];
          this.receiveBytes = 0;
          this.setProgress(0, message.encryptedSize, 'Receiving…');
        } else if (message.type === 'file-complete') {
          await this.finishReceivedFile();
        }
        return;
      }
      await this.receiveRelayChunk(event.data);
    };
    channel.onerror = () => this.startRelayDownload(this.receiveBytes);
    channel.onclose = () => {
      if (!this.receiveCompleted) this.startRelayDownload(this.receiveBytes);
    };
  }

  // ---------------------------------------------------------------------
  // Entry points
  // ---------------------------------------------------------------------

  async startSending(): Promise<void> {
    const activeFile = this.store.activeFile();
    if (!activeFile || !crypto.subtle || !('RTCPeerConnection' in window)) {
      this.setStatus('Your browser doesn’t support secure sharing. Try Chrome, Firefox, or Edge.', 'error');
      return;
    }
    await this.documents().ensureRevisionHydration();
    // Staged edits live only in the working fields until applied.
    if (this.signatures().pendingCount()) {
      this.setStatus('Applying unsaved field changes…', 'waiting');
      if (!(await this.signatures().applyPending())) {
        this.setStatus('Could not apply pending field changes. Fix them and try again.', 'error');
        return;
      }
    }
    this.showIdleProgress();
    this.closedByUser = false;
    this.role.set('sender');
    this.sessionId = createSessionId();
    this.transferStarted = false;
    this.step.set('prepare');
    try {
      let fileToShare: Blob & { name?: string } = this.store.activeFile() ?? activeFile;
      if (this.settings.stored().includeRevisionHistoryByDefault) {
        this.setStatus('Bundling revision history…', 'waiting');
        const bundled = await this.exporter().bundleRevisionHistoryPdf((loaded, total) => {
          this.setProgress(loaded, total, 'Bundling revision history…');
        });
        fileToShare = Object.assign(bundled, { name: fileToShare.name });
        // That progress only tracked the bundling upload -- reset it.
        this.showIdleProgress('Waiting for the recipient to connect…');
      }
      this.setStatus('Encrypting your PDF…', 'waiting');
      const shareToken = createCompactShareToken();
      const keyBytes = await deriveShareKeyBytes(shareToken);
      const encrypted = await this.encryptFile(fileToShare, keyBytes);
      this.encryptedData = encrypted.ciphertext;
      this.meta = encrypted.meta;
      this.startVisible.set(false);
      this.linkVisible.set(true);
      this.link.set(`${location.origin}/share/${this.sessionId}?k=${shareToken}`);
      this.setStatus('Link ready. Share it with your recipient.', 'waiting');
      this.step.set('waiting');
      this.connect();
    } catch (error) {
      this.setStatus(errorMessage(error) || 'Could not prepare secure sharing.', 'error');
    }
  }

  async startReceiving(sessionId: string): Promise<void> {
    this.closedByUser = false;
    this.role.set('receiver');
    this.sessionId = sessionId;
    this.resetProgress();
    this.isReceiverView.set(true);
    this.startVisible.set(false);
    this.step.set('connecting');
    this.modalOpen.set(true);
    try {
      await this.importReceiveKey();
      this.setStatus('Connecting…', 'waiting');
      this.connect();
    } catch (error) {
      this.setStatus(errorMessage(error) || 'This share link is invalid.', 'error');
    }
  }
}
