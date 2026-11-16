// Reads the text out of a Word .docx file with no dependencies.
// A .docx is a zip; the body lives in word/document.xml, stored raw or deflated.
import { inflateRawSync } from 'node:zlib';

export function docxText(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a .docx file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && buf.readUInt32LE(p) === 0x02014b50; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28); const extraLen = buf.readUInt16LE(p + 30); const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === 'word/document.xml') {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + size);
      return xmlToText((method === 0 ? raw : inflateRawSync(raw)).toString('utf8'));
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('no document body found in the .docx file');
}

function xmlToText(xml) {
  return xml
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:tc>/g, ' | ').replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\|\s*\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
