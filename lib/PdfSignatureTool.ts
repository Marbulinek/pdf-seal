'use strict';

import fs from 'fs';
import {
  PDFDocument,
  PDFAcroSignature,
  PDFSignature,
  AcroFieldFlags,
  PDFName,
  PDFString,
  PDFRef,
  PDFDict,
  rgb,
  degrees,
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
 * pdf-lib can already *read* signature fields (form.getSignature(name)),
 * but it has no createSignature()/addToPage() helper, and its built-in
 * removeField() throws on unsigned fields (it assumes every widget has an
 * appearance stream). Both gaps are patched here.
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
   * Add a new, empty signature field (widget) to a page.
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

    // 1. Build the underlying /FT /Sig field dictionary.
    const sigDict = context.obj({ FT: 'Sig', Kids: [] });
    
    // Set creatorName directly onto the raw field dictionary BEFORE registering it
    sigDict.set(PDFName.of('creatorName'), PDFString.of(name));

    const sigRef = context.register(sigDict);
    const acroSig = PDFAcroSignature.fromDict(sigDict, sigRef);
    acroSig.setPartialName(name);
    acroSig.setFlagTo(AcroFieldFlags.Required, !!required);
    acroSig.setFlagTo(AcroFieldFlags.ReadOnly, !!readOnly);
    if (tooltip) {
      sigDict.set(PDFName.of('TU'), PDFString.of(tooltip));
    }

    // Register the field at the top level of the AcroForm.
    form.acroForm.addField(sigRef);

    // 2. Create + attach the widget annotation (the visible box on the page).
    const pdfSignature = PDFSignature.of(acroSig, sigRef, pdfDoc);
    const widget = (pdfSignature as any).createWidget({
      x,
      y,
      width,
      height,
      borderWidth,
      borderColor: rgb(0, 0, 0),
      backgroundColor: rgb(1, 1, 1),
      rotate: degrees(0),
      page: page.ref,
    });
    
    // Set creatorName explicitly onto the underlying widget dictionary
    // 1. Set /creatorName as a custom key
    widget.dict.set(PDFName.of('NM'), PDFString.of(name));
    widget.dict.set(PDFName.of('creatorName'), PDFString.of(name));

    const widgetRef = context.register(widget.dict);
    acroSig.addWidget(widgetRef);

    this._setCreatorNameAnnotation(widget.dict, name);
    this._setCreatorNameAnnotation(sigDict, name);
    page.node.addAnnot(widgetRef);

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
      rect: widget.getRectangle(),
    };
  }

  /**
   * List every AcroForm field in the document with the metadata that
   * matters for signature workflows (type, required/readOnly, page, rect).
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

      return {
        name: field.getName(),
        type: field.constructor.name.replace('PDF', ''), // Signature, TextField, CheckBox, ...
        required: typeof field.isRequired === 'function' ? field.isRequired() : false,
        readOnly: typeof field.isReadOnly === 'function' ? field.isReadOnly() : false,
        tooltip: this._getRawString(field.acroField.dict, 'TU'),
        page: pageIndex,
        rect,
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

  /** Rename a field (its /T partial name). */
  renameField(name: string, newName: string) {
    const form = this.pdfDoc.getForm();
    if (form.getFieldMaybe(newName)) {
      throw new Error(`A form field named "${newName}" already exists.`);
    }
    const field = this._requireField(name);
    field.acroField.setPartialName(newName);
    
    this._setCreatorNameAnnotation(field.acroField.dict, newName); // sync field dict
    field.acroField.getWidgets().forEach((widget: any) => {
      // Force update the underlying dictionary mapping for Nutrient's parser
      if (widget && widget.dict) {
        widget.dict.set(PDFName.of('NM'), PDFString.of(newName));
      }
      this._setCreatorNameAnnotation(widget, newName);
    });
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
   * stream (/AP /N). This version doesn't make that assumption.
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

  _setCreatorNameAnnotation(target: any, creatorName: string) {
    const dict = target && target.dict ? target.dict : target; 
    if (dict && typeof dict.set === 'function') {
      dict.set(PDFName.of('creatorName'), PDFString.of(creatorName));
      dict.set(PDFName.of('NM'), PDFString.of(creatorName));
    }
  }

  _getRawString(dict: any, key: string) {
    if (!dict || !dict.has(PDFName.of(key))) return undefined;
    const value = dict.lookup(PDFName.of(key));
    if (!value) return undefined;
    
    // Properly unwrap PDFString object formats without breaking literal brackets
    return typeof value.value === 'function' ? value.value() : value.toString().replace(/^\(|\)$/g, '');
  }
}

export default PdfSignatureTool;
