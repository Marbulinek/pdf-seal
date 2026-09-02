// Pure logic behind the Signatures panel's "Signature Templates" feature --
// named, reusable lists of field definitions the user keeps in localStorage
// and drops onto any document.
//
// public/index.html inlines this same normalization/naming/placement logic
// directly (the app has no frontend build step to import from here), so this
// module exists to give it unit coverage; keep the two in sync by hand if
// either changes. Everything here is pure: no localStorage, no DOM.
//
// Coordinates are PDF user space points with a bottom-left origin -- the same
// space as a field's `rect` in the UI (see screenRectToPdf() in
// public/index.html) -- and `page` is 0-indexed, matching `field.page`.

export type TemplateItemType = 'signature' | 'text';

export interface TemplateItem {
  id: string;
  name: string;
  type: TemplateItemType;
  width: number;
  height: number;
  x: number;
  y: number;
  page: number;
  required: boolean;
  /** Text items only -- whether the field accepts multiple lines of input. */
  multiline: boolean;
}

export interface SignatureTemplate {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  items: TemplateItem[];
}

export interface TemplateStore {
  version: number;
  templates: SignatureTemplate[];
}

export interface Placement {
  name: string;
  type: TemplateItemType;
  required: boolean;
  multiline: boolean;
  page: number;
  rect: { x: number; y: number; width: number; height: number };
}

// Why an item couldn't be placed. Only one reason exists today; it's a string
// union rather than a boolean so the UI can grow new skip cases without
// changing this contract.
export type SkipReason = 'page-missing';

export interface SkippedPlacement {
  name: string;
  page: number;
  reason: SkipReason;
}

export interface PlacementPlan {
  placements: Placement[];
  skipped: SkippedPlacement[];
}

export interface TemplateExport {
  app: string;
  version: number;
  exportedAt: string;
  templates: SignatureTemplate[];
}

export interface MergeResult {
  store: TemplateStore;
  /** Names the incoming templates ended up with, in file order. */
  added: string[];
  /** Incoming templates whose name collided and had to be suffixed. */
  renamed: Array<{ from: string; to: string }>;
}

export const TEMPLATE_STORE_VERSION = 1;

// Identifies this app's own export files. Import doesn't require it -- a
// hand-written or hand-edited file with a `templates` array is still valid --
// but it makes the file self-describing for anyone who opens it in an editor.
export const TEMPLATE_EXPORT_APP = 'pdf-seal';

// Per-type fallbacks, mirroring FIELD_TYPE_CONFIG in public/index.html so a
// template item with a missing/garbage size lands at the same default the
// Add New panel would have used.
const DEFAULT_SIZE: Record<TemplateItemType, { width: number; height: number }> = {
  signature: { width: 200, height: 60 },
  text: { width: 200, height: 30 },
};

const MIN_DIMENSION = 1;

function emptyStore(): TemplateStore {
  return { version: TEMPLATE_STORE_VERSION, templates: [] };
}

// Coerces `value` to a finite number, falling back to `fallback` for anything
// that isn't one (null, "", "abc", NaN, Infinity). Numeric strings are
// accepted because they're what an <input type="number"> hands back.
function toFiniteNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeType(value: unknown): TemplateItemType {
  return value === 'text' ? 'text' : 'signature';
}

// Templates and items are addressed by id everywhere in the UI, so an id
// collision would make one of the pair unreachable. Rather than dropping the
// duplicate (and silently losing the user's data) we mint a fresh id for it.
function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function normalizeItem(raw: any, seenIds: Set<string>): TemplateItem | null {
  if (!raw || typeof raw !== 'object') return null;

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null; // an unnamed field can't be added to a PDF at all

  const type = normalizeType(raw.type);
  const defaults = DEFAULT_SIZE[type];

  let id = typeof raw.id === 'string' && raw.id ? raw.id : makeId('itm');
  if (seenIds.has(id)) id = makeId('itm');
  seenIds.add(id);

  // A zero/negative width or height would produce an invisible, unusable
  // field, so those clamp up to MIN_DIMENSION rather than falling back to the
  // per-type default -- the user did pick a small size, just an unusable one.
  const width = Math.max(MIN_DIMENSION, toFiniteNumber(raw.width, defaults.width));
  const height = Math.max(MIN_DIMENSION, toFiniteNumber(raw.height, defaults.height));

  return {
    id,
    name,
    type,
    width,
    height,
    x: toFiniteNumber(raw.x, 0),
    y: toFiniteNumber(raw.y, 0),
    // Pages are 0-indexed; a negative page is nonsense, so clamp to the first.
    page: Math.max(0, Math.round(toFiniteNumber(raw.page, 0))),
    required: raw.required === true,
    multiline: type === 'text' && raw.multiline === true,
  };
}

