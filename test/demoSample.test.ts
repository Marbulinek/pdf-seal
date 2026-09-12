// Guards the bundled Help-tour sample document (public/assets/demo/pdf-seal-sample.pdf)
// against silently rotting when lib/PdfSignatureTool.ts's field/metadata/revision-chain
// shape changes. If this fails, regenerate the sample with `npm run build:demo-sample`
// and confirm the change was intentional.

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import PdfSignatureTool from '../lib/PdfSignatureTool';
import { buildCertificateReport } from '../lib/PdfCertificateReport';

const SAMPLE_PATH = path.join(__dirname, '..', 'public', 'assets', 'demo', 'pdf-seal-sample.pdf');

let bytes: Uint8Array;

beforeAll(() => {
  bytes = fs.readFileSync(SAMPLE_PATH);
});

describe('bundled demo sample document', () => {
  it('embeds a three-entry revision chain', async () => {
    const tool = await PdfSignatureTool.fromBytes(bytes);
    const chain = tool.getRevisionSnapshotChain();
    expect(chain).toHaveLength(3);
  });

  it('has the four demo fields, with only Provider_Signature signed', async () => {
    const tool = await PdfSignatureTool.fromBytes(bytes);
    const fields = tool.listFields();
    const byName = Object.fromEntries(fields.map((f: any) => [f.name, f]));

    expect(Object.keys(byName).sort()).toEqual(
      ['Client_Name', 'Client_Signature', 'Provider_Signature', 'Signing_Date'].sort(),
    );
    expect(byName.Provider_Signature.signed).toBe(true);
    expect(byName.Client_Signature.signed).toBe(false);
  });

  it('has a valid signature backed by a three-certificate chain', async () => {
    const report = await buildCertificateReport(bytes);
    const signature = report.signatures.find((s: any) => s.fieldName === 'Provider_Signature');
    expect(signature).toBeDefined();
    expect(signature!.status).not.toBe('fail');

    const chain = report.chains.find((c) => c.signatureFieldName === 'Provider_Signature');
    expect(chain).toBeDefined();
    expect(chain!.certificateIds).toHaveLength(3);
    expect(chain!.complete).toBe(true);
  });
});
