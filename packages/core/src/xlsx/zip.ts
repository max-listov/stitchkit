/**
 * The ZIP container an XLSX is: deflated entries, no directories, no extras.
 *
 * Written here rather than taken from a library because the package has one
 * runtime dependency and this format needs about a hundred lines. Compression
 * goes through the platform's `CompressionStream`. Entry times are the format's
 * epoch, so the same workbook always produces the same bytes.
 */

const DOS_EPOCH_DATE = 0x21;
const VERSION = 20;
const UTF8_NAMES = 0x800;
const DEFLATE = 8;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface FieldWriter {
  u16(value: number): void;
  u32(value: number): void;
  bytes(value: Uint8Array): void;
}

function record(length: number, write: (fields: FieldWriter) => void): Uint8Array {
  const buffer = new Uint8Array(length);
  const view = new DataView(buffer.buffer);
  let offset = 0;
  write({
    u16(value) {
      view.setUint16(offset, value, true);
      offset += 2;
    },
    u32(value) {
      view.setUint32(offset, value, true);
      offset += 4;
    },
    bytes(value) {
      buffer.set(value, offset);
      offset += value.byteLength;
    },
  });
  return buffer;
}

export async function zip(
  entries: readonly { readonly name: string; readonly content: string }[],
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const content = encoder.encode(entry.content);
    const compressed = await deflate(content);
    const crc = crc32(content);
    const common = (fields: FieldWriter): void => {
      fields.u16(VERSION);
      fields.u16(UTF8_NAMES);
      fields.u16(DEFLATE);
      fields.u16(0);
      fields.u16(DOS_EPOCH_DATE);
      fields.u32(crc);
      fields.u32(compressed.byteLength);
      fields.u32(content.byteLength);
      fields.u16(name.byteLength);
      fields.u16(0);
    };
    const local = record(30 + name.byteLength, (fields) => {
      fields.u32(0x04034b50);
      common(fields);
      fields.bytes(name);
    });
    directory.push(
      record(46 + name.byteLength, (fields) => {
        fields.u32(0x02014b50);
        fields.u16(VERSION);
        common(fields);
        fields.u16(0);
        fields.u16(0);
        fields.u16(0);
        fields.u32(0);
        fields.u32(offset);
        fields.bytes(name);
      }),
    );
    parts.push(local, compressed);
    offset += local.byteLength + compressed.byteLength;
  }
  const directorySize = directory.reduce((total, part) => total + part.byteLength, 0);
  const end = record(22, (fields) => {
    fields.u32(0x06054b50);
    fields.u16(0);
    fields.u16(0);
    fields.u16(entries.length);
    fields.u16(entries.length);
    fields.u32(directorySize);
    fields.u32(offset);
    fields.u16(0);
  });
  const all = [...parts, ...directory, end];
  const bytes = new Uint8Array(all.reduce((total, part) => total + part.byteLength, 0));
  let position = 0;
  for (const part of all) {
    bytes.set(part, position);
    position += part.byteLength;
  }
  return bytes;
}
