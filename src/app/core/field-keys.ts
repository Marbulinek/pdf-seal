// Friendly labels + explainers for raw PDF dictionary keys (Field Details,
// the raw-object inspector) and the /F, /Ff flag bit tables.

export const FIELD_KEY_LABELS: Record<string, string> = {
  Type: 'Object Type',
  Subtype: 'Annotation Subtype',
  FT: 'Field Type',
  T: 'Field Name (/T)',
  TU: 'Tooltip / Alternate Name (/TU)',
  Rect: 'Position & Size (/Rect)',
  P: 'Page Reference (/P)',
  F: 'Annotation Flags (/F)',
  Ff: 'Field Flags (/Ff)',
  MK: 'Appearance Characteristics (/MK)',
  BS: 'Border Style (/BS)',
  AP: 'Appearance Streams (/AP)',
  V: 'Field Value (/V)',
  DA: 'Default Appearance (/DA)',
  Parent: 'Parent Field (/Parent)',
  Kids: 'Child Widgets (/Kids)',
  Length: 'Stream Length (/Length)',
  Filter: 'Stream Filter (/Filter)',
  Annots: 'Page Annotations (/Annots)',
  Contents: 'Content Stream Reference (/Contents)',
  Resources: 'Page Resources (/Resources)',
  MediaBox: 'Page Size (/MediaBox)',
  ByteRange: 'Signature Byte Range (/ByteRange)',
  SubFilter: 'Signature Sub-Filter (/SubFilter)',
  BaseFont: 'Font Name (/BaseFont)',
  Metadata: 'XMP Metadata Reference (/Metadata)',
  Fields: 'AcroForm Fields (/Fields)',
  SigFlags: 'Signature Flags (/SigFlags)',
};

