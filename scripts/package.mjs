import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  artifactsDir,
  buildConfig,
  ensureDir,
  extensionOutputDir,
  listFiles,
  removeKnownDir,
  targets,
} from './common.mjs';

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { dosTime, dosDate };
}

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0);
  return b;
}

function zipDirectory(sourceDir, outFile) {
  const files = listFiles(sourceDir);
  const allowed = [...buildConfig.extensionFiles].sort();
  if (JSON.stringify(files) !== JSON.stringify(allowed)) {
    throw new Error(`${path.relative(process.cwd(), sourceDir)} contains unexpected files: ${files.join(', ')}`);
  }
  const chunks = [];
  const central = [];
  let offset = 0;
  const stamp = dosDateTime(new Date(Date.UTC(2024, 0, 1, 0, 0, 0)));

  for (const name of files) {
    if (path.isAbsolute(name) || name.split('/').includes('..')) {
      throw new Error(`Refusing unsafe ZIP entry path: ${name}`);
    }
    const data = fs.readFileSync(path.join(sourceDir, name));
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(8), u16(stamp.dosTime), u16(stamp.dosDate),
      u32(crc), u32(compressed.length), u32(data.length), u16(nameBuf.length), u16(0), nameBuf,
    ]);
    chunks.push(local, compressed);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(stamp.dosTime), u16(stamp.dosDate),
      u32(crc), u32(compressed.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]));
    offset += local.length + compressed.length;
  }

  const centralOffset = offset;
  const centralData = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralData.length), u32(centralOffset), u16(0),
  ]);
  ensureDir(path.dirname(outFile));
  fs.writeFileSync(outFile, Buffer.concat([...chunks, centralData, end]));
}

removeKnownDir('artifacts');
ensureDir(artifactsDir);

for (const target of targets) {
  const sourceDir = extensionOutputDir(target);
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Missing ${sourceDir}. Run npm run build first.`);
  }
  const outFile = path.join(artifactsDir, `${buildConfig.name}-${buildConfig.version}-${target}.zip`);
  zipDirectory(sourceDir, outFile);
  console.log(`Created ${path.relative(process.cwd(), outFile)}`);
}
