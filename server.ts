"use strict";

import express, { type Request, type Response, type NextFunction } from "express";
import http from "node:http";
import multer, { MulterError } from "multer";
import path from "node:path";
import fs from "node:fs";
import { WebSocket, WebSocketServer } from "ws";
import PdfSignatureTool from "./lib/PdfSignatureTool";

const app = express();
const PORT = process.env.PORT || 3000;
const SHARE_SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,32}$/;
const PROJECT_ROOT = process.cwd();
const PUBLIC_DIR = path.resolve(PROJECT_ROOT, "public");
const UPLOADS_DIR = path.resolve(PROJECT_ROOT, "uploads");
const API_RATE_LIMIT_WINDOW_MS = 60_000;
const API_RATE_LIMIT_MAX_REQUESTS = 60;
const rateLimitState = new Map<string, { count: number; resetAt: number }>();

type ShareRole = "sender" | "receiver";
type SignalingMessage =
  | { type: "join"; sessionId: string; role: ShareRole }
  | { type: "signal"; sessionId: string; payload: Record<string, unknown> };

interface ShareSession {
  createdAt: number;
  peers: Partial<Record<ShareRole, WebSocket>>;
}

// This map deliberately contains connection metadata only. PDF bytes are never
// accepted, buffered, or persisted by the signaling server.
const shareSessions = new Map<string, ShareSession>();

// Set up Multer for handling file uploads (saves temporarily to an 'uploads' folder).
// A file-size cap keeps a single (or a burst of concurrent) uploads from blowing up
// process memory, since PdfSignatureTool.open() reads the whole file into a Buffer.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB
const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: MAX_UPLOAD_BYTES } });

// Serve static files from the 'public' directory
app.use(express.static(PUBLIC_DIR));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: false }));

function configuredStunUrls(): string[] {
  const configured = process.env.WEBRTC_STUN_URLS
    ?.split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  return configured?.length ? configured : ["stun:stun.l.google.com:19302"];
}

function resolveSafePath(candidatePath: string): string {
  const resolved = path.resolve(candidatePath);
  const relative = path.relative(UPLOADS_DIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid upload path.");
  }
  return resolved;
}

function isWebRtcSignalPayload(payload: unknown): payload is Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  if (value.description && typeof value.description === "object") {
    const description = value.description as Record<string, unknown>;
    return (description.type === "offer" || description.type === "answer")
      && typeof description.sdp === "string"
      && description.sdp.length <= 48_000;
  }
  if (value.candidate && typeof value.candidate === "object") {
    const candidate = value.candidate as Record<string, unknown>;
    return typeof candidate.candidate === "string" && candidate.candidate.length <= 2_048;
  }
  return false;
}

app.get("/api/share-config", (_req: Request, res: Response) => {
  res.json({ stunUrls: configuredStunUrls(), sessionTtlSeconds: SHARE_SESSION_TTL_MS / 1000 });
});

function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const clientKey = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const existing = rateLimitState.get(clientKey);

  if (existing && existing.resetAt > now) {
    if (existing.count >= API_RATE_LIMIT_MAX_REQUESTS) {
      return res.status(429).json({ error: "Too many requests. Please try again shortly." });
    }
    existing.count += 1;
    return next();
  }

  rateLimitState.set(clientKey, { count: 1, resetAt: now + API_RATE_LIMIT_WINDOW_MS });
  return next();
}

// A shared link is still the same client application; the browser starts the
// receiver flow after it reads the session id from the location.
app.get("/share/:sessionId", (req: Request, res: Response) => {
  const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
  if (!SESSION_ID_PATTERN.test(sessionId)) return res.status(404).send("Share session not found.");
  res.sendFile(path.resolve(PUBLIC_DIR, "index.html"));
});

// Ensure the uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
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
      const safePath = resolveSafePath(p);
      if (fs.existsSync(safePath)) fs.unlinkSync(safePath);
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

type UploadedPdfActionResult =
  | { kind: "json"; payload: unknown }
  | { kind: "download"; outputPath: string };

function createDownloadResult(): UploadedPdfActionResult {
  return {
    kind: "download",
    outputPath: path.resolve(UPLOADS_DIR, `modified_${Date.now()}.pdf`),
  };
}

