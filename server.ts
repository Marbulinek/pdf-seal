"use strict";

import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";
import multer, { MulterError } from "multer";
import path from "path";
import fs from "fs";
import { WebSocket, WebSocketServer } from "ws";
import PdfSignatureTool from "./lib/PdfSignatureTool";

const app = express();
const PORT = process.env.PORT || 3000;
const SHARE_SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,32}$/;

type ShareRole = "sender" | "receiver";

// Set up Multer for handling file uploads (saves temporarily to an 'uploads' folder).
// A file-size cap keeps a single (or a burst of concurrent) uploads from blowing up
// process memory, since PdfSignatureTool.open() reads the whole file into a Buffer.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB
const upload = multer({ dest: "uploads/", limits: { fileSize: MAX_UPLOAD_BYTES } });

// Serve static files from the 'public' directory
app.use(express.static("public"));
app.use(express.json());

app.get("/share/:sessionId", (req: Request, res: Response) => {
  const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
  if (!SESSION_ID_PATTERN.test(sessionId)) return res.status(404).send("Share session not found.");
  res.sendFile(path.resolve("public/index.html"));
});

// Ensure the uploads directory exists
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

/**
 * Best-effort delete of one or more temp files. Never throws -- cleanup must
 * not be able to mask the real error (or, worse, crash an uncaught-exception
 * path like the res.download() callback).
 */
function cleanupFiles(...paths: Array<string | null | undefined>) {
  for (const p of paths) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (cleanupErr) {
      logError("cleanup-files", cleanupErr, { path: p });
    }
  }
}

function logShare(event: string, details?: Record<string, unknown>) {
  console.log(`[share] ${event}`, details ?? {});
}

function logError(context: string, error: unknown, details?: Record<string, unknown>) {
  console.error(`[error] ${context}`, details ?? {}, error);
}

// --- API Endpoint: Get PDF Info ---
app.post("/api/info", upload.single("pdfDocument"), async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  try {
    const tool = await PdfSignatureTool.open(file.path);
    const result = {
      metadata: tool.getMetadata(),
      fields: tool.listFields(),
    };

    res.json(result);
  } catch (error: any) {
    logError("api-info", error, { filePath: file.path });
    res.status(500).json({ error: error?.message ?? "Unexpected error" });
  } finally {
    cleanupFiles(file.path);
  }
});

// --- API Endpoint: Add Signature Field ---
app.post(
  "/api/add-signature",
  upload.single("pdfDocument"),
  async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    let outputPath: string | null = null;

    try {
      const tool = await PdfSignatureTool.open(file.path);

      // Parse incoming form data
      const page = parseInt(req.body.page, 10) || 0;
      const name = req.body.name || `SigField_${Date.now()}`;
      const x = parseFloat(req.body.x) || 50;
      const y = parseFloat(req.body.y) || 50;
      const width = parseFloat(req.body.width) || 200;
      const height = parseFloat(req.body.height) || 60;
      const required = req.body.required === "true";

      tool.addSignatureField(page, name, { x, y, width, height, required });

      outputPath = path.join("uploads", `modified_${Date.now()}.pdf`);
      await tool.save(outputPath);

      // Send the modified file back to the client, then clean up both temp files
      // regardless of whether the download itself succeeded.
      res.download(outputPath, "signed-document.pdf", () => {
        cleanupFiles(file.path, outputPath);
      });
    } catch (error: any) {
      logError("api-add-signature", error, { filePath: file.path });
      cleanupFiles(file.path, outputPath);
      res.status(500).json({ error: error?.message ?? "Unexpected error" });
    }
  },
);

