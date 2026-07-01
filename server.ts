"use strict";

import express, { type Request, type Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import PdfSignatureTool from "./lib/PdfSignatureTool";

const app = express();
const PORT = process.env.PORT || 3000;

// Set up Multer for handling file uploads (saves temporarily to an 'uploads' folder)
const upload = multer({ dest: "uploads/" });

// Serve static files from the 'public' directory
app.use(express.static("public"));
app.use(express.json());

// Ensure the uploads directory exists
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
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

    // Clean up the uploaded file
    fs.unlinkSync(file.path);

    res.json(result);
  } catch (error: any) {
    fs.unlinkSync(file.path);
    res.status(500).json({ error: error?.message ?? "Unexpected error" });
  }
});

// --- API Endpoint: Add Signature Field ---
app.post(
  "/api/add-signature",
  upload.single("pdfDocument"),
  async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

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

      const outputPath = path.join("uploads", `modified_${Date.now()}.pdf`);
      await tool.save(outputPath);

      // Send the modified file back to the client
      res.download(outputPath, "signed-document.pdf", (err) => {
        // Clean up both the original upload and the modified output after sending
        fs.unlinkSync(file.path);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      });
    } catch (error: any) {
      fs.unlinkSync(file.path);
      res.status(500).json({ error: error?.message ?? "Unexpected error" });
    }
  },
);

// --- API Endpoint: Edit Existing Field ---
app.post("/api/edit-field", upload.single("pdfDocument"), async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

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

    const outputPath = path.join("uploads", `modified_${Date.now()}.pdf`);
    await tool.save(outputPath);

    res.download(outputPath, "signed-document.pdf", (err) => {
      fs.unlinkSync(file.path);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    });
  } catch (error: any) {
    fs.unlinkSync(file.path);
    res.status(500).json({ error: error?.message ?? "Unexpected error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