function normalizeTemplate(raw: any, seenTemplateIds: Set<string>): SignatureTemplate | null {
  if (!raw || typeof raw !== 'object') return null;

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;

  let id = typeof raw.id === 'string' && raw.id ? raw.id : makeId('tpl');
  if (seenTemplateIds.has(id)) id = makeId('tpl');
  seenTemplateIds.add(id);

  // Item ids only need to be unique within their own template -- that's the
  // scope every lookup in the UI runs in.
  const seenItemIds = new Set<string>();
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const items = rawItems
    .map((item: any) => normalizeItem(item, seenItemIds))
    .filter((item: TemplateItem | null): item is TemplateItem => item !== null);

  const createdAt = toFiniteNumber(raw.createdAt, 0);
  return {
    id,
    name,
    createdAt,
    updatedAt: toFiniteNumber(raw.updatedAt, createdAt),
    items,
  };
}

// Repairs whatever came back out of localStorage into a store the UI can
// render without defensive checks at every access. Anything unsalvageable is
// dropped rather than thrown: a corrupt store must never break the panel, let
// alone the page. An empty template (no items) is kept -- that's a legitimate
// state the user reaches by creating a template before filling it in.
export function normalizeTemplateStore(raw: any): TemplateStore {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.templates)) return emptyStore();

  const seenTemplateIds = new Set<string>();
  const templates = raw.templates
    .map((template: any) => normalizeTemplate(template, seenTemplateIds))
    .filter((template: SignatureTemplate | null): template is SignatureTemplate => template !== null);

  return { version: TEMPLATE_STORE_VERSION, templates };
}

// Returns `base` if `isTaken` says it's free, else the first "base (n)" that is.
function nextAvailableName(base: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(base)) return base;
  let suffix = 2;
  while (isTaken(`${base} (${suffix})`)) suffix += 1;
  return `${base} (${suffix})`;
}

// Field names must be unique within a PDF's AcroForm -- addSignatureField()
// throws on a collision -- so every name headed for a document goes through
// here first. Matching is exact: the PDF spec treats field names as
// case-sensitive.
export function uniqueFieldName(base: string, takenNames: Set<string> | Iterable<string>): string {
  const taken = takenNames instanceof Set ? takenNames : new Set(takenNames);
  return nextAvailableName(base, (candidate) => taken.has(candidate));
}

// Template names are a human-facing label rather than a PDF identifier, so
// they're compared case-insensitively -- "NDA" and "nda" would be confusing as
// two separate entries in the picker.
export function uniqueTemplateName(base: string, takenNames: Set<string> | Iterable<string>): string {
  const taken = new Set([...takenNames].map((name) => name.toLowerCase()));
  return nextAvailableName(base, (candidate) => taken.has(candidate.toLowerCase()));
}

// Works out what "Automatic placing" would actually do, without touching any
// document state, so the caller can stage the result as one undo step and
// report the skips.
//
// `takenNames` is the set of field names already in the document. Names
// claimed earlier in this same batch are added to it as we go, so two
// identically-named items in one template resolve to "Sig" and "Sig (2)"
// rather than colliding with each other.
export function planAutoPlacement(
  items: TemplateItem[],
  takenNames: Set<string> | Iterable<string>,
  pageCount: number,
): PlacementPlan {
  const claimed = takenNames instanceof Set ? new Set(takenNames) : new Set(takenNames);
  const placements: Placement[] = [];
  const skipped: SkippedPlacement[] = [];

  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;

    // An item saved against page 5 is meaningless in a 3-page document, and
    // the server would reject the add outright -- skip it and let the caller
    // tell the user which ones didn't make it.
    if (!Number.isFinite(pageCount) || item.page < 0 || item.page >= pageCount) {
      skipped.push({ name: item.name, page: item.page, reason: 'page-missing' });
      continue;
    }

    const name = uniqueFieldName(item.name, claimed);
    claimed.add(name);
    placements.push({
      name,
      type: item.type,
      required: !!item.required,
      multiline: item.type === 'text' && !!item.multiline,
      page: item.page,
      rect: { x: item.x, y: item.y, width: item.width, height: item.height },
    });
  }

  return { placements, skipped };
}