// --- API Endpoint: Edit Existing Field ---
app.post("/api/edit-field", upload.single("pdfDocument"), async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  let outputPath: string | null = null;

  try {
    const tool = await PdfSignatureTool.open(file.path);

    const originalName = req.body.originalName || req.body.name;
    const newName = req.body.name || originalName;
    const x = parseFloat(req.body.x);
    const y = parseFloat(req.body.y);
    const width = parseFloat(req.body.width);
    const height = parseFloat(req.body.height);
    const required = String(req.body.required).toLowerCase() === "true";

    if (!originalName) {
      throw new Error("Field name is required.");
    }

    if (originalName !== newName) {
      tool.renameField(originalName, newName);
    }

    if ([x, y, width, height].every((value) => Number.isFinite(value))) {
      tool.setFieldRect(newName, { x, y, width, height });
    }

    tool.setFieldRequired(newName, required);

    outputPath = path.join("uploads", `modified_${Date.now()}.pdf`);
    await tool.save(outputPath);

    res.download(outputPath, "signed-document.pdf", () => {
      cleanupFiles(file.path, outputPath);
    });
  } catch (error: any) {
    logError("api-edit-field", error, { filePath: file.path });
    cleanupFiles(file.path, outputPath);
    res.status(500).json({ error: error?.message ?? "Unexpected error" });
  }
});

// --- API Endpoint: Remove Existing Field ---
app.post("/api/remove-field", upload.single("pdfDocument"), async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  let outputPath: string | null = null;

  try {
    const tool = await PdfSignatureTool.open(file.path);
    const name = req.body.name || req.body.originalName;

    if (!name) {
      throw new Error("Field name is required.");
    }

    tool.removeField(name);

    outputPath = path.join("uploads", `modified_${Date.now()}.pdf`);
    await tool.save(outputPath);

    res.download(outputPath, "signed-document.pdf", () => {
      cleanupFiles(file.path, outputPath);
    });
  } catch (error: any) {
    logError("api-remove-field", error, { filePath: file.path });
    cleanupFiles(file.path, outputPath);
    res.status(500).json({ error: error?.message ?? "Unexpected error" });
  }
});

// Multer errors (e.g. file too large) land here instead of inside the route handlers.
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: `File too large. Maximum upload size is ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB.`,
      });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    logError("request-handler", err, { method: req.method, path: req.path });
    return res.status(500).json({ error: "Unexpected error" });
  }
  next();
});

const server = http.createServer(app);

const MAX_SHARE_BYTES = 25 * 1024 * 1024;
const SHARE_CHUNK_BYTES = 64 * 1024;
const WS_HIGH_WATER_MARK = 512 * 1024;
const SHARE_MAX_SESSIONS_MEMORY_BYTES = 200 * 1024 * 1024;
let shareMemoryBytes = 0;

function configuredStunUrls(): string[] {
  const configured = process.env.WEBRTC_STUN_URLS
    ?.split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  return configured?.length ? configured : ['stun:stun.l.google.com:19302'];
}

interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

function configuredTurnServers(): IceServerConfig[] {
  const urls = process.env.WEBRTC_TURN_URLS
    ?.split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  if (!urls?.length) return [];
  const username = process.env.WEBRTC_TURN_USERNAME;
  const credential = process.env.WEBRTC_TURN_CREDENTIAL;
  if (!username || !credential) {
    logError('turn-config', undefined, { reason: 'WEBRTC_TURN_URLS set without username/credential' });
    return [];
  }
  return [{ urls, username, credential }];
}

app.get('/api/share-config', (_req: Request, res: Response) => {
  const iceServers: IceServerConfig[] = [
    { urls: configuredStunUrls() },
    ...configuredTurnServers(),
  ];
  res.json({ iceServers, stunUrls: configuredStunUrls(), sessionTtlSeconds: SHARE_SESSION_TTL_MS / 1000 });
});

const shareWebSocketServer = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

interface ShareMeta {
  sessionId: string;
  name: string;
  size: number;
  encryptedSize: number;
  sha256: string;
  iv: string;
  fields: unknown[];
  algorithm: 'AES-GCM';
}

interface ShareFile {
  meta: ShareMeta;
  data: Buffer;
  receivedBytes: number;
}

interface ShareSession {
  createdAt: number;
  sender: WebSocket | null;
  receivers: Map<string, WebSocket>;
  file: ShareFile | null;
  senderUploadComplete: boolean;
}

interface SocketMembership {
  sessionId: string;
  role: ShareRole;
  receiverId?: string;
}

const shareSessions = new Map<string, ShareSession>();
const socketSessions = new Map<WebSocket, SocketMembership>();
const receiverIds = new WeakMap<WebSocket, string>();
let nextReceiverId = 1;

