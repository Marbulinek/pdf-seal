/** Anything the tree can show: plain JSON-shaped data. */
export type MetaValue = string | number | boolean | null | undefined | MetaValue[] | { [key: string]: MetaValue };
type MetaBranch = MetaValue[] | { [key: string]: MetaValue };

export function isExpandableMetaValue(value: MetaValue): value is MetaBranch {
  return value !== null && typeof value === 'object';
}

export function metaEntriesOf(node: MetaBranch): [string, MetaValue][] {
  return Array.isArray(node) ? node.map((v, i): [string, MetaValue] => [`[${i}]`, v]) : Object.entries(node);
}

/** Keeps only the branches/leaves whose key or value matches `term` (lower-cased). */
export function filterMetaTree(node: MetaBranch, term: string): MetaBranch {
  const out: MetaValue[] = [];
  const record: { [key: string]: MetaValue } = {};
  const isArrayNode = Array.isArray(node);
  for (const [key, value] of metaEntriesOf(node)) {
    const keyMatches = key.toLowerCase().includes(term);
    const put = (v: MetaValue) => (isArrayNode ? out.push(v) : (record[key] = v));
    if (isExpandableMetaValue(value)) {
      if (keyMatches) put(value);
      else {
        const child = filterMetaTree(value, term);
        if ((Array.isArray(child) ? child.length : Object.keys(child).length) > 0) put(child);
      }
    } else if (keyMatches || String(value).toLowerCase().includes(term)) {
      put(value);
    }
  }
  return isArrayNode ? out : record;
}