// Moves one item between two templates, returning a new store (the argument is
// left untouched). A no-op -- the same store, unchanged -- if either template
// or the item can't be found, or if source and destination are the same list.
export function moveTemplateItem(
  store: TemplateStore,
  fromTemplateId: string,
  toTemplateId: string,
  itemId: string,
): TemplateStore {
  if (!store || !Array.isArray(store.templates)) return store;
  if (fromTemplateId === toTemplateId) return store;

  const from = store.templates.find((t) => t.id === fromTemplateId);
  const to = store.templates.find((t) => t.id === toTemplateId);
  if (!from || !to) return store;

  const item = from.items.find((i) => i.id === itemId);
  if (!item) return store;

  // Item ids are only unique within a template, so re-mint on a collision in
  // the destination.
  const moved = to.items.some((i) => i.id === item.id) ? { ...item, id: makeId('itm') } : item;
  const now = Date.now();

  return {
    ...store,
    templates: store.templates.map((template) => {
      if (template.id === fromTemplateId) {
        return { ...template, items: template.items.filter((i) => i.id !== itemId), updatedAt: now };
      }
      if (template.id === toTemplateId) {
        return { ...template, items: [...template.items, moved], updatedAt: now };
      }
      return template;
    }),
  };
}

// Copies one item into another template, returning a new store (the argument
// is left untouched). Unlike moveTemplateItem, the source keeps its copy. A
// no-op -- the same store, unchanged -- if either template or the item can't
// be found, or if source and destination are the same list.
export function copyTemplateItem(
  store: TemplateStore,
  fromTemplateId: string,
  toTemplateId: string,
  itemId: string,
): TemplateStore {
  if (!store || !Array.isArray(store.templates)) return store;
  if (fromTemplateId === toTemplateId) return store;

  const from = store.templates.find((t) => t.id === fromTemplateId);
  const to = store.templates.find((t) => t.id === toTemplateId);
  if (!from || !to) return store;

  const item = from.items.find((i) => i.id === itemId);
  if (!item) return store;

  // Item ids are only unique within a template, so re-mint on a collision in
  // the destination.
  const copied = to.items.some((i) => i.id === item.id) ? { ...item, id: makeId('itm') } : { ...item };
  const now = Date.now();

  return {
    ...store,
    templates: store.templates.map((template) => (
      template.id === toTemplateId
        ? { ...template, items: [...template.items, copied], updatedAt: now }
        : template
    )),
  };
}

// Wraps the store in the shape written to disk by "Export templates". Kept
// here so the file format has exactly one definition, shared by the writer and
// by parseTemplateExport() below.
export function buildTemplateExport(store: TemplateStore, now: Date = new Date()): TemplateExport {
  return {
    app: TEMPLATE_EXPORT_APP,
    version: TEMPLATE_STORE_VERSION,
    exportedAt: now.toISOString(),
    templates: normalizeTemplateStore(store).templates,
  };
}

// Reads back a file written by buildTemplateExport (or any JSON with a
// `templates` array). Unlike normalizeTemplateStore, which silently returns an
// empty store for junk because a corrupt localStorage entry must never break
// the panel, this throws: an import the user explicitly asked for that turns
// out to contain nothing needs to say so rather than appear to succeed.
export function parseTemplateExport(text: string): TemplateStore {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (_err) {
    throw new Error("That file isn't valid JSON.");
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.templates)) {
    throw new Error("That file doesn't look like a pdf-seal template export — it has no \"templates\" list.");
  }

  const store = normalizeTemplateStore(parsed);
  if (!store.templates.length) {
    throw new Error("That file doesn't contain any usable signature templates.");
  }
  return store;
}