function sendJson(socket: WebSocket, message: Record<string, unknown>) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function nextReceiverIdFor(socket: WebSocket): string {
  const existing = receiverIds.get(socket);
  if (existing) return existing;
  const id = `r${Date.now().toString(36)}-${(nextReceiverId++).toString(36)}`;
  receiverIds.set(socket, id);
  return id;
}

function addShareMemory(bytes: number): boolean {
  if (shareMemoryBytes + bytes > SHARE_MAX_SESSIONS_MEMORY_BYTES) return false;
  shareMemoryBytes += bytes;
  return true;
}

function releaseShareFile(file: ShareFile | null) {
  if (!file) return;
  shareMemoryBytes = Math.max(0, shareMemoryBytes - file.data.length);
}

async function waitForSocketCapacity(socket: WebSocket) {
  while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > WS_HIGH_WATER_MARK) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function sendRelayFile(session: ShareSession, socket: WebSocket, offset = 0) {
  const file = session.file;
  if (!file || socket.readyState !== WebSocket.OPEN) return;
  const start = Math.max(0, Math.min(offset, file.data.length));
  sendJson(socket, { type: 'relay-meta', ...file.meta, offset: start });

  for (let cursor = start; cursor < file.data.length; cursor += SHARE_CHUNK_BYTES) {
    if (socket.readyState !== WebSocket.OPEN) return;
    await waitForSocketCapacity(socket);
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(file.data.subarray(cursor, Math.min(cursor + SHARE_CHUNK_BYTES, file.data.length)));
  }
  sendJson(socket, { type: 'relay-complete' });
  logShare('relay-delivered', { sessionId: file.meta.sessionId, receiverOffset: start, encryptedBytes: file.data.length });
}

function createShareSession(sessionId: string): ShareSession {
  const session: ShareSession = {
    createdAt: Date.now(),
    sender: null,
    receivers: new Map(),
    file: null,
    senderUploadComplete: false,
  };
  shareSessions.set(sessionId, session);
  logShare('session-created', { sessionId });
  return session;
}

function cleanupSocket(socket: WebSocket) {
  const membership = socketSessions.get(socket);
  if (!membership) return;
  socketSessions.delete(socket);

  const session = shareSessions.get(membership.sessionId);
  if (!session) return;

  if (membership.role === 'sender' && session.sender === socket) {
    session.sender = null;
    logShare('sender-left', { sessionId: membership.sessionId });
    if (!session.file || !session.senderUploadComplete) {
      for (const receiver of session.receivers.values()) {
        sendJson(receiver, {
          type: 'sender-left',
          message: 'The sender disconnected before the encrypted PDF was fully uploaded.',
        });
      }
    }
  } else if (membership.receiverId) {
    session.receivers.delete(membership.receiverId);
  }

  if (!session.sender && session.receivers.size === 0 && !session.file) {
    shareSessions.delete(membership.sessionId);
    logShare('session-removed', { sessionId: membership.sessionId });
  }
}

