'use strict';

import fs from 'fs';
import path from 'path';
import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFRef,
  PDFDict,
  PDFArray,
  PDFStream,
  PDFRawStream,
  decodePDFRawStream,
  PDFNumber,
  PDFBool,
  PDFHexString,
  PDFNull,
  PDFCatalog,
  PDFPageTree,
  AcroFieldFlags,
} from 'pdf-lib';

/**
 * Recursively convert any pdf-lib object into plain, JSON-serializable
 * data (strings, numbers, booleans, null, plain objects, arrays).
 *
 * This is intentionally generic and format-agnostic -- it doesn't know
 * or care whether it's looking at a Catalog, a font, an image XObject,
 * an embedded XMP metadata stream, or a custom producer-specific key.
 * Whatever shape the PDF actually has, this mirrors it.
 *
 * Indirect references (PDFRef) are left as "<num> <gen> R" strings
 * rather than being resolved/inlined -- this keeps the walk flat,
 * immune to reference cycles (e.g. Pages <-> Kids <-> Parent), and
 * lets the caller cross-reference them against the flat object table
 * produced by getFullRawDump().
 */
function pdfValueToPlain(value: any, depth: number = 0): any {
  if (depth > 25) return '[max nesting depth reached]';
  if (value === undefined || value === null) return null;
  if (value instanceof PDFRef) return `${value.objectNumber} ${value.generationNumber} R`;
  if (value instanceof PDFName) {
    try {
      return value.decodeText();
    } catch (_e) {
      return value.toString().slice(1);
    }
  }
  if (value instanceof PDFString || value instanceof PDFHexString) {
    // These sometimes hold binary data (signature hashes, file IDs) rather
    // than real text -- decodeText() still returns *something* printable,
    // falling back to the raw hex/literal form only if it throws.
    try {
      return value.decodeText();
    } catch (_e) {
      return value.asString();
    }
  }
  if (value instanceof PDFNumber) return value.asNumber();
  if (value instanceof PDFBool) return value.asBoolean();
  if (value === PDFNull) return null;

  if (value instanceof PDFArray) {
    const out: any[] = [];
    for (let i = 0; i < value.size(); i++) out.push(pdfValueToPlain(value.get(i), depth + 1));
    return out;
  }

  if (value instanceof PDFStream) {
    const out: Record<string, any> = { '@type': 'Stream' };
    for (const [key, entry] of value.dict.entries()) {
      out[key.toString().slice(1)] = pdfValueToPlain(entry, depth + 1);
    }
    try {
      const bytes = typeof value.getContents === 'function' ? value.getContents() : null;
      if (bytes) out['@rawByteLength'] = bytes.length;
    } catch (_e) {
      // Some stream subclasses (e.g. still-encoded ones) may not expose raw
      // bytes cheaply -- that's fine, the dict entries are the useful part.
    }
    return out;
  }

  if (value instanceof PDFDict) {
    const out: Record<string, any> = {};
    for (const [key, entry] of value.entries()) {
      out[key.toString().slice(1)] = pdfValueToPlain(entry, depth + 1);
    }
    return out;
  }

  // Fallback for anything else pdf-lib might hand back.
  return typeof value.toString === 'function' ? value.toString() : String(value);
}

function pdfValueToInfoString(value: any): string {
  if (value === undefined || value === null) return '';
  if (value instanceof PDFString || value instanceof PDFHexString) {
    try {
      return value.decodeText();
    } catch (_e) {
      return value.asString();
    }
  }
  if (value instanceof PDFName) {
    try {
      return value.decodeText();
    } catch (_e) {
      return value.toString().slice(1);
    }
  }
  if (value instanceof PDFNumber) return String(value.asNumber());
  if (value instanceof PDFBool) return value.asBoolean() ? 'true' : 'false';
  if (value === PDFNull) return '';
  if (typeof value.toString === 'function') {
    const str = value.toString();
    return str === '[object Object]' ? JSON.stringify(value) : str;
  }
  return String(value);
}

// Common page sizes in points, compared orientation-agnostically (each
// entry's short/long edge) with a small tolerance for rounding drift.
const KNOWN_PAGE_SIZES: Array<{ name: string; width: number; height: number }> = [
  { name: 'A3', width: 841.89, height: 1190.55 },
  { name: 'A4', width: 595.28, height: 841.89 },
  { name: 'A5', width: 419.53, height: 595.28 },
  { name: 'B4', width: 708.66, height: 1000.63 },
  { name: 'B5', width: 498.9, height: 708.66 },
  { name: 'Letter', width: 612, height: 792 },
  { name: 'Legal', width: 612, height: 1008 },
  { name: 'Tabloid', width: 792, height: 1224 },
];
const PAGE_SIZE_TOLERANCE = 3; // pt

function pageSizeName(width: number, height: number): string {
  const shortEdge = Math.min(width, height);
  const longEdge = Math.max(width, height);
  for (const size of KNOWN_PAGE_SIZES) {
    const sizeShort = Math.min(size.width, size.height);
    const sizeLong = Math.max(size.width, size.height);
    if (Math.abs(shortEdge - sizeShort) <= PAGE_SIZE_TOLERANCE && Math.abs(longEdge - sizeLong) <= PAGE_SIZE_TOLERANCE) {
      return size.name;
    }
  }
  return `${Math.round(width)} × ${Math.round(height)} pt`;
}

/**
 * Pull one field out of an XMP packet's raw XML by local name (namespace
 * prefix-agnostic, since producers vary: dc:, xmp:, xmpMM:, pdf:, ...).
 * Handles both the attribute form (`prefix:Field="value"`) and the
 * element form (`<prefix:Field>value</prefix:Field>`), including values
 * wrapped in an rdf:Alt/Seq/Bag > rdf:li (as dc:title/dc:creator usually
 * are). Intentionally regex-based rather than a full XML parser -- XMP
 * packets are small, and this mirrors the rest of this file's approach
 * to reading PDF-adjacent formats.
 */