async function withUploadedPdf(
  req: Request,
  res: Response,
  context: string,
  action: (tool: PdfSignatureTool) => Promise<UploadedPdfActionResult>,
) {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  let outputPath: string | null = null;

  try {
    const safeFilePath = resolveSafePath(file.path);
    const tool = await PdfSignatureTool.open(safeFilePath);
    const result = await action(tool);

    if (result.kind === "download") {
      outputPath = result.outputPath;
      await tool.save(outputPath);
      res.download(outputPath, "signed-document.pdf", () => {
        cleanupFiles(file.path, outputPath);
      });
      return;
    }

    res.json(result.payload);
    cleanupFiles(file.path);
  } catch (error: unknown) {
    logError(context, error, { filePath: file.path });
    cleanupFiles(file.path, outputPath);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unexpected error" });
  }
}

// --- API Endpoint: Get PDF Info ---
app.post("/api/info", rateLimitMiddleware, upload.single("pdfDocument"), async (req: Request, res: Response) => {
  return withUploadedPdf(req, res, "api-info", async (tool) => ({
    kind: "json",
    payload: {
      metadata: tool.getMetadata(),
      fields: tool.listFields(),
    },
  }));
});

// --- API Endpoint: Add Signature Field ---
app.post("/api/add-signature", rateLimitMiddleware, upload.single("pdfDocument"), async (req: Request, res: Response) => {
  return withUploadedPdf(req, res, "api-add-signature", async (tool) => {
    const page = Number.parseInt(req.body.page, 10) || 0;
    const name = req.body.name || `SigField_${Date.now()}`;
    const x = Number.parseFloat(req.body.x) || 50;
    const y = Number.parseFloat(req.body.y) || 50;
    const width = Number.parseFloat(req.body.width) || 200;
    const height = Number.parseFloat(req.body.height) || 60;
    const required = req.body.required === "true";

    tool.addSignatureField(page, name, { x, y, width, height, required });

    return createDownloadResult();
  });
});

// --- API Endpoint: Edit Existing Field ---
app.post("/api/edit-field", rateLimitMiddleware, upload.single("pdfDocument"), async (req: Request, res: Response) => {
  return withUploadedPdf(req, res, "api-edit-field", async (tool) => {
    const originalName = req.body.originalName || req.body.name;
    const newName = req.body.name || originalName;
    const x = Number.parseFloat(req.body.x);
    const y = Number.parseFloat(req.body.y);
    const width = Number.parseFloat(req.body.width);
    const height = Number.parseFloat(req.body.height);
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

    return createDownloadResult();
  });
});