shareWebSocketServer.on('connection', (socket) => {
  socket.on('message', async (raw, isBinary) => {
    const membership = socketSessions.get(socket);

    if (isBinary) {
      if (!membership || membership.role !== 'sender') {
        return sendJson(socket, { type: 'error', code: 'not-sender', message: 'Only the sender can upload encrypted PDF data.' });
      }
      const session = shareSessions.get(membership.sessionId);
      if (!session?.file || session.sender !== socket || session.senderUploadComplete) {
        return sendJson(socket, { type: 'error', code: 'file-not-expected', message: 'Send encrypted file metadata before sending data.' });
      }
      const chunk = Buffer.from(raw as Buffer);
      const nextSize = session.file.receivedBytes + chunk.length;
      if (nextSize > session.file.meta.encryptedSize) {
        return sendJson(socket, { type: 'error', code: 'file-too-large', message: 'The encrypted PDF exceeds the allowed share size.' });
      }
      chunk.copy(session.file.data, session.file.receivedBytes);
      session.file.receivedBytes = nextSize;
      return;
    }

    let message: any;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      logError('share-parse', error);
      return sendJson(socket, { type: 'error', code: 'invalid-message', message: 'Invalid share message.' });
    }

    if (!message || !SESSION_ID_PATTERN.test(message.sessionId)) {
      return sendJson(socket, { type: 'error', code: 'invalid-session', message: 'Invalid share session.' });
    }

    if (message.type === 'join') {
      if (message.role !== 'sender' && message.role !== 'receiver') {
        return sendJson(socket, { type: 'error', code: 'invalid-role', message: 'Invalid share role.' });
      }

      let session = shareSessions.get(message.sessionId);
      if (!session && message.role === 'sender') session = createShareSession(message.sessionId);
      if (!session) {
        return sendJson(socket, { type: 'error', code: 'not-found', message: 'This share link has expired or is unavailable.' });
      }

      if (message.role === 'sender') {
        if (session.sender && session.sender !== socket) {
          return sendJson(socket, { type: 'error', code: 'sender-taken', message: 'This share is already owned by another sender.' });
        }
        session.sender = socket;
        socketSessions.set(socket, { sessionId: message.sessionId, role: 'sender' });
      } else {
        const receiverId = typeof message.receiverId === 'string' && message.receiverId.length <= 64
          ? message.receiverId
          : nextReceiverIdFor(socket);
        const previousSocket = session.receivers.get(receiverId);
        if (previousSocket && previousSocket !== socket) {
          socketSessions.delete(previousSocket);
          try { previousSocket.close(1000, 'Receiver reconnected'); } catch (_) {}
        }
        session.receivers.set(receiverId, socket);
        socketSessions.set(socket, { sessionId: message.sessionId, role: 'receiver', receiverId });
      }

      const receiverId = socketSessions.get(socket)?.receiverId;
      sendJson(socket, {
        type: 'joined',
        role: message.role,
        receiverId,
        fileReady: Boolean(session.file && session.senderUploadComplete),
        relayReceivedBytes: message.role === 'sender' ? session.file?.receivedBytes ?? 0 : 0,
        fileMeta: session.file?.meta ?? null,
      });

      if (message.role === 'receiver') {
        if (session.sender) {
          sendJson(session.sender, {
            type: 'receiver-joined',
            receiverId,
            receiverCount: session.receivers.size,
          });
        } else if (session.file && session.senderUploadComplete) {
          sendJson(socket, { type: 'relay-available' });
        } else {
          sendJson(socket, { type: 'waiting-for-sender' });
        }
      }
      return;
    }

    if (!membership || membership.sessionId !== message.sessionId) {
      return sendJson(socket, { type: 'error', code: 'not-joined', message: 'Join the share session first.' });
    }

    const session = shareSessions.get(message.sessionId);
    if (!session) return sendJson(socket, { type: 'error', code: 'session-unavailable', message: 'Share session is unavailable.' });

    if (message.type === 'file-meta' && membership.role === 'sender') {
      if (typeof message.name !== 'string' || typeof message.sha256 !== 'string' || !Array.isArray(message.fields)) {
        return sendJson(socket, { type: 'error', code: 'invalid-file-meta', message: 'Invalid encrypted PDF metadata.' });
      }
      if (message.algorithm !== 'AES-GCM' || typeof message.iv !== 'string') {
        return sendJson(socket, { type: 'error', code: 'invalid-file-meta', message: 'Unsupported encryption metadata.' });
      }
      if (!Number.isInteger(message.encryptedSize) || message.encryptedSize <= 0 || message.encryptedSize > MAX_SHARE_BYTES + 32) {
        return sendJson(socket, { type: 'error', code: 'invalid-file-meta', message: 'Invalid encrypted PDF size.' });
      }

      if (session.file) {
        const sameFile = session.file.meta.encryptedSize === message.encryptedSize
          && session.file.meta.sha256 === message.sha256
          && session.file.meta.iv === message.iv;
        if (!sameFile) return sendJson(socket, { type: 'error', code: 'file-already-exists', message: 'A different PDF is already stored for this share link.' });
        session.senderUploadComplete = session.file.receivedBytes === session.file.meta.encryptedSize;
        return sendJson(socket, { type: 'file-upload-started', size: session.file.meta.encryptedSize, receivedBytes: session.file.receivedBytes });
      }

      if (!addShareMemory(message.encryptedSize)) {
        return sendJson(socket, { type: 'server-busy', message: 'Temporary sharing storage is currently full. Please try again later.' });
      }

      session.file = {
        meta: {
          sessionId: message.sessionId,
          name: message.name.slice(0, 255),
          size: message.size,
          encryptedSize: message.encryptedSize,
          sha256: message.sha256,
          iv: message.iv,
          fields: message.fields,
          algorithm: 'AES-GCM',
        },
        data: Buffer.alloc(message.encryptedSize),
        receivedBytes: 0,
      };
      session.senderUploadComplete = false;
      sendJson(socket, { type: 'file-upload-started', size: message.encryptedSize, receivedBytes: 0 });
      return;
    }

    if (message.type === 'file-complete' && membership.role === 'sender') {
      if (!session.file || session.file.receivedBytes !== session.file.meta.encryptedSize) {
        return sendJson(socket, { type: 'error', code: 'incomplete-file', message: 'The encrypted PDF upload is incomplete.' });
      }
      session.senderUploadComplete = true;
      sendJson(socket, { type: 'file-stored', size: session.file.meta.encryptedSize, receiverCount: session.receivers.size });
      logShare('encrypted-file-stored', { sessionId: message.sessionId, encryptedBytes: session.file.meta.encryptedSize });
      return;
    }

    if (message.type === 'download' && membership.role === 'receiver') {
      if (!session.file || !session.senderUploadComplete) {
        return sendJson(socket, { type: 'waiting-for-file', message: 'The encrypted PDF is not ready yet.' });
      }
      const offset = Number.isInteger(message.offset) ? message.offset : 0;
      if (offset < 0 || offset > session.file.meta.encryptedSize) {
        return sendJson(socket, { type: 'error', code: 'invalid-offset', message: 'Invalid resume offset.' });
      }
      void sendRelayFile(session, socket, offset).catch((error) => {
        logError('share-delivery', error, { sessionId: message.sessionId });
        sendJson(socket, { type: 'error', code: 'delivery-failed', message: 'Could not deliver the encrypted PDF.' });
      });
      return;
    }

    if (message.type === 'signal' && membership.role === 'receiver') {
      if (!membership.receiverId || !session.sender) return sendJson(socket, { type: 'error', code: 'peer-unavailable', message: 'The sender is not connected.' });
      sendJson(session.sender, { type: 'signal', receiverId: membership.receiverId, payload: message.payload });
      return;
    }

    if (message.type === 'signal' && membership.role === 'sender') {
      if (typeof message.receiverId !== 'string') return sendJson(socket, { type: 'error', code: 'invalid-receiver', message: 'Receiver id is required.' });
      const receiver = session.receivers.get(message.receiverId);
      if (!receiver) return sendJson(socket, { type: 'error', code: 'peer-unavailable', message: 'Receiver is no longer connected.' });
      sendJson(receiver, { type: 'signal', payload: message.payload });
      return;
    }

    sendJson(socket, { type: 'error', code: 'unsupported-message', message: 'Unsupported share message.' });
  });

  socket.on('close', () => cleanupSocket(socket));
  socket.on('error', (error) => {
    logError('share-socket-error', error);
    cleanupSocket(socket);
  });
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname !== '/signal') return socket.destroy();
  shareWebSocketServer.handleUpgrade(request, socket, head, (webSocket) =>
    shareWebSocketServer.emit('connection', webSocket, request),
  );
});

const sessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of shareSessions) {
    if (now - session.createdAt >= SHARE_SESSION_TTL_MS) {
      logShare('session-expired', { sessionId });
      for (const peer of [session.sender, ...session.receivers.values()]) {
        if (peer) sendJson(peer, { type: 'expired', message: 'This 15-minute share session has expired.' });
        peer?.close(1000, 'Share session expired');
        if (peer) socketSessions.delete(peer);
      }
      releaseShareFile(session.file);
      session.receivers.clear();
      session.sender = null;
      shareSessions.delete(sessionId);
    }
  }
}, 60_000);
sessionCleanup.unref();

server.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
  console.log({ maxShareBytes: MAX_SHARE_BYTES, maxShareSessionsMemoryBytes: SHARE_MAX_SESSIONS_MEMORY_BYTES });
});