function extractXmpField(xml: string, localName: string): string | null {
  const attrMatch = new RegExp(`[\\w-]+:${localName}\\s*=\\s*"([^"]*)"`, 'i').exec(xml);
  if (attrMatch) return attrMatch[1].trim() || null;

  const elMatch = new RegExp(`<[\\w-]+:${localName}[^>]*>([\\s\\S]*?)<\\/[\\w-]+:${localName}>`, 'i').exec(xml);
  if (!elMatch) return null;

  let inner = elMatch[1];
  const liMatch = /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i.exec(inner);
  if (liMatch) inner = liMatch[1];

  let stripped = inner;
  let previous;
  do {
    previous = stripped;
    stripped = previous.replace(/<[^>]*>/g, '');
  } while (stripped !== previous);

  return stripped.trim() || null;
}

/**
 * PdfSignatureTool
 * ----------------
 * A small wrapper around pdf-lib that adds the two pieces pdf-lib doesn't
 * give you out of the box:
 *
 *   1. Creating empty (unsigned) /Sig form fields, with a "required" flag.
 *   2. Reading / writing every piece of PDF metadata that's relevant to
 *      those fields: document Info dictionary (Title, Author, ...),
 *      and per-field properties (name, required, read-only, page, rect,
 *      tooltip, and any other AcroForm field-dictionary entry).
 *
 * STRUCTURE NOTE (important): signature fields are created as a single
 * MERGED Field+Widget object -- one PDF dictionary that is simultaneously
 * the AcroForm field (/FT, /T, /Ff) and the page annotation (/Subtype
 * /Widget, /Rect, /P). This matches how other tools 
 * commonly produce single-widget signature fields
 *
 * pdf-lib's own built-in helpers (createTextField, PDFAcroSignature, etc.)
 * always build a SPLIT structure (parent field dict + separate child widget
 * dict via /Kids), which is why they are not used here for construction --
 * only for reading/inspecting fields, where pdf-lib handles both shapes
 * transparently.
 */
class PdfSignatureTool {
  private pdfDoc: any;
  private sourcePath: string | null;

  /**
   * Open a PDF file from disk.
   *
   * `filePath` is expected to come from a trusted caller (e.g. a path
   * produced by multer), but since it ultimately traces back to request
   * handling, we never dereference it as-is. `baseDir` is required: only
   * the basename of `filePath` is kept and rejoined onto `baseDir`, which
   * makes the final path structurally incapable of escaping it (no `/`,
   * `\`, or `..` can survive path.basename()).
   *
   * @param {string} filePath
   * @param {object} options
   * @param {string} options.baseDir trusted directory the filename is read from
   * @returns {Promise<PdfSignatureTool>}
   */
  static async open(filePath: string, options: { baseDir: string }) {
    if (!options || !options.baseDir) {
      throw new Error("open() requires a baseDir to read the file from.");
    }
    const safeName = path.basename(filePath);
    if (!safeName || safeName === "." || safeName === "..") {
      throw new Error("Invalid file name.");
    }
    const resolvedPath = path.join(path.resolve(options.baseDir), safeName);
    const bytes = fs.readFileSync(resolvedPath);
    return PdfSignatureTool._load(bytes, resolvedPath);
  }

  /**
   * Load a PDF directly from an in-memory byte buffer rather than from
   * disk -- no filesystem access, no baseDir/path-safety concerns, since
   * nothing here is treated as a file path.
   *
   * Used e.g. by PdfRevisionTool to load individual incremental-update
   * snapshots (byte slices of a larger file) as independent documents.
   *
   * @param {Uint8Array} bytes
   * @returns {Promise<PdfSignatureTool>}
   */
  static async fromBytes(bytes: Uint8Array) {
    return PdfSignatureTool._load(bytes, null);
  }

