"use strict";

import express, { type Request, type Response, type NextFunction } from "express";
import multer, { MulterError } from "multer";
import path from "path";
import fs from "fs";
import PdfSignatureTool from "./lib/PdfSignatureTool";

const app = express();
const PORT = process.env.PORT || 3000;

// Set up Multer for handling file uploads (saves temporarily to an 'uploads' folder).
// A file-size cap keeps a single (or a burst of concurrent) uploads from blowing up
// process memory, since PdfSignatureTool.open() reads the whole file into a Buffer.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB
const upload = multer({ dest: "uploads/", limits: { fileSize: MAX_UPLOAD_BYTES } });

// Serve static files from the 'public' directory
app.use(express.static("public"));
app.use(express.json());

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
      console.error(`Failed to clean up temp file "${p}":`, cleanupErr);
    }
  }
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
    console.error(err);
    return res.status(500).json({ error: "Unexpected error" });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});