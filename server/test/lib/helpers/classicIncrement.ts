// Appends one classic-xref incremental update (new or rewritten objects plus
// their own xref/trailer/startxref/%%EOF) to a PDF, exactly as ISO 32000-1
// 7.5.6 describes. Shared by scripts/build-perf-fixtures.ts and the
// certificate-report tests.

/**
 * One object in an increment: `num` rewrites that existing object (a new
 * version of it in the later revision); without `num` the object is new and
 * takes the next free number. `body` is everything between `obj` and `endobj`.
 */
export interface IncrementObject {
  num?: number;
  body: string;
}

/** The number the first new object in the next increment of `bytes` will get. */
export function nextObjectNumber(bytes: Buffer): number {
  const sizeMatches = [...bytes.toString('latin1').matchAll(/\/Size\s+(\d+)/g)];
  if (!sizeMatches.length) throw new Error('fixture: no /Size found in any trailer');
  return Math.max(...sizeMatches.map((m) => parseInt(m[1], 10)));
}

export function appendIncrement(bytes: Buffer, objects: IncrementObject[], extraTrailer = ''): Buffer {
  const text = bytes.toString('latin1');

  const rootMatch = /\/Root\s+(\d+)\s+0\s+R/.exec(text);
  if (!rootMatch) throw new Error('fixture: no /Root reference found to carry forward');
  const rootRef = `${rootMatch[1]} 0 R`;

  const prevXrefMatch = [...text.matchAll(/startxref\s+(\d+)\s*%%EOF/g)].pop();
  if (!prevXrefMatch) throw new Error('fixture: no prior startxref/%%EOF to extend');
  const prevXrefOffset = parseInt(prevXrefMatch[1], 10);

  let nextNew = nextObjectNumber(bytes);
  let offset = bytes.length;
  const written: Array<{ num: number; offset: number }> = [];
  const chunks: Buffer[] = [];
  for (const object of objects) {
    const num = object.num ?? nextNew++;
    const chunk = Buffer.from(`${num} 0 obj\n${object.body}\nendobj\n`, 'latin1');
    written.push({ num, offset });
    chunks.push(chunk);
    offset += chunk.length;
  }

  // One xref subsection per object keeps this simple and is perfectly legal.
  const xref = written
    .sort((a, b) => a.num - b.num)
    .map(({ num, offset: at }) => {
      const entry = `${String(at).padStart(10, '0')} 00000 n \n`;
      if (entry.length !== 20) throw new Error('fixture: malformed xref entry width');
      return `${num} 1\n${entry}`;
    })
    .join('');
  const size = Math.max(nextNew, ...written.map((w) => w.num + 1));
  const trailer =
    `xref\n${xref}` +
    `trailer\n<< /Size ${size} /Root ${rootRef} /Prev ${prevXrefOffset}${extraTrailer} >>\n` +
    `startxref\n${offset}\n%%EOF\n`;

  return Buffer.concat([bytes, ...chunks, Buffer.from(trailer, 'latin1')]);
}

/** One increment adding a new /Info object. */
export function appendClassicIncrement(bytes: Buffer, title: string): Buffer {
  const infoObjNum = nextObjectNumber(bytes);
  return appendIncrement(
    bytes,
    [{ body: `<< /Title (${title}) /Producer (pdf-seal perf fixture) >>` }],
    ` /Info ${infoObjNum} 0 R`,
  );
}