  /** Shared load path for open() and fromBytes(). */
  static async _load(bytes: Uint8Array, sourcePath: string | null) {
    try {
      const pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false });
      PdfSignatureTool._recoverMissingCatalog(pdfDoc);
      return new PdfSignatureTool(pdfDoc, sourcePath);
    } catch (error: any) {
      if (/encrypt|password/i.test(error?.message || "")) {
        throw new Error(
          "This PDF is password-protected or has editing restrictions. Remove its password/protection in a PDF editor, then upload the unlocked copy.",
        );
      }
      throw error;
    }
  }

  /**
   * pdf-lib resolves the document catalog from the trailer's /Root entry
   * (falling back to scanning for a /Type /Catalog object). Byte slices of
   * an incremental-update revision -- e.g. an early snapshot taken by
   * PdfRevisionTool -- can legitimately lack both: the catalog itself may
   * only be (re)written in a later revision. Left alone, pdf-lib leaves
   * `pdfDoc.catalog` undefined, and *every* catalog-touching call
   * (getPageCount()/getPages(), getForm() -> getOrCreateAcroForm(), etc.)
   * later crashes with a bare "Cannot read properties of undefined
   * (reading '...')" deep inside pdf-lib. Recover by ensuring a catalog
   * always exists: point it at the snapshot's own page tree root when one
   * can be found, otherwise fall back to reusing whatever partial page
   * tree exists, and as a last resort synthesize an empty one -- so the
   * snapshot can still be inspected instead of crashing outright.
   */
  static _recoverMissingCatalog(pdfDoc: any) {
    if (pdfDoc.catalog) return;
    const context = pdfDoc.context;
    const typeName = PDFName.of('Type');
    const parentName = PDFName.of('Parent');
    const pagesName = PDFName.of('Pages');

    let pagesRef: any = null;
    let anyPagesRef: any = null;
    for (const [ref, object] of context.enumerateIndirectObjects()) {
      if (object instanceof PDFDict && object.get(typeName) === pagesName) {
        anyPagesRef = anyPagesRef || ref;
        if (!object.get(parentName)) {
          pagesRef = ref;
          break;
        }
      }
    }
    if (!pagesRef) pagesRef = anyPagesRef;
    if (!pagesRef) {
      const pageTree = PDFPageTree.withContext(context);
      pagesRef = context.register(pageTree);
    }

    const catalog = PDFCatalog.withContextAndPages(context, pagesRef);
    context.trailerInfo.Root = context.register(catalog);
    pdfDoc.catalog = catalog;
  }

  /**
   * Start a brand new, empty PDF (handy for tests/demos).
   * @returns {Promise<PdfSignatureTool>}
   */
  static async create() {
    const pdfDoc = await PDFDocument.create();
    return new PdfSignatureTool(pdfDoc, null);
  }

  constructor(pdfDoc: any, sourcePath: string | null) {
    this.pdfDoc = pdfDoc;
    this.sourcePath = sourcePath;
  }

  /** Append a blank page to the document. */
  addPage() {
    this.pdfDoc.addPage();
  }

  // ---------------------------------------------------------------------
  // Signature fields
  // ---------------------------------------------------------------------

  /**
   * Add a new, empty signature field to a page, as a single merged
   * Field+Widget object (see class-level note above).
   *
   * @param {number} pageIndex zero-based page index
   * @param {string} name fully qualified field name (must be unique)
   * @param {object} [options]
   * @param {number} [options.x=50]
   * @param {number} [options.y=50]
   * @param {number} [options.width=200]
   * @param {number} [options.height=60]
   * @param {boolean} [options.required=false] mark the field as required
   * @param {boolean} [options.readOnly=false]
   * @param {string}  [options.tooltip] alternate field name / tooltip (/TU)
   * @returns {{name:string,page:number,required:boolean,rect:number[]}}
   */
  addSignatureField(pageIndex: number, name: string, options: any = {}) {
    const {
      x = 50,
      y = 50,
      width = 200,
      height = 60,
      required = false,
      readOnly = false,
      tooltip,
    } = options;

    const pdfDoc = this.pdfDoc;
    const context = pdfDoc.context;
    const pages = pdfDoc.getPages();
    const page = pages[pageIndex];
    if (!page) {
      throw new Error(
        `Page index ${pageIndex} does not exist (document has ${pages.length} page(s)).`
      );
    }

    const form = pdfDoc.getForm();
    if (form.getFieldMaybe(name)) {
      throw new Error(`A form field named "${name}" already exists.`);
    }

    // Compute the /Ff flags bitmask (Required = bit 2, ReadOnly = bit 1,
    // per ISO 32000-1 Table 221 / pdf-lib's AcroFieldFlags).
    let flags = 0;
    if (required) flags |= AcroFieldFlags.Required;
    if (readOnly) flags |= AcroFieldFlags.ReadOnly;

    const dictEntries: Record<string, any> = {
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: PDFString.of(name),
      Rect: [x, y, x + width, y + height],
      P: page.ref,
      F: 4, // Print flag -- visible when printed/rendered normally
      Ff: flags,
    };
    if (tooltip) {
      dictEntries.TU = PDFString.of(tooltip);
    }

    const mergedDict = context.obj(dictEntries);
    const fieldRef = context.register(mergedDict);

    // Register as both a top-level AcroForm field and a page annotation --
    // this single object plays both roles.
    form.acroForm.addField(fieldRef);
    page.node.addAnnot(fieldRef);

    // Tell viewers signature fields exist (AcroForm /SigFlags bit 1).
    const sigFlagsKey = PDFName.of('SigFlags');
    const current = form.acroForm.dict.has(sigFlagsKey)
      ? form.acroForm.dict.lookup(sigFlagsKey).asNumber()
      : 0;
    form.acroForm.dict.set(sigFlagsKey, context.obj(current | 1));

    return {
      name,
      page: pageIndex,
      required: !!required,
      rect: { x, y, width, height },
    };
  }

  /**
   * Add a new, empty text field to a page, as a single merged Field+Widget
   * object (same shape as addSignatureField() -- see class-level note).
   *
   * Text fields need a default appearance (/DA) naming a font that's
   * resolvable via the AcroForm's /DR resource dictionary, or viewers have
   * nothing to render the (currently empty) value with -- unlike signature
   * fields, which stay visually blank until actually signed.
   * _ensureAcroFormDefaultFont() sets that up (once) using the standard
   * Helvetica font, which every viewer supports without embedding.
   *
   * @param {number} pageIndex zero-based page index
   * @param {string} name fully qualified field name (must be unique)
   * @param {object} [options]
   * @param {number} [options.x=50]
   * @param {number} [options.y=50]
   * @param {number} [options.width=200]
   * @param {number} [options.height=30]
   * @param {boolean} [options.required=false] mark the field as required
   * @param {boolean} [options.readOnly=false]
   * @param {string}  [options.tooltip] alternate field name / tooltip (/TU)
   * @returns {{name:string,page:number,required:boolean,rect:number[]}}
   */
  addTextField(pageIndex: number, name: string, options: any = {}) {
    const {
      x = 50,
      y = 50,
      width = 200,
      height = 30,
      required = false,
      readOnly = false,
      tooltip,
    } = options;

    const pdfDoc = this.pdfDoc;
    const context = pdfDoc.context;
    const pages = pdfDoc.getPages();
    const page = pages[pageIndex];
    if (!page) {
      throw new Error(
        `Page index ${pageIndex} does not exist (document has ${pages.length} page(s)).`
      );
    }

    const form = pdfDoc.getForm();
    if (form.getFieldMaybe(name)) {
      throw new Error(`A form field named "${name}" already exists.`);
    }

    let flags = 0;
    if (required) flags |= AcroFieldFlags.Required;
    if (readOnly) flags |= AcroFieldFlags.ReadOnly;

    this._ensureAcroFormDefaultFont();

    const dictEntries: Record<string, any> = {
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Tx',
      T: PDFString.of(name),
      Rect: [x, y, x + width, y + height],
      P: page.ref,
      F: 4, // Print flag -- visible when printed/rendered normally
      Ff: flags,
      DA: PDFString.of('/Helv 12 Tf 0 g'),
    };
    if (tooltip) {
      dictEntries.TU = PDFString.of(tooltip);
    }

    const mergedDict = context.obj(dictEntries);
    const fieldRef = context.register(mergedDict);

    form.acroForm.addField(fieldRef);
    page.node.addAnnot(fieldRef);

    return {
      name,
      page: pageIndex,
      required: !!required,
      rect: { x, y, width, height },
    };
  }

  /**
   * Make sure the AcroForm has a /DR resource dictionary exposing the
   * standard Helvetica font under /Helv, and a fallback /DA, so text
   * fields' own /DA (see addTextField()) resolves to something every
   * viewer can render without embedding a font. Idempotent -- safe to
   * call before adding any number of text fields.
   */
  _ensureAcroFormDefaultFont() {
    const context = this.pdfDoc.context;
    const acroFormDict = this.pdfDoc.getForm().acroForm.dict;

    const drKey = PDFName.of('DR');
    let dr = acroFormDict.lookupMaybe(drKey, PDFDict);
    if (!dr) {
      dr = context.obj({});
      acroFormDict.set(drKey, dr);
    }

    const fontKey = PDFName.of('Font');
    let fontDict = dr.lookupMaybe(fontKey, PDFDict);
    if (!fontDict) {
      fontDict = context.obj({});
      dr.set(fontKey, fontDict);
    }

    const helvKey = PDFName.of('Helv');
    if (!fontDict.has(helvKey)) {
      const helvFont = context.obj({
        Type: 'Font',
        Subtype: 'Type1',
        BaseFont: 'Helvetica',
        Encoding: 'WinAnsiEncoding',
      });
      fontDict.set(helvKey, helvFont);
    }

    const daKey = PDFName.of('DA');
    if (!acroFormDict.has(daKey)) {
      acroFormDict.set(daKey, PDFString.of('/Helv 0 Tf 0 g'));
    }
  }

  /**
   * List every AcroForm field in the document with the metadata that
   * matters for signature workflows (type, required/readOnly, page, rect).
   * Works transparently for both merged and split (Kids-based) fields --
   * pdf-lib's own field/widget APIs handle both shapes when reading.
   * @returns {Array<object>}
   */
  listFields() {
    const form = this.pdfDoc.getForm();
    const pages = this.pdfDoc.getPages();
    const context = this.pdfDoc.context;

    return form.getFields().map((field: any) => {
      const widgets = field.acroField.getWidgets();
      const widget = widgets[0];
      let pageIndex = null;
      let rect = null;
      if (widget) {
        rect = widget.getRectangle();
        try {
          const page = form.findWidgetPage(widget);
          pageIndex = pages.indexOf(page);
        } catch (_e) {
          pageIndex = null;
        }
      }

      const name = field.getName();

      // Every indirect object backing this field -- its own field dict
      // plus each widget annotation's dict (same object when merged,
      // separate ones for Kids-based split fields) -- so callers can
      // recognize and skip these when walking the full raw object table
      // (they're already represented here, in user-friendly form).
      const refs = new Set<string>();
      const fieldRef = context.getObjectRef(field.acroField.dict);
      if (fieldRef) refs.add(fieldRef.toString());
      for (const w of widgets) {
        const widgetRef = context.getObjectRef(w.dict);
        if (widgetRef) refs.add(widgetRef.toString());
      }

      return {
        name,
        type: field.constructor.name.replace('PDF', ''), // Signature, TextField, CheckBox, ...
        required: typeof field.isRequired === 'function' ? field.isRequired() : false,
        readOnly: typeof field.isReadOnly === 'function' ? field.isReadOnly() : false,
        tooltip: this._getRawString(field.acroField.dict, 'TU'),
        page: pageIndex,
        rect,
        raw: this._getRawDictEntries(field.acroField.dict),
        objectRefs: Array.from(refs),
      };
    });
  }

  /**
   * Inspect every AcroForm signature field (/FT /Sig) that has actually
   * been signed -- i.e. has a populated /V signature dictionary -- and
   * return the human-relevant parts of that signature: who applied it,
   * when, why, and which bytes of the file it covers.
   *
   * An empty/unsigned signature field (created by addSignatureField(),
   * before anyone has signed it) is skipped since it has no /V yet.
   *
   * @returns {Array<{fieldName:string,name:?string,reason:?string,location:?string,signingTime:?string,subFilter:?string,contactInfo:?string,byteRange:?number[]}>}
   */
  getSignatureInfo() {
    const form = this.pdfDoc.getForm();
    const out: any[] = [];
    for (const field of form.getFields()) {
      const dict = field.acroField.dict;
      const ft = dict.lookup(PDFName.of('FT'));
      if (!ft || ft.toString() !== '/Sig') continue;

      const vDict = dict.lookup(PDFName.of('V'));
      if (!vDict || !(vDict instanceof PDFDict)) continue; // field exists but hasn't been signed yet

      const plain = pdfValueToPlain(vDict);
      out.push({
        fieldName: field.getName(),
        name: plain.Name ?? null,
        reason: plain.Reason ?? null,
        location: plain.Location ?? null,
        signingTime: plain.M ?? null,
        subFilter: plain.SubFilter ?? null,
        contactInfo: plain.ContactInfo ?? null,
        byteRange: Array.isArray(plain.ByteRange) ? plain.ByteRange : null,
      });
    }
    return out;
  }

  /**
   * Get every raw dictionary entry for one field (useful to inspect /
   * edit properties this library doesn't expose a named helper for).
   * @param {string} name
   */
  getFieldRaw(name: string) {
    const field = this._requireField(name);
    const dict = field.acroField.dict;
    const out: Record<string, string> = {};
    for (const [key, value] of dict.entries()) {
      out[key.toString().slice(1)] = value.toString();
    }
    return out;
  }

  /**
   * Rename a field (its /T partial name).
   *
   * For a merged field+widget (the shape this tool creates), /T lives
   * directly on the widget/annotation object
   */
  renameField(name: string, newName: string) {
    const form = this.pdfDoc.getForm();
    if (form.getFieldMaybe(newName)) {
      throw new Error(`A form field named "${newName}" already exists.`);
    }
    const field = this._requireField(name);
    field.acroField.setPartialName(newName);
  }

  /** Toggle whether a field must be filled in before the document can be submitted/signed. */
  setFieldRequired(name: string, required: boolean) {
    const field = this._requireField(name);
    if (required) field.enableRequired();
    else field.disableRequired();
  }

  /** Toggle read-only. */
  setFieldReadOnly(name: string, readOnly: boolean) {
    const field = this._requireField(name);
    if (readOnly) field.enableReadOnly();
    else field.disableReadOnly();
  }

  /** Set the tooltip / alternate field name (/TU). */
  setFieldTooltip(name: string, tooltip: string) {
    const field = this._requireField(name);
    field.acroField.dict.set(PDFName.of('TU'), PDFString.of(tooltip));
  }

  /** Move/resize a field's (first) widget on its current page. */
  setFieldRect(name: string, { x, y, width, height }: { x?: number; y?: number; width?: number; height?: number }) {
    const field = this._requireField(name);
    const widget = field.acroField.getWidgets()[0];
    if (!widget) throw new Error(`Field "${name}" has no widget to resize.`);
    const current = widget.getRectangle();
    widget.setRectangle({
      x: x ?? current.x,
      y: y ?? current.y,
      width: width ?? current.width,
      height: height ?? current.height,
    });
  }

  /** Move a field's (first) widget to a different page. */
  setFieldPage(name: string, newPageIndex: number) {
    const pdfDoc = this.pdfDoc;
    const form = pdfDoc.getForm();
    const pages = pdfDoc.getPages();
    const newPage = pages[newPageIndex];
    if (!newPage) {
      throw new Error(
        `Page index ${newPageIndex} does not exist (document has ${pages.length} page(s)).`
      );
    }

    const field = this._requireField(name);
    const widget = field.acroField.getWidgets()[0];
    if (!widget) throw new Error(`Field "${name}" has no widget to move.`);

    const widgetRef = pdfDoc.context.getObjectRef(widget.dict);
    const oldPage = form.findWidgetPage(widget);

    if (widgetRef) oldPage.node.removeAnnot(widgetRef);
    widget.setP(newPage.ref);
    if (widgetRef) newPage.node.addAnnot(widgetRef);
  }

  /**
   * Remove a field entirely (and its widget annotation from its page).
   *
   * pdf-lib's own `form.removeField()` throws on unsigned signature
   * fields because it assumes every widget has a normal appearance
   * stream (/AP /N). This version doesn't make that assumption, and
   * handles both merged and split field shapes.
   */
  removeField(name: string) {
    const pdfDoc = this.pdfDoc;
    const form = pdfDoc.getForm();
    const field = this._requireField(name);
    const acroField = field.acroField;

    const widgets = acroField.getWidgets();
    const pagesTouched = new Set<any>();
    for (const widget of widgets) {
      const widgetRef = pdfDoc.context.getObjectRef(widget.dict);
      const page = form.findWidgetPage(widget);
      pagesTouched.add(page);
      if (widgetRef) page.node.removeAnnot(widgetRef);
    }
    pagesTouched.forEach((page) => page.node.removeAnnot(field.ref));

    form.acroForm.removeField(acroField);

    const kids = acroField.normalizedEntries().Kids;
    for (let i = 0; i < kids.size(); i++) {
      const child = kids.get(i);
      if (child instanceof PDFRef) pdfDoc.context.delete(child);
    }
    pdfDoc.context.delete(field.ref);
  }

  // ---------------------------------------------------------------------
  // Document metadata
  // ---------------------------------------------------------------------

  /** Read the standard document Info dictionary fields. */
  getMetadata() {
    const doc = this.pdfDoc;
    let pageCount = null;
    try {
      pageCount = doc.getPageCount();
    } catch (_err) {
      // No resolvable page tree in this snapshot (e.g. a byte slice of an
      // incremental-update revision taken before the catalog/page tree
      // was (re)written) -- fall back to "unknown" rather than throwing.
    }
    return {
      title: doc.getTitle(),
      author: doc.getAuthor(),
      subject: doc.getSubject(),
      keywords: doc.getKeywords(),
      creator: doc.getCreator(),
      producer: doc.getProducer(),
      creationDate: doc.getCreationDate(),
      modificationDate: doc.getModificationDate(),
      pageCount,
    };
  }

  /**
   * Set one or more standard Info dictionary fields. Any key left out is
   * untouched. Pass `keywords` as an array of strings or a single string.
   */
  setMetadata(meta: any = {}) {
    const doc = this.pdfDoc;
    if (meta.title !== undefined) doc.setTitle(meta.title);
    if (meta.author !== undefined) doc.setAuthor(meta.author);
    if (meta.subject !== undefined) doc.setSubject(meta.subject);
    if (meta.keywords !== undefined) {
      const kw = Array.isArray(meta.keywords) ? meta.keywords : [meta.keywords];
      doc.setKeywords(kw);
    }
    if (meta.creator !== undefined) doc.setCreator(meta.creator);
    if (meta.producer !== undefined) doc.setProducer(meta.producer);
    if (meta.creationDate !== undefined) doc.setCreationDate(meta.creationDate);
    if (meta.modificationDate !== undefined) doc.setModificationDate(meta.modificationDate);
  }

  /**
   * Read every raw entry in the document's Info dictionary, including
   * any non-standard/custom keys other tools may have added.
   */
  getRawInfoDict() {
    const context = this.pdfDoc.context;
    const infoRef = context.trailerInfo.Info;
    if (!infoRef) return {};
    const info = context.lookup(infoRef, PDFDict);
    if (!info) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of info.entries()) {
      out[key.toString().slice(1)] = pdfValueToInfoString(value);
    }
    return out;
  }

  /** Read the embedded revision-chain entries (if any) stored in the Info dictionary. */
  getRevisionSnapshotChain() {
    const rawInfo = this.getRawInfoDict();
    const rawChain = rawInfo['PdfSealRevisionChainV1'] || rawInfo['PdfSealRevisionChain'];
    if (!rawChain) return [];

    try {
      const parsed = JSON.parse(rawChain);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry: any) => entry && typeof entry === 'object' && typeof entry.bytes === 'string')
        .map((entry: any) => ({
          index: Number.isInteger(entry.index) ? entry.index : 1,
          bytes: entry.bytes,
        }));
    } catch (_err) {
      return [];
    }
  }

  /** Replace the embedded revision-chain entry in the Info dictionary. */
  setRevisionSnapshotChain(entries: Array<{ index: number; bytes: string }>) {
    this.setCustomInfoEntry('PdfSealRevisionChainV1', JSON.stringify(entries));
  }

  /**
   * Remove the embedded revision-chain entry from the Info dictionary.
   *
   * Must be called -- and the document re-serialized -- before computing
   * the byte snapshot that will become the chain's NEXT entry. Otherwise
   * that snapshot would itself contain the entire chain-so-far (since it's
   * just another Info dict entry, included in every save()), which then
   * gets pushed into the chain array alongside the very entries it
   * already duplicates internally. Each subsequent revision would repeat
   * this, roughly doubling the document's size every time a field is
   * added/edited/removed -- runaway growth that has no relationship to
   * the PDF's actual content size.
   */
  clearRevisionSnapshotChain() {
    const context = this.pdfDoc.context;
    const infoRef = context.trailerInfo.Info;
    if (!infoRef) return;
    const info = context.lookup(infoRef, PDFDict);
    if (!info) return;
    info.delete(PDFName.of('PdfSealRevisionChainV1'));
    info.delete(PDFName.of('PdfSealRevisionChain'));
  }

  /** Write an arbitrary/custom key into the Info dictionary (e.g. a tracking ID). */
  setCustomInfoEntry(key: string, value: string) {
    const context = this.pdfDoc.context;
    const infoRef = context.trailerInfo.Info;
    let info = infoRef ? context.lookup(infoRef, PDFDict) : undefined;
    if (!info) {
      info = context.obj({});
      context.trailerInfo.Info = context.register(info);
    }
    info.set(PDFName.of(key), PDFString.of(String(value)));
  }

  /**
   * Read the document's embedded XMP metadata packet (the /Metadata
   * stream hanging off the Catalog), if any, and pull out the handful of
   * fields the Metadata panel cares about. Returns null if the document
   * has no XMP packet at all.
   */
  getXmpMetadata() {
    const catalog = this.pdfDoc.catalog;
    if (!catalog) return null;
    const context = this.pdfDoc.context;
    const metadataRef = catalog.get(PDFName.of('Metadata'));
    if (!metadataRef) return null;
    const stream = context.lookup(metadataRef);
    if (!(stream instanceof PDFStream)) return null;

    let xml: string;
    try {
      const bytes = stream instanceof PDFRawStream
        ? (decodePDFRawStream(stream).getBytes as (length?: number) => Uint8Array)()
        : stream.getContents();
      xml = Buffer.from(bytes).toString('utf8');
    } catch (_e) {
      return null;
    }

    return {
      title: extractXmpField(xml, 'title'),
      creator: extractXmpField(xml, 'creator'),
      creatorTool: extractXmpField(xml, 'CreatorTool'),
      createDate: extractXmpField(xml, 'CreateDate'),
      modifyDate: extractXmpField(xml, 'ModifyDate'),
      documentId: extractXmpField(xml, 'DocumentID'),
      instanceId: extractXmpField(xml, 'InstanceID'),
      raw: xml,
    };
  }

  /** Describe one /Filespec dictionary (an embedded-file attachment) as {filename, mimeType, size}. */
  _describeAttachment(filespecDict: any) {
    const context = this.pdfDoc.context;
    const filenameRaw = filespecDict.get(PDFName.of('UF')) || filespecDict.get(PDFName.of('F'));
    const filename = filenameRaw ? pdfValueToInfoString(filenameRaw) : 'attachment';

    let mimeType: string | null = null;
    let size: number | null = null;

    const efRef = filespecDict.get(PDFName.of('EF'));
    const ef = efRef ? context.lookup(efRef, PDFDict) : null;
    const streamRef = ef ? (ef.get(PDFName.of('F')) || ef.get(PDFName.of('UF'))) : null;
    const stream = streamRef ? context.lookup(streamRef) : null;

    if (stream instanceof PDFStream) {
      const subtype = stream.dict.get(PDFName.of('Subtype'));
      if (subtype) mimeType = pdfValueToInfoString(subtype);
      try {
        const bytes = stream instanceof PDFRawStream
          ? (decodePDFRawStream(stream).getBytes as (length?: number) => Uint8Array)()
          : stream.getContents();
        size = bytes ? bytes.length : null;
      } catch (_e) {
        // Opaque/unsupported filter -- fall through to the /Params/Size hint below.
      }
      if (size === null) {
        const params = stream.dict.get(PDFName.of('Params'));
        const paramsDict = params ? context.lookup(params, PDFDict) : null;
        const sizeVal = paramsDict ? paramsDict.get(PDFName.of('Size')) : null;
        if (sizeVal instanceof PDFNumber) size = sizeVal.asNumber();
      }
    }

    return { filename, mimeType, size };
  }

  /**
   * Assemble the simplified, human-facing overview the Metadata panel
   * shows by default: document info, feature flags, per-page summary,
   * attachments, XMP metadata, and document IDs. This is deliberately
   * NOT the raw object dump (see getFullRawDump() for that) -- every
   * value here is either a primitive or a small plain object.
   *
   * `fileSize` and `incrementalUpdates` come from the caller because
   * neither is knowable from the parsed document alone: file size is a
   * property of the original upload, and incremental-update count comes
   * from scanning the raw bytes for revision boundaries (see
   * PdfRevisionTool.findRevisionBoundaries), not from anything pdf-lib
   * models.
   */
  getMetadataOverview(options: { fileSize?: number | null; incrementalUpdates?: number | null } = {}) {
    const doc = this.pdfDoc;
    const context = doc.context;
    const catalog = doc.catalog;

    const metadata = this.getMetadata();
    const header = context.header;
    const pdfVersion = header ? `${header.major}.${header.minor}` : null;

    const acroFormRef = catalog ? catalog.get(PDFName.of('AcroForm')) : null;
    const acroForm = acroFormRef ? context.lookup(acroFormRef, PDFDict) : null;
    const hasAcroForm = !!acroForm;
    const hasXfa = !!(acroForm && acroForm.has(PDFName.of('XFA')));

    const fields = this.listFields();
    const signatureFieldCount = fields.filter((f: any) => f.type === 'Signature').length;
    const signatureInfo = this.getSignatureInfo();

    let hasJavaScript = false;
    let hasLinearized = false;
    const attachments: any[] = [];
    const linearizedKey = PDFName.of('Linearized');
    const sKey = PDFName.of('S');
    const typeKey = PDFName.of('Type');
    const filespecName = PDFName.of('Filespec');

    for (const [, obj] of context.enumerateIndirectObjects()) {
      const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
      if (!dict) continue;

      if (!hasJavaScript && dict.get(sKey) === PDFName.of('JavaScript')) hasJavaScript = true;
      if (!hasLinearized && dict.has(linearizedKey)) hasLinearized = true;
      if (dict.get(typeKey) === filespecName) attachments.push(this._describeAttachment(dict));
    }

    const xmp = this.getXmpMetadata();

    let pdfA = 'No';
    if (xmp && xmp.raw && /pdfaid:part/i.test(xmp.raw)) {
      pdfA = 'Yes';
    } else {
      const outputIntentsRef = catalog ? catalog.get(PDFName.of('OutputIntents')) : null;
      const outputIntents = outputIntentsRef ? context.lookup(outputIntentsRef, PDFArray) : null;
      if (outputIntents) {
        for (let i = 0; i < outputIntents.size(); i++) {
          const intent = context.lookup(outputIntents.get(i), PDFDict);
          const s = intent ? intent.get(PDFName.of('S')) : null;
          if (s && /GTS_PDFA/i.test(s.toString())) {
            pdfA = 'Yes';
            break;
          }
        }
      }
    }

    const toHex = (value: any): string | null => {
      if (!value) return null;
      try {
        const bytes = typeof value.asBytes === 'function' ? value.asBytes() : null;
        return bytes ? Buffer.from(bytes).toString('hex') : null;
      } catch (_e) {
        return null;
      }
    };
    const trailerId = context.trailerInfo.ID;
    const documentIds: Record<string, string | null> = { permanent: null, changing: null, xmpDocumentId: null, xmpInstanceId: null };
    if (trailerId instanceof PDFArray && trailerId.size() >= 1) {
      documentIds.permanent = toHex(trailerId.get(0));
      documentIds.changing = trailerId.size() > 1 ? toHex(trailerId.get(1)) : documentIds.permanent;
    }
    if (xmp) {
      documentIds.xmpDocumentId = xmp.documentId;
      documentIds.xmpInstanceId = xmp.instanceId;
    }

    let pageCount = metadata.pageCount ?? 0;
    const pages: any[] = [];
    try {
      const pdfPages = doc.getPages();
      pageCount = pdfPages.length;
      pdfPages.forEach((page: any, index: number) => {
        const size = page.getSize();
        const rotation = ((page.getRotation().angle % 360) + 360) % 360;
        const swapped = rotation === 90 || rotation === 270;
        const effectiveWidth = swapped ? size.height : size.width;
        const effectiveHeight = swapped ? size.width : size.height;
        pages.push({
          index,
          width: size.width,
          height: size.height,
          rotation,
          sizeName: pageSizeName(size.width, size.height),
          orientation: effectiveWidth >= effectiveHeight ? 'Landscape' : 'Portrait',
        });
      });
    } catch (_e) {
      // No resolvable page tree in this snapshot -- mirror getMetadata()'s tolerance.
    }

    return {
      documentInfo: {
        ...metadata,
        pdfVersion,
        fileSize: options.fileSize ?? null,
        pageCount,
      },
      features: {
        encrypted: !!context.trailerInfo.Encrypt,
        pdfA,
        linearized: hasLinearized,
        xfa: hasXfa,
        acroForm: hasAcroForm,
        signatureFieldCount,
        javascript: hasJavaScript,
        attachmentCount: attachments.length,
        xmpMetadata: !!xmp,
        incrementalUpdates: options.incrementalUpdates ?? null,
        signatureCount: signatureInfo.length,
      },
      pages,
      attachments,
      xmp,
      documentIds,
    };
  }

  /**
   * Walk the ENTIRE PDF object graph -- every single indirect object in
   * the file, plus the trailer -- and return it as plain key/value data.
   *
   * Unlike getMetadata()/getRawInfoDict()/listFields(), this makes no
   * assumption about what's "relevant": it dynamically enumerates
   * whatever objects the file actually contains -- Catalog, Pages,
   * individual page dicts, fonts, XObjects (images), the AcroForm,
   * annotations, outlines, embedded XMP metadata streams, and any
   * custom/producer-specific objects -- so it surfaces every possible
   * piece of metadata, not just the ones this tool otherwise knows about.
   *
   * @returns {{trailer: object, objects: Record<string, any>}}
   *   `objects` is keyed by "<objNum> <gen> R" (matching how those
   *   objects are referenced elsewhere in the dump), each value being
   *   the plain-data form of that object's dictionary/array/primitive.
   */
  getFullRawDump() {
    const context = this.pdfDoc.context;
    const objects: Record<string, any> = {};

    for (const [ref, obj] of context.enumerateIndirectObjects()) {
      const key = `${ref.objectNumber} ${ref.generationNumber} R`;
      objects[key] = pdfValueToPlain(obj);
    }

    const trailer: Record<string, any> = {};
    const trailerInfo = context.trailerInfo || {};
    for (const [key, value] of Object.entries(trailerInfo)) {
      if (value === undefined || value === null) continue;
      trailer[key] = pdfValueToPlain(value);
    }

    return { trailer, objects };
  }

  /**
   * Decode a stream object's actual (post-/Filter) bytes given its
   * "<num> <gen> R" reference -- e.g. a page's content stream is almost
   * always FlateDecode-compressed, so the raw bytes in the file aren't
   * the PDF operators themselves; this is what lets the revision diff
   * compare what a content stream actually *says* rather than just its
   * compressed size.
   *
   * Returns null if the ref doesn't resolve to a stream, or if pdf-lib
   * can't decode it (an unsupported/custom filter) -- callers treat
   * that as "no content diff available for this object" rather than an
   * error, since plenty of streams (images, embedded fonts) are opaque
   * binary data this isn't meant to handle anyway.
   */
  getStreamText(ref: string): { text: string; rawByteLength: number } | null {
    const match = /^(\d+)\s+(\d+)\s+R$/.exec(ref);
    if (!match) return null;
    const context = this.pdfDoc.context;
    try {
      const pdfRef = PDFRef.of(parseInt(match[1], 10), parseInt(match[2], 10));
      const obj = context.lookup(pdfRef);
      if (!(obj instanceof PDFStream)) return null;
      // Passing no length reads to EOF -- required here since `getBytes`'s
      // (optional-at-runtime, non-optional-in-its-.d.ts) length param
      // causes a pre-allocation loop for something like Infinity instead.
      const decoded = obj instanceof PDFRawStream
        ? (decodePDFRawStream(obj).getBytes as (length?: number) => Uint8Array)()
        : obj.getContents();
      // Latin1 is a lossless 1-byte-to-1-char mapping (same rationale as
      // REVISION_BOUNDARY_PATTERN above) -- keeps this safe for content
      // streams that are mostly-but-not-strictly ASCII, without ever
      // throwing on genuinely binary bytes.
      return { text: Buffer.from(decoded).toString('latin1'), rawByteLength: decoded.length };
    } catch (_e) {
      return null;
    }
  }

  /**
   * Convenience bundle for a "Document Info" view: standard metadata,
   * the raw Info dictionary (including any custom keys), every form
   * field with its full raw dictionary entries, and -- for a truly
   * complete picture -- the entire raw PDF object table via
   * getFullRawDump(). Intended to be spread into whatever JSON an
   * `/api/info`-style route already returns, e.g.
   *
   *   const info = tool.getDocumentInfoSummary();
   *   res.json({ fields: info.fields, metadata: info.metadata, rawInfo: info.rawInfo, rawObjects: info.rawObjects });
   */
  getDocumentInfoSummary(
    options: { fileSize?: number | null; incrementalUpdates?: number | null; fieldsOnly?: boolean } = {},
  ) {
    // `fieldsOnly` skips getFullRawDump() (a walk of every object in the
    // PDF) and the metadata/overview lookups -- callers that only need form
    // fields for canvas rendering (i.e. every document load and edit) hit
    // this path so that work isn't repeated on every keystroke of a signing
    // session; the full summary is fetched separately, on demand, only when
    // a view that actually shows it (Metadata) is opened.
    if (options.fieldsOnly) {
      return { fields: this.listFields() };
    }
    return {
      metadata: this.getMetadata(),
      rawInfo: this.getRawInfoDict(),
      fields: this.listFields(),
      rawObjects: this.getFullRawDump(),
      overview: this.getMetadataOverview(options),
    };
  }

  // ---------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------

  /** Serialize the document to bytes. */
  async toBytes() {
    return this.pdfDoc.save();
  }

  /**
   * Save to disk.
   *
   * `baseDir` is required for the same reason as open(): only the
   * basename of `outputPath` is kept and rejoined onto `baseDir`, so the
   * write target can never escape that directory regardless of what
   * `outputPath` contains.
   */
  async save(outputPath: string, options: { baseDir: string }) {
    if (!options || !options.baseDir) {
      throw new Error("save() requires a baseDir to write the file into.");
    }
    const safeName = path.basename(outputPath);
    if (!safeName || safeName === "." || safeName === "..") {
      throw new Error("Invalid file name.");
    }
    const resolvedPath = path.join(path.resolve(options.baseDir), safeName);
    const bytes = await this.toBytes();
    fs.writeFileSync(resolvedPath, bytes);
    return resolvedPath;
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  _requireField(name: string) {
    const form = this.pdfDoc.getForm();
    const field = form.getFieldMaybe(name);
    if (!field) throw new Error(`No form field named "${name}" was found.`);
    return field;
  }

  _getRawString(dict: any, key: string) {
    if (!dict || !dict.has(PDFName.of(key))) return undefined;
    const value = dict.lookup(PDFName.of(key));
    if (!value) return undefined;

    // Properly unwrap PDFString object formats without breaking literal brackets
    return typeof value.value === 'function' ? value.value() : value.toString().replace(/^\(|\)$/g, '');
  }

  _getRawDictEntries(dict: any) {
    if (!dict) return {};

    const out: Record<string, string> = {};
    for (const [key, value] of dict.entries()) {
      const keyName = key.toString().slice(1);
      if (value && typeof value.toString === 'function') {
        const text = value.toString();
        out[keyName] = text.replace(/^\(|\)$/g, '');
      } else {
        out[keyName] = '';
      }
    }
    return out;
  }
}

export default PdfSignatureTool;