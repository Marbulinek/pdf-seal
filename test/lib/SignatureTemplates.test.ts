import { describe, it, expect } from 'vitest';
import {
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
  TemplateItem,
  TemplateStore,
} from '../../lib/SignatureTemplates';

function item(overrides: Partial<TemplateItem> = {}): TemplateItem {
  return {
    id: 'itm1',
    name: 'Signature1',
    type: 'signature',
    width: 200,
    height: 60,
    x: 50,
    y: 100,
    page: 0,
    required: false,
    multiline: false,
    ...overrides,
  };
}

describe('normalizeTemplateStore', () => {
  it('returns an empty store for anything unusable', () => {
    const expected = { version: 1, templates: [] };
    expect(normalizeTemplateStore(null)).toEqual(expected);
    expect(normalizeTemplateStore(undefined)).toEqual(expected);
    expect(normalizeTemplateStore('not an object')).toEqual(expected);
    expect(normalizeTemplateStore({})).toEqual(expected);
    expect(normalizeTemplateStore({ templates: 'nope' })).toEqual(expected);
  });

  it('drops templates and items that have no usable name', () => {
    const store = normalizeTemplateStore({
      templates: [
        { id: 't1', name: '   ', items: [] },
        { id: 't2', items: [] },
        null,
        { id: 't3', name: 'Keeper', items: [{ id: 'i1', name: '' }, null, { id: 'i2', name: 'Sig' }] },
      ],
    });

    expect(store.templates).toHaveLength(1);
    expect(store.templates[0].name).toBe('Keeper');
    expect(store.templates[0].items).toHaveLength(1);
    expect(store.templates[0].items[0].name).toBe('Sig');
  });

  it('keeps a template that has no items yet', () => {
    const store = normalizeTemplateStore({ templates: [{ id: 't1', name: 'Fresh' }] });
    expect(store.templates).toHaveLength(1);
    expect(store.templates[0].items).toEqual([]);
  });

  it('fills in per-type default dimensions for missing or garbage numbers', () => {
    const store = normalizeTemplateStore({
      templates: [
        {
          id: 't1',
          name: 'Defaults',
          items: [
            { id: 'i1', name: 'Sig' },
            { id: 'i2', name: 'Txt', type: 'text', width: 'abc', height: null },
          ],
        },
      ],
    });

    const [sig, txt] = store.templates[0].items;
    expect(sig.type).toBe('signature');
    expect([sig.width, sig.height]).toEqual([200, 60]);
    expect(txt.type).toBe('text');
    expect([txt.width, txt.height]).toEqual([200, 30]);
  });

  it('accepts numeric strings and clamps unusable sizes and pages', () => {
    const store = normalizeTemplateStore({
      templates: [
        {
          id: 't1',
          name: 'Coerced',
          items: [{ id: 'i1', name: 'Sig', width: '120.5', height: 0, x: '10', page: -3 }],
        },
      ],
    });

    const only = store.templates[0].items[0];
    expect(only.width).toBe(120.5);
    expect(only.height).toBe(1);
    expect(only.x).toBe(10);
    expect(only.page).toBe(0);
  });

  it('re-mints duplicate template and item ids so both stay reachable', () => {
    const store = normalizeTemplateStore({
      templates: [
        { id: 'dup', name: 'First', items: [{ id: 'same', name: 'A' }, { id: 'same', name: 'B' }] },
        { id: 'dup', name: 'Second', items: [] },
      ],
    });

    expect(store.templates).toHaveLength(2);
    expect(store.templates[0].id).not.toBe(store.templates[1].id);
    const [a, b] = store.templates[0].items;
    expect(a.id).not.toBe(b.id);
  });

  it('normalizes an unknown type to signature and a missing required to false', () => {
    const store = normalizeTemplateStore({
      templates: [{ id: 't1', name: 'T', items: [{ id: 'i1', name: 'S', type: 'checkbox' }] }],
    });
    expect(store.templates[0].items[0].type).toBe('signature');
    expect(store.templates[0].items[0].required).toBe(false);
  });

  it('always stamps the current store version', () => {
    expect(normalizeTemplateStore({ version: 99, templates: [] }).version).toBe(1);
  });
});

