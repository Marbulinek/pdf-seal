// Appends one classic-xref incremental update (a new /Info object plus its own
// xref/trailer/startxref/%%EOF) to a PDF, exactly as ISO 32000-1 7.5.6 describes.
// Shared by scripts/build-perf-fixtures.ts and the certificate-report tests.
export function appendClassicIncrement(bytes: Buffer, title: string): Buffer {
  const text = bytes.toString('latin1');

  const rootMatch = /\/Root\s+(\d+)\s+0\s+R/.exec(text);
  if (!rootMatch) throw new Error('fixture: no /Root reference found to carry forward');
  const rootRef = `${rootMatch[1]} 0 R`;

  const sizeMatches = [...text.matchAll(/\/Size\s+(\d+)/g)];
  if (!sizeMatches.length) throw new Error('fixture: no /Size found in any trailer');
  const prevSize = Math.max(...sizeMatches.map((m) => parseInt(m[1], 10)));

  const prevXrefMatch = [...text.matchAll(/startxref\s+(\d+)\s*%%EOF/g)].pop();
  if (!prevXrefMatch) throw new Error('fixture: no prior startxref/%%EOF to extend');
  const prevXrefOffset = parseInt(prevXrefMatch[1], 10);

  const infoObjNum = prevSize; // one past the previous highest object number
  const objOffset = bytes.length;
  const infoObj = `${infoObjNum} 0 obj\n<< /Title (${title}) /Producer (pdf-seal perf fixture) >>\nendobj\n`;
  const infoBuf = Buffer.from(infoObj, 'latin1');

  const xrefOffset = objOffset + infoBuf.length;
  const xrefEntry = `${String(objOffset).padStart(10, '0')} 00000 n \n`;
  if (xrefEntry.length !== 20) throw new Error('fixture: malformed xref entry width');

  const trailer =
    `xref\n${infoObjNum} 1\n${xrefEntry}` +
    `trailer\n<< /Size ${infoObjNum + 1} /Root ${rootRef} /Info ${infoObjNum} 0 R /Prev ${prevXrefOffset} >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.concat([bytes, infoBuf, Buffer.from(trailer, 'latin1')]);
}