// --- API Endpoint: Remove Existing Field ---
app.post("/api/remove-field", rateLimitMiddleware, upload.single("pdfDocument"), async (req: Request, res: Response) => {
  return withUploadedPdf(req, res, "api-remove-field", async (tool) => {
    const name = req.body.name || req.body.originalName;

    if (!name) {
      throw new Error("Field name is required.");
    }

    tool.removeField(name);

    return createDownloadResult();
  });
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
const signalingServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

function send(socket: WebSocket, message: Record<string, unknown>) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function removePeer(socket: WebSocket) {
  for (const [sessionId, session] of shareSessions) {
    for (const role of ["sender", "receiver"] as const) {
      if (session.peers[role] === socket) {
        delete session.peers[role];
        const otherRole: ShareRole = role === "sender" ? "receiver" : "sender";
        const other = session.peers[otherRole];
        if (other) {
          send(other, { type: "peer-left" });
          logShare("peer-left", { sessionId, role, otherRole });
        }
        if (!session.peers.sender && !session.peers.receiver) {
          shareSessions.delete(sessionId);
          logShare("session-removed", { sessionId });
        }
        return;
      }
    }
  }
}

signalingServer.on("connection", (socket) => {
  let joinedSessionId: string | null = null;
  let joinedRole: ShareRole | null = null;
  logShare("ws-connected");

  socket.on("message", (raw) => {
    let message: SignalingMessage;
    try {
      message = JSON.parse(raw.toString()) as SignalingMessage;
    } catch (error) {
      logError("signaling-parse", error);
      return send(socket, { type: "error", code: "invalid-message", message: "Invalid signaling message." });
    }

    if (!message || !SESSION_ID_PATTERN.test(message.sessionId)) {
      logError("signaling-invalid-session", undefined, { sessionId: message?.sessionId ?? "unknown" });
      return send(socket, { type: "error", code: "invalid-session", message: "Invalid share session." });
    }

    if (message.type === "join") {
      if (message.role !== "sender" && message.role !== "receiver") {
        logError("signaling-invalid-role", undefined, { sessionId: message.sessionId, role: message.role });
        return send(socket, { type: "error", code: "invalid-role", message: "Invalid share role." });
      }
      let session = shareSessions.get(message.sessionId);
      if (!session && message.role === "sender") {
        session = { createdAt: Date.now(), peers: {} };
        shareSessions.set(message.sessionId, session);
        logShare("session-created", { sessionId: message.sessionId });
      }
      if (!session) {
        logError("signaling-session-not-found", undefined, { sessionId: message.sessionId, role: message.role });
        return send(socket, { type: "error", code: "not-found", message: "This share link has expired or is unavailable." });
      }
      if (session.peers[message.role] && session.peers[message.role] !== socket) {
        logError("signaling-role-taken", undefined, { sessionId: message.sessionId, role: message.role });
        return send(socket, { type: "error", code: "role-taken", message: "This link is already open in another browser." });
      }

      joinedSessionId = message.sessionId;
      joinedRole = message.role;
      session.peers[message.role] = socket;
      logShare("join", { sessionId: message.sessionId, role: message.role });
      send(socket, { type: "joined", role: message.role });
      const peer = session.peers[message.role === "sender" ? "receiver" : "sender"];
      if (peer) {
        logShare("peer-ready", { sessionId: message.sessionId, role: message.role });
        send(socket, { type: "peer-ready" });
        send(peer, { type: "peer-ready" });
      }
      return;
    }

    if (message.type === "signal" && joinedSessionId === message.sessionId && joinedRole) {
      if (!isWebRtcSignalPayload(message.payload)) {
        logError("signaling-invalid-payload", undefined, { sessionId: message.sessionId, role: joinedRole });
        return send(socket, { type: "error", code: "invalid-signal", message: "Only WebRTC offer, answer, and ICE messages are allowed." });
      }
      const session = shareSessions.get(message.sessionId);
      const peer = session?.peers[joinedRole === "sender" ? "receiver" : "sender"];
      if (!peer) {
        logError("signaling-peer-unavailable", undefined, { sessionId: message.sessionId, role: joinedRole });
        return send(socket, { type: "error", code: "peer-unavailable", message: "Waiting for the other person to open the link." });
      }
      logShare("signal-relayed", { sessionId: message.sessionId, role: joinedRole });
      // Relay SDP / ICE verbatim without interpreting or retaining it.
      return send(peer, { type: "signal", payload: message.payload });
    }
    logError("signaling-not-joined", undefined, { sessionId: message?.sessionId ?? "unknown", role: joinedRole ?? "unknown" });
    send(socket, { type: "error", code: "not-joined", message: "Join the share session first." });
  });

  socket.on("close", () => removePeer(socket));
  socket.on("error", (error) => {
    logError("ws-socket-error", error);
    removePeer(socket);
  });
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== "/signal") {
    logError("ws-upgrade-invalid-path", undefined, { pathname: url.pathname });
    return socket.destroy();
  }
  logShare("ws-upgrade", { pathname: url.pathname });
  signalingServer.handleUpgrade(request, socket, head, (webSocket) => signalingServer.emit("connection", webSocket, request));
});

const sessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of shareSessions) {
    if (now - session.createdAt >= SHARE_SESSION_TTL_MS) {
      logShare("session-expired", { sessionId });
      for (const peer of Object.values(session.peers)) {
        if (peer) send(peer, { type: "expired", message: "This 15-minute share session has expired." });
        peer?.close(1000, "Share session expired");
      }
      shareSessions.delete(sessionId);
    }
  }
}, 60_000);
sessionCleanup.unref();

server.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
  const mem = process.memoryUsage();
  console.log({
    rss: `${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
    heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`,
    heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`,
    external: `${(mem.external / 1024 / 1024).toFixed(1)} MB`,
  });
});