describe('uniqueFieldName', () => {
  it('returns the base name when it is free', () => {
    expect(uniqueFieldName('Signature1', new Set())).toBe('Signature1');
  });

  it('suffixes from (2) upward, skipping names already taken', () => {
    expect(uniqueFieldName('Sig', new Set(['Sig']))).toBe('Sig (2)');
    expect(uniqueFieldName('Sig', new Set(['Sig', 'Sig (2)', 'Sig (3)']))).toBe('Sig (4)');
  });

  it('accepts any iterable of taken names', () => {
    expect(uniqueFieldName('Sig', ['Sig', 'Sig (2)'])).toBe('Sig (3)');
  });
});

describe('planAutoPlacement', () => {
  it('plans every item when all pages exist', () => {
    const plan = planAutoPlacement([item({ id: 'a', name: 'A' }), item({ id: 'b', name: 'B', page: 2 })], new Set(), 3);

    expect(plan.skipped).toEqual([]);
    expect(plan.placements).toHaveLength(2);
    expect(plan.placements[1]).toEqual({
      name: 'B',
      type: 'signature',
      required: false,
      multiline: false,
      page: 2,
      rect: { x: 50, y: 100, width: 200, height: 60 },
    });
  });

  it('suffixes names that collide with fields already in the document', () => {
    const plan = planAutoPlacement([item({ name: 'CEO Signature' })], new Set(['CEO Signature']), 1);
    expect(plan.placements[0].name).toBe('CEO Signature (2)');
  });

  it('suffixes names that collide within the same batch', () => {
    const plan = planAutoPlacement(
      [item({ id: 'a', name: 'Sig' }), item({ id: 'b', name: 'Sig' }), item({ id: 'c', name: 'Sig' })],
      new Set(),
      1,
    );
    expect(plan.placements.map((p) => p.name)).toEqual(['Sig', 'Sig (2)', 'Sig (3)']);
  });

  it('skips items whose page does not exist in the document', () => {
    const plan = planAutoPlacement(
      [item({ id: 'a', name: 'OnPage1', page: 0 }), item({ id: 'b', name: 'OnPage9', page: 8 })],
      new Set(),
      3,
    );

    expect(plan.placements.map((p) => p.name)).toEqual(['OnPage1']);
    expect(plan.skipped).toEqual([{ name: 'OnPage9', page: 8, reason: 'page-missing' }]);
  });

  it('does not let a skipped item consume a name', () => {
    const plan = planAutoPlacement(
      [item({ id: 'a', name: 'Sig', page: 5 }), item({ id: 'b', name: 'Sig', page: 0 })],
      new Set(),
      1,
    );

    expect(plan.skipped).toHaveLength(1);
    expect(plan.placements.map((p) => p.name)).toEqual(['Sig']);
  });

  it('leaves the caller\'s taken-name set untouched', () => {
    const taken = new Set(['Sig']);
    planAutoPlacement([item({ name: 'Sig' })], taken, 1);
    expect([...taken]).toEqual(['Sig']);
  });

  it('returns an empty plan for an empty or missing item list', () => {
    expect(planAutoPlacement([], new Set(), 3)).toEqual({ placements: [], skipped: [] });
    expect(planAutoPlacement(undefined as any, new Set(), 3)).toEqual({ placements: [], skipped: [] });
  });

  it('carries the item type and required flag through to the placement', () => {
    const plan = planAutoPlacement([item({ type: 'text', required: true })], new Set(), 1);
    expect(plan.placements[0].type).toBe('text');
    expect(plan.placements[0].required).toBe(true);
  });
});

