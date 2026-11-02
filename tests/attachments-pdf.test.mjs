import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAttachmentBuffer } from '../dist-electron/attachments/parse.js';

// Builds a one-page PDF with a correct xref table so pdfjs parses it without
// falling back to recovery mode.
function minimalPdf(text) {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

test('PDF attachments are parsed to page text with the bundled pdfjs', async () => {
  const buffer = minimalPdf('Hello AhaStation');
  const parsed = await parseAttachmentBuffer({
    name: 'hello.pdf',
    mime: 'application/pdf',
    sizeBytes: buffer.length,
    buffer,
  });
  assert.equal(parsed.kind, 'pdf');
  assert.match(parsed.text ?? '', /--- page 1 ---\nHello AhaStation/);
});

test('malformed PDF attachments fail with a named parse error', async () => {
  const buffer = Buffer.from('%PDF-1.4\nnot a pdf body', 'latin1');
  await assert.rejects(
    parseAttachmentBuffer({ name: 'broken.pdf', mime: 'application/pdf', sizeBytes: buffer.length, buffer }),
    /failed to parse pdf broken\.pdf/,
  );
});
