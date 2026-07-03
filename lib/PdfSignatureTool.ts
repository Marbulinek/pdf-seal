'use strict';

import fs from 'fs';
import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFRef,
  PDFDict,
  AcroFieldFlags,
} from 'pdf-lib';

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
 * /Widget, /Rect, /P). This matches how other tools (and Nutrient/PSPDFKit
 * itself) commonly produce single-widget signature fields, and it's the
 * reason Nutrient's `annotation.creatorName` (which it synthesizes from
 * `annotation.formFieldName`, i.e. /T) is populated correctly: /T is
 * present directly on the annotation object, not on a separate parent
 * field object the widget only points to via /Kids.
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
   * @param {string} filePath
   * @returns {Promise<PdfSignatureTool>}
   */
  static async open(filePath: string) {
    const bytes = fs.readFileSync(filePath);
    const pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false });
    return new PdfSignatureTool(pdfDoc, filePath);
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
   * @param {number}  [options.borderWidth=1]
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
      borderWidth = 1,
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
      MK: { BC: [0, 0, 0], BG: [1, 1, 1] },
      BS: { W: borderWidth },
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
   * List every AcroForm field in the document with the metadata that
   * matters for signature workflows (type, required/readOnly, page, rect).
   * Works transparently for both merged and split (Kids-based) fields --
   * pdf-lib's own field/widget APIs handle both shapes when reading.
   * @returns {Array<object>}
   */
  listFields() {
    const form = this.pdfDoc.getForm();
    const pages = this.pdfDoc.getPages();

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

      return {
        name,
        type: field.constructor.name.replace('PDF', ''), // Signature, TextField, CheckBox, ...
        required: typeof field.isRequired === 'function' ? field.isRequired() : false,
        readOnly: typeof field.isReadOnly === 'function' ? field.isReadOnly() : false,
        tooltip: this._getRawString(field.acroField.dict, 'TU'),
        // Nutrient's `annotation.creatorName` is synthesized from the
        // annotation's own formFieldName (/T) for signature widgets --
        // there is no separate PDF key for it, so this is just the name.
        creatorName: name,
        page: pageIndex,
        rect,
        raw: this._getRawDictEntries(field.acroField.dict),
      };
    });
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
   * directly on the widget/annotation object, so renaming it here is
   * exactly what makes Nutrient's creatorName follow along too -- no
   * extra property needs to be touched.
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
    return {
      title: doc.getTitle(),
      author: doc.getAuthor(),
      subject: doc.getSubject(),
      keywords: doc.getKeywords(),
      creator: doc.getCreator(),
      producer: doc.getProducer(),
      creationDate: doc.getCreationDate(),
      modificationDate: doc.getModificationDate(),
      pageCount: doc.getPageCount(),
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
      out[key.toString().slice(1)] = value.toString();
    }
    return out;
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

  // ---------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------

  /** Serialize the document to bytes. */
  async toBytes() {
    return this.pdfDoc.save();
  }

  /** Save to disk. */
  async save(outputPath: string) {
    const bytes = await this.toBytes();
    fs.writeFileSync(outputPath, bytes);
    return outputPath;
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