describe('moveTemplateItem', () => {
  function twoTemplates(): TemplateStore {
    return {
      version: 1,
      templates: [
        { id: 't1', name: 'One', createdAt: 0, updatedAt: 0, items: [item({ id: 'i1', name: 'A' })] },
        { id: 't2', name: 'Two', createdAt: 0, updatedAt: 0, items: [] },
      ],
    };
  }

  it('moves the item to the destination and removes it from the source', () => {
    const next = moveTemplateItem(twoTemplates(), 't1', 't2', 'i1');
    expect(next.templates[0].items).toEqual([]);
    expect(next.templates[1].items).toHaveLength(1);
    expect(next.templates[1].items[0].name).toBe('A');
  });

  it('leaves the original store untouched', () => {
    const store = twoTemplates();
    moveTemplateItem(store, 't1', 't2', 'i1');
    expect(store.templates[0].items).toHaveLength(1);
    expect(store.templates[1].items).toHaveLength(0);
  });

  it('is a no-op for an unknown template, item, or a same-list move', () => {
    const store = twoTemplates();
    expect(moveTemplateItem(store, 't1', 'nope', 'i1')).toBe(store);
    expect(moveTemplateItem(store, 'nope', 't2', 'i1')).toBe(store);
    expect(moveTemplateItem(store, 't1', 't2', 'nope')).toBe(store);
    expect(moveTemplateItem(store, 't1', 't1', 'i1')).toBe(store);
  });

  it('re-mints the id when the destination already uses it', () => {
    const store = twoTemplates();
    store.templates[1].items = [item({ id: 'i1', name: 'Existing' })];

    const next = moveTemplateItem(store, 't1', 't2', 'i1');
    const ids = next.templates[1].items.map((i) => i.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('leaves a third, uninvolved template untouched', () => {
    const store = twoTemplates();
    store.templates.push({ id: 't3', name: 'Three', createdAt: 0, updatedAt: 0, items: [item({ id: 'i3', name: 'C' })] });

    const next = moveTemplateItem(store, 't1', 't2', 'i1');
    expect(next.templates[2]).toBe(store.templates[2]);
  });
});

describe('copyTemplateItem', () => {
  function twoTemplates(): TemplateStore {
    return {
      version: 1,
      templates: [
        { id: 't1', name: 'One', createdAt: 0, updatedAt: 0, items: [item({ id: 'i1', name: 'A' })] },
        { id: 't2', name: 'Two', createdAt: 0, updatedAt: 0, items: [] },
      ],
    };
  }

  it('adds the item to the destination and keeps it in the source', () => {
    const next = copyTemplateItem(twoTemplates(), 't1', 't2', 'i1');
    expect(next.templates[0].items).toHaveLength(1);
    expect(next.templates[0].items[0].name).toBe('A');
    expect(next.templates[1].items).toHaveLength(1);
    expect(next.templates[1].items[0].name).toBe('A');
  });

  it('leaves the original store untouched', () => {
    const store = twoTemplates();
    copyTemplateItem(store, 't1', 't2', 'i1');
    expect(store.templates[0].items).toHaveLength(1);
    expect(store.templates[1].items).toHaveLength(0);
  });

  it('is a no-op for an unknown template, item, or a same-list copy', () => {
    const store = twoTemplates();
    expect(copyTemplateItem(store, 't1', 'nope', 'i1')).toBe(store);
    expect(copyTemplateItem(store, 'nope', 't2', 'i1')).toBe(store);
    expect(copyTemplateItem(store, 't1', 't2', 'nope')).toBe(store);
    expect(copyTemplateItem(store, 't1', 't1', 'i1')).toBe(store);
  });

  it('re-mints the id when the destination already uses it', () => {
    const store = twoTemplates();
    store.templates[1].items = [item({ id: 'i1', name: 'Existing' })];

    const next = copyTemplateItem(store, 't1', 't2', 'i1');
    const ids = next.templates[1].items.map((i) => i.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('uniqueTemplateName', () => {
  it('returns the base name when it is free', () => {
    expect(uniqueTemplateName('NDA', new Set())).toBe('NDA');
  });

  it('compares case-insensitively so "NDA" and "nda" cannot coexist', () => {
    expect(uniqueTemplateName('NDA', new Set(['nda']))).toBe('NDA (2)');
    expect(uniqueTemplateName('nda', new Set(['NDA', 'NDA (2)']))).toBe('nda (3)');
  });
});

function storeWith(...names: string[]): TemplateStore {
  return {
    version: 1,
    templates: names.map((name, index) => ({
      id: `t${index}`,
      name,
      createdAt: 0,
      updatedAt: 0,
      items: [item({ id: `i${index}`, name: `${name} field` })],
    })),
  };
}

describe('buildTemplateExport', () => {
  it('stamps the app, version and export time around the templates', () => {
    const exported = buildTemplateExport(storeWith('NDA'), new Date('2026-09-01T10:00:00.000Z'));
    expect(exported.app).toBe('pdf-seal');
    expect(exported.version).toBe(1);
    expect(exported.exportedAt).toBe('2026-09-01T10:00:00.000Z');
    expect(exported.templates.map((t) => t.name)).toEqual(['NDA']);
  });

  it('normalizes on the way out, so a repaired store is what gets written', () => {
    const exported = buildTemplateExport({ templates: [{ name: 'Kept' }, { name: '  ' }] } as any);
    expect(exported.templates.map((t) => t.name)).toEqual(['Kept']);
  });
});

describe('parseTemplateExport', () => {
  it('round-trips a file written by buildTemplateExport', () => {
    const text = JSON.stringify(buildTemplateExport(storeWith('NDA', 'Contract')));
    expect(parseTemplateExport(text).templates.map((t) => t.name)).toEqual(['NDA', 'Contract']);
  });

  it('accepts a bare object with a templates array', () => {
    const text = JSON.stringify({ templates: [{ id: 't1', name: 'Bare', items: [] }] });
    expect(parseTemplateExport(text).templates).toHaveLength(1);
  });

  it('throws — rather than returning empty — for junk the user chose to import', () => {
    expect(() => parseTemplateExport('not json')).toThrow(/valid JSON/);
    expect(() => parseTemplateExport('{}')).toThrow(/templates/);
    expect(() => parseTemplateExport('[]')).toThrow(/templates/);
    expect(() => parseTemplateExport(JSON.stringify({ templates: [] }))).toThrow(/any usable/);
    expect(() => parseTemplateExport(JSON.stringify({ templates: [{ name: '' }] }))).toThrow(/any usable/);
  });
});

describe('mergeTemplateStores', () => {
  it('appends the incoming templates after the existing ones', () => {
    const result = mergeTemplateStores(storeWith('Contract'), storeWith('NDA'));
    expect(result.store.templates.map((t) => t.name)).toEqual(['Contract', 'NDA']);
    expect(result.added).toEqual(['NDA']);
    expect(result.renamed).toEqual([]);
  });

  it('restores into an empty store untouched — the clear-your-browser-data case', () => {
    const backup = storeWith('Contract', 'NDA');
    const result = mergeTemplateStores({ version: 1, templates: [] }, backup);
    expect(result.store.templates.map((t) => t.name)).toEqual(['Contract', 'NDA']);
    expect(result.renamed).toEqual([]);
  });

  it('suffixes a colliding name instead of overwriting the existing template', () => {
    const result = mergeTemplateStores(storeWith('NDA'), storeWith('NDA'));
    expect(result.store.templates.map((t) => t.name)).toEqual(['NDA', 'NDA (2)']);
    expect(result.renamed).toEqual([{ from: 'NDA', to: 'NDA (2)' }]);
    expect(result.added).toEqual(['NDA (2)']);
  });

  it('collides on name case-insensitively', () => {
    const result = mergeTemplateStores(storeWith('NDA'), storeWith('nda'));
    expect(result.store.templates.map((t) => t.name)).toEqual(['NDA', 'nda (2)']);
  });

  it('re-mints a colliding id so both templates stay addressable', () => {
    const current = storeWith('Contract');
    const incoming = storeWith('NDA'); // storeWith reuses id "t0"
    const result = mergeTemplateStores(current, incoming);
    const ids = result.store.templates.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('leaves the existing templates and their items untouched', () => {
    const current = storeWith('Contract');
    const result = mergeTemplateStores(current, storeWith('NDA'));
    expect(result.store.templates[0]).toEqual(current.templates[0]);
  });
});

describe('templateItemFromField', () => {
  const field = {
    name: 'Signature1',
    type: 'Signature',
    required: true,
    page: 2,
    rect: { x: 72.4449, y: 120.5, width: 200.333, height: 60.0 },
  };

  it('captures the field exactly as it sits on the page', () => {
    expect(templateItemFromField(field, 'itm_new')).toEqual({
      id: 'itm_new',
      name: 'Signature1',
      type: 'signature',
      width: 200.33,
      height: 60,
      x: 72.44,
      y: 120.5,
      page: 2,
      required: true,
      multiline: false,
    });
  });

  it("maps pdf-lib's TextField onto the template's own type name", () => {
    expect(templateItemFromField({ ...field, type: 'TextField' }, 'i').type).toBe('text');
    expect(templateItemFromField({ ...field, type: 'Signature' }, 'i').type).toBe('signature');
  });

  it('captures the multiline flag for text fields but not signature fields', () => {
    expect(templateItemFromField({ ...field, type: 'TextField', multiline: true }, 'i').multiline).toBe(true);
    expect(templateItemFromField({ ...field, type: 'Signature', multiline: true }, 'i').multiline).toBe(false);
  });

  it('trims the name and treats a missing required flag as optional', () => {
    const item = templateItemFromField({ ...field, name: '  Sig  ', required: undefined }, 'i');
    expect(item.name).toBe('Sig');
    expect(item.required).toBe(false);
  });

  it('falls back to the type default for a rect that has no usable size', () => {
    const broken = { ...field, rect: { x: NaN, y: NaN, width: 0, height: -5 } };
    const item = templateItemFromField(broken, 'i');
    expect(item.width).toBe(1);
    expect(item.height).toBe(1);
    expect(item.x).toBe(0);
    expect(item.y).toBe(0);
  });

  it('clamps a negative page to the first one', () => {
    expect(templateItemFromField({ ...field, page: -3 }, 'i').page).toBe(0);
  });
});

describe('upsertTemplateItem', () => {
  it('appends an item whose name is new to the list', () => {
    const result = upsertTemplateItem([item({ id: 'a', name: 'Sig' })], item({ id: 'b', name: 'Date' }));
    expect(result.replaced).toBe(false);
    expect(result.items.map((i) => i.name)).toEqual(['Sig', 'Date']);
  });

  it('replaces the item of the same name in place, keeping its id', () => {
    const existing = [item({ id: 'a', name: 'Sig', x: 10 }), item({ id: 'b', name: 'Date' })];
    const result = upsertTemplateItem(existing, item({ id: 'fresh', name: 'Sig', x: 500 }));

    expect(result.replaced).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ id: 'a', name: 'Sig', x: 500 });
    expect(result.items[1].name).toBe('Date');
  });

  it('matches names case-sensitively, like PDF field names', () => {
    const result = upsertTemplateItem([item({ name: 'Sig' })], item({ id: 'b', name: 'sig' }));
    expect(result.replaced).toBe(false);
    expect(result.items).toHaveLength(2);
  });

  it('leaves the original list untouched', () => {
    const existing = [item({ id: 'a', name: 'Sig' })];
    upsertTemplateItem(existing, item({ id: 'b', name: 'Sig', x: 999 }));
    expect(existing[0].x).toBe(50);
  });

  it('tolerates a missing list', () => {
    expect(upsertTemplateItem(undefined as any, item()).items).toHaveLength(1);
  });
});