// Trusted, static HTML snippets authored in this file -- rendered with [innerHTML].
export const FIELD_KEY_DESCRIPTIONS: Record<string, string> = {
  Type: '<h4>What it means</h4><p>This key identifies the PDF object type. In form workflows, it often tells the viewer that the object is an annotation or widget rather than a plain page content object.</p><p><strong>Example:</strong> a signature field may use <code>/Annot</code> to show that it is an annotation object.</p><ul><li>For signature fields, this is part of the structure that lets PDF viewers understand the object as an interactive form element.</li><li>It is usually one of the first properties inspectors look at when validating form integrity.</li></ul>',
  Subtype: '<h4>What it means</h4><p>This key narrows the object type further. For widgets it usually identifies the annotation kind that the field uses.</p><p><strong>Example:</strong> a visible signature box is commonly stored as <code>/Widget</code>, which tells the viewer it is a form widget.</p><ul><li>In signature forms, this helps distinguish a widget annotation from other annotation types such as links, highlights, or stamps.</li><li>It is important when a PDF contains multiple annotation classes and the viewer must choose the appropriate behavior.</li></ul>',
  FT: '<h4>What it means</h4><p>This is the form field type. It tells the PDF viewer what kind of form control this object represents.</p><p><strong>Example:</strong> a signature field is typically marked as <code>/Sig</code>, which tells the viewer it is a signature control.</p><ul><li>For signature fields, the value is typically <strong>Sig</strong>.</li><li>This is one of the core keys that makes the field behave as a signature field rather than as a regular text or checkbox field.</li></ul>',
  T: '<h4>What it means</h4><p>This is the field name, also known as the partial field name. It is the human-readable identifier used by PDF form machinery.</p><p><strong>Example:</strong> a field named <code>Signature1</code> may appear as <code>/T</code> so the form system can refer to it reliably.</p><ul><li>It is commonly what appears in exported form data and can be used to reference the field programmatically.</li><li>In signature workflows, this name is often the field identifier that tools and viewers use internally.</li></ul>',
  TU: '<h4>What it means</h4><p>This stores a tooltip or alternate name for the field. It is often shown by viewers when the user hovers over the field.</p><p><strong>Example:</strong> a field could use <code>/TU</code> with the text <code>Please sign here</code> so the user sees a helpful hint.</p><ul><li>It can improve usability by giving a friendly label even when the field name is technical or generated.</li><li>It does not change the actual field behavior, but it can make the interactive UI easier to understand.</li></ul>',
  Rect: '<h4>What it means</h4><p>This defines the position and size of the field on the page. It uses a rectangle with coordinates for the left, bottom, right, and top edges.</p><p><strong>Example:</strong> a rectangle such as <code>[72 180 260 230]</code> places the signature box near the lower part of the page.</p><ul><li>It is the key that controls where the signature area appears visually in the document.</li><li>Changing it modifies the placement and canvas size of the field in the PDF viewer.</li></ul>',
  P: '<h4>What it means</h4><p>This points to the page object that contains the widget annotation.</p><p><strong>Example:</strong> a field can point to page object <code>12 0 R</code>, meaning it belongs to page 12 of the document.</p><ul><li>It links the field to a specific page so the viewer knows where the control should be rendered.</li><li>When a field is moved to another page, this reference is updated accordingly.</li></ul>',
  F: '<h4>What it means</h4><p>This contains annotation flags that control behavior such as visibility, printing, or whether the annotation is editable.</p><p><strong>Example:</strong> a value such as <code>4</code> can make the annotation behave as hidden from normal viewing in some contexts.</p><ul><li>These flags influence how the viewer handles the widget in different contexts.</li><li>They are part of the low-level PDF annotation behavior rather than the visible appearance.</li></ul>',
  Ff: '<h4>What it means</h4><p>This contains field flags that affect form behavior such as required status, read-only state, or export behavior.</p><p><strong>Example:</strong> a field flag value of <code>2</code> often means the field is required before the form can be submitted.</p><ul><li>For example, the required flag causes the form to demand that the field be filled before submission.</li><li>It is one of the most important keys when working with form validation.</li></ul>',
  MK: '<h4>What it means</h4><p>This holds appearance characteristics such as border and background colors for the widget.</p><p><strong>Example:</strong> it may describe a dark border and a light background so the signature box stands out clearly.</p><ul><li>It can make the field stand out visually in the viewer.</li><li>It is separate from the actual form logic and mainly affects presentation.</li></ul>',
  BS: '<h4>What it means</h4><p>This describes border style for the annotation, including width and related visual formatting.</p><p><strong>Example:</strong> a thin or dashed border can be defined here to make the signature field easier to recognize.</p><ul><li>It helps control whether the field has a visible outline and how thick it looks.</li><li>It is part of the visual styling layer of the PDF annotation.</li></ul>',
  AP: '<h4>What it means</h4><p>This contains appearance streams that define the widget’s visual rendering.</p><p><strong>Example:</strong> a PDF can use this to show a custom visual state such as a highlighted or pressed signature box.</p><ul><li>In some PDFs this is used for custom appearance states or visuals.</li><li>It is especially relevant when the field needs a specific look beyond the default annotation styling.</li></ul>',
  V: '<h4>What it means</h4><p>This stores the field value. For form fields it may contain text or other data; for signature widgets, it can be a signature value or related metadata.</p><p><strong>Example:</strong> after signing, this value may hold the signature data or a reference to the signed content.</p><ul><li>It is the data that the form system would read or submit.</li><li>In digital signature workflows it can be crucial for understanding whether the field was populated or not.</li></ul>',
  DA: '<h4>What it means</h4><p>This stores the default appearance string for the field, usually affecting text style and font settings.</p><p><strong>Example:</strong> a value such as <code>/Helv 12 Tf 0 g</code> tells the viewer to use a 12-point Helvetica font with black text.</p><ul><li>It is often used to define how text should look when the field is displayed.</li><li>It is more about presentation than the actual field semantics.</li></ul>',
  Parent: '<h4>What it means</h4><p>This links the field to a parent field dictionary when the field is part of a hierarchy.</p><p><strong>Example:</strong> a complex form might place several widgets under one parent field so they share logical properties.</p><ul><li>It allows complex form structures where multiple widgets are grouped under a shared logical field.</li><li>It is often important in advanced or generated PDFs rather than simple one-field documents.</li></ul>',
  Kids: '<h4>What it means</h4><p>This contains child widget dictionaries when a field uses multiple annotations or widgets.</p><p><strong>Example:</strong> one logical signature field can have several child widgets that appear in different places or states.</p><ul><li>It is common in forms that expose the same logical field through multiple visual widgets.</li><li>It helps the PDF structure represent one field with several associated appearances or positions.</li></ul>',
  Length: '<h4>What it means</h4><p>This is the byte length of a stream object\'s (compressed) content, measured in the file as written.</p><p><strong>Example:</strong> a content stream might report <code>/Length 512</code> even though its decoded text is longer or shorter, once compression is undone.</p><ul><li>This can change even when the decoded content is identical — a re-compression alone will move it.</li><li>It is why a raw-object diff should compare decoded content, not just this key, before calling something a real content change.</li></ul>',
  Filter: '<h4>What it means</h4><p>This names the encoding (or chain of encodings) a stream\'s bytes were run through, so a reader knows how to decode them back to their original form.</p><p><strong>Example:</strong> <code>/Filter /FlateDecode</code> means the stream content is zlib/deflate-compressed.</p><ul><li>Changing this without changing the decoded content just means the same data was repackaged.</li><li>Multiple filters can be chained, most commonly for images.</li></ul>',
  Annots: '<h4>What it means</h4><p>This is the array of annotation objects (including signature/form widgets) placed on a page.</p><p><strong>Example:</strong> a page with two signature fields lists both of their widget references here.</p><ul><li>Adding, removing, or reordering entries here is how a widget gets attached to (or detached from) a page.</li><li>A large form can carry hundreds of entries, which is why this list is capped in the PDF source view here.</li></ul>',
  Contents: '<h4>What it means</h4><p>This points to the stream (or array of streams) holding a page\'s actual drawing operators — the instructions that paint its visible content.</p><p><strong>Example:</strong> <code>/Contents 6 0 R</code> means page content is the operators stored in object 6.</p><ul><li>This is the reference a page-content-stream raw object change is actually pointing back to.</li><li>A page\'s content stream is the closest thing a PDF has to "what got drawn," which is why changes to it get their own diff view.</li></ul>',
  Resources: '<h4>What it means</h4><p>This dictionary lists the fonts, images (XObjects), color spaces, and other resources a page\'s content stream is allowed to reference.</p><p><strong>Example:</strong> a font used in a signature\'s appearance text is registered here under a short name like <code>/F1</code>.</p><ul><li>An operator in the content stream that names a resource not listed here would fail to render.</li><li>It is shared infrastructure for the page, not something that changes just because one field was edited.</li></ul>',
  MediaBox: '<h4>What it means</h4><p>This defines the physical page boundary in points, as <code>[left bottom right top]</code>.</p><p><strong>Example:</strong> <code>[0 0 612 792]</code> is a US Letter page.</p><ul><li>All /Rect coordinates on the page (including signature field placement) are expressed relative to this box.</li><li>It rarely changes revision to revision — when it does, every rect on the page effectively means something different.</li></ul>',
  ByteRange: '<h4>What it means</h4><p>This tells a verifier exactly which byte spans of the file a digital signature\'s hash actually covers, skipping over the signature\'s own placeholder bytes.</p><p><strong>Example:</strong> <code>[0 840 960 1200]</code> means "hash bytes 0-839, then bytes 960-1199" — the gap is where the signature itself sits.</p><ul><li>If this doesn\'t extend to the end of the revision it claims to sign, something was appended afterward that the signature doesn\'t actually attest to.</li><li>This is exactly what the revision integrity check cross-references.</li></ul>',
  SubFilter: '<h4>What it means</h4><p>This identifies the specific signature format/encoding used inside a signature dictionary.</p><p><strong>Example:</strong> <code>/SubFilter /adbe.pkcs7.detached</code> is the common detached-PKCS7 signature format.</p><ul><li>A verifier uses this to know how to parse the bytes in <code>/Contents</code> of the signature dictionary.</li><li>It is one of the keys treated as "signing-related" wherever this app classifies a raw object\'s change.</li></ul>',
  BaseFont: '<h4>What it means</h4><p>This is the PostScript name of a font used somewhere in the document — most often in a field\'s default appearance or an embedded font object.</p><p><strong>Example:</strong> <code>/BaseFont /Helvetica</code> or a subsetted name like <code>/BaseFont /ABCDEF+Helvetica</code>.</p><ul><li>A subset prefix (six uppercase letters plus a plus sign) means only the glyphs actually used were embedded, to keep the file smaller.</li><li>Changing this can change how text renders even if nothing else about the field changed.</li></ul>',
  Metadata: '<h4>What it means</h4><p>This points to the document\'s XMP metadata stream, an XML packet carrying title/author/dates and other descriptive metadata in a standardized, machine-readable form (as opposed to the older Info dictionary).</p><p><strong>Example:</strong> <code>/Metadata 5 0 R</code> refers to the XMP packet stored in object 5.</p><ul><li>This object has no place on any page — it describes the document as a whole, which is why its raw-object change has no on-page preview.</li><li>Some PDF tools keep this in sync with the Info dictionary automatically; others don\'t, so the two can drift apart.</li></ul>',
  Fields: '<h4>What it means</h4><p>This is the AcroForm\'s top-level array of root form field references — the entry point for every interactive field in the document.</p><p><strong>Example:</strong> a document with three signature fields lists all three (or their shared parent fields) here.</p><ul><li>A field missing from this array (even if its widget is still on a page) generally won\'t behave as an interactive form field.</li><li>This is a document-level object with no page location of its own.</li></ul>',
  SigFlags: '<h4>What it means</h4><p>This AcroForm-level flag set signals whether the document contains signatures and whether it needs to be treated as an append-only file from here on.</p><p><strong>Example:</strong> a value of <code>3</code> means both "contains at least one signature" and "append-only changes required" (SignaturesExist + AppendOnly).</p><ul><li>Once AppendOnly is set, further edits are expected to happen as new incremental revisions rather than rewriting the file — the same mechanism this revision history feature reads.</li><li>It lives on the AcroForm dictionary, not on any individual signature field.</li></ul>',
};

// ISO 32000-1 Table 165 -- annotation /F flag bit meanings
export const ANNOTATION_FLAG_BITS: Record<number, string> = {
  1: 'Invisible', 2: 'Hidden', 3: 'Print', 4: 'NoZoom', 5: 'NoRotate',
  6: 'NoView', 7: 'ReadOnly', 8: 'Locked', 9: 'ToggleNoView', 10: 'LockedContents',
};

// ISO 32000-1 Table 221/228 -- common /Ff field flag bit meanings (bits 1-3
// are shared by every field type; bit 13 is text-field-specific: Multiline)
export const FIELD_FLAG_BITS: Record<number, string> = { 1: 'ReadOnly', 2: 'Required', 3: 'NoExport', 13: 'Multiline' };

export function decodeFlags(rawValue: string, bitMap: Record<number, string>): string[] {
  const num = parseInt(rawValue, 10);
  if (!Number.isFinite(num) || num === 0) return ['None'];
  const set = Object.entries(bitMap)
    .filter(([bit]) => num & (1 << (Number(bit) - 1)))
    .map(([, label]) => label);
  return set.length ? set : [`Unknown (${num})`];
}