// Adds `incoming`'s templates to `current` without touching what's already
// there -- the non-destructive half of import. Colliding names are suffixed
// and colliding ids re-minted, so re-importing a file the user still has
// produces a visible duplicate rather than silently overwriting their work.
// (Replacing outright is the caller's other option; it just persists
// `incoming` directly.)
export function mergeTemplateStores(current: TemplateStore, incoming: TemplateStore): MergeResult {
  const base = normalizeTemplateStore(current);
  const extra = normalizeTemplateStore(incoming);

  const takenNames = new Set(base.templates.map((t) => t.name));
  const takenIds = new Set(base.templates.map((t) => t.id));
  const added: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];

  const merged = extra.templates.map((template) => {
    const name = uniqueTemplateName(template.name, takenNames);
    if (name !== template.name) renamed.push({ from: template.name, to: name });
    takenNames.add(name);

    const id = takenIds.has(template.id) ? `${template.id}_${takenIds.size}` : template.id;
    takenIds.add(id);

    added.push(name);
    return { ...template, id, name };
  });

  return {
    store: { version: TEMPLATE_STORE_VERSION, templates: [...base.templates, ...merged] },
    added,
    renamed,
  };
}

// A signature/text field as it exists on the open document -- the shape the
// Signatures panel keeps in `documentFields`. Only the parts a template needs
// are declared here; the real object carries readOnly/tooltip too.
export interface DocumentFieldLike {
  name: string;
  /** pdf-lib's own naming: 'Signature' or 'TextField'. */
  type: string;
  required?: boolean;
  multiline?: boolean;
  page: number;
  rect: { x: number; y: number; width: number; height: number };
}

export interface UpsertResult {
  items: TemplateItem[];
  /** True when an item of the same name was overwritten rather than appended. */
  replaced: boolean;
}

// Sizes and positions come out of a drag/resize as long floats; two decimals
// is well under a point and keeps the stored JSON readable.
function roundPoint(value: number): number {
  return Math.round(toFiniteNumber(value, 0) * 100) / 100;
}

// Turns a field the user has already placed on the document into a template
// item. This is the only way items are created now -- the template editor
// takes a name and nothing else, so every size/position in a template came
// from a real field on a real page.
//
// `id` is passed in rather than minted here so the caller owns id generation
// (and so this stays pure/testable).
export function templateItemFromField(field: DocumentFieldLike, id: string): TemplateItem {
  const type: TemplateItemType = field.type === 'TextField' || field.type === 'text' ? 'text' : 'signature';
  const defaults = DEFAULT_SIZE[type];
  const rect = field.rect || ({} as DocumentFieldLike['rect']);

  return {
    id,
    name: String(field.name ?? '').trim(),
    type,
    width: Math.max(MIN_DIMENSION, roundPoint(toFiniteNumber(rect.width, defaults.width))),
    height: Math.max(MIN_DIMENSION, roundPoint(toFiniteNumber(rect.height, defaults.height))),
    x: roundPoint(rect.x),
    y: roundPoint(rect.y),
    page: Math.max(0, Math.round(toFiniteNumber(field.page, 0))),
    required: field.required === true,
    multiline: type === 'text' && field.multiline === true,
  };
}

// Appends `item` to `items`, or replaces the existing entry of the same name.
// Dragging the same field in twice means "update what I saved", not "keep two
// copies" -- and two items sharing a name inside one template would collide on
// placement anyway. Names match case-sensitively, like PDF field names do.
export function upsertTemplateItem(items: TemplateItem[], item: TemplateItem): UpsertResult {
  const list = Array.isArray(items) ? items : [];
  const index = list.findIndex((existing) => existing.name === item.name);
  if (index === -1) return { items: [...list, item], replaced: false };

  // Keep the id already in the list so anything holding a reference to it
  // (a row's dataset, an in-flight move) still resolves.
  const next = list.slice();
  next[index] = { ...item, id: list[index].id };
  return { items: next, replaced: true };
}

export default {
  TEMPLATE_STORE_VERSION,
  TEMPLATE_EXPORT_APP,
  normalizeTemplateStore,
  templateItemFromField,
  upsertTemplateItem,
  uniqueFieldName,
  uniqueTemplateName,
  planAutoPlacement,
  moveTemplateItem,
  copyTemplateItem,
  buildTemplateExport,
  parseTemplateExport,
  mergeTemplateStores,
};
