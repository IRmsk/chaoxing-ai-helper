import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createDeflateRaw } from 'node:zlib';

/**
 * 极简 zip 打包脚本（零依赖）。
 *
 * 用法：npm run build 之后执行 `npm run zip`，把 `dist/` 打成 `release/chaoxing-ai-helper-x.y.z.zip`，
 * 便于分发给其他同学直接拖入 `edge://extensions` 安装。
 */

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const RELEASE_DIR = join(ROOT, 'release');

/* ---------------- CRC32 ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------- 遍历 ---------------- */

async function walk(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(full)));
    else result.push(full);
  }
  return result;
}

/* ---------------- 主流程 ---------------- */

async function main() {
  if (!existsSync(DIST)) {
    console.error('未找到 dist/，请先执行 npm run build');
    process.exit(1);
  }

  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  await mkdir(RELEASE_DIR, { recursive: true });
  const outPath = join(RELEASE_DIR, `chaoxing-ai-helper-${pkg.version}.zip`);

  const files = await walk(DIST);
  const out = createWriteStream(outPath);
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = relative(DIST, file).split('\\').join('/');
    const data = await readFile(file);
    const compressed = await new Promise((res, rej) => {
      const deflate = createDeflateRaw();
      const chunks = [];
      deflate.on('data', (c) => chunks.push(c));
      deflate.on('end', () => res(Buffer.concat(chunks)));
      deflate.on('error', rej);
      deflate.end(data);
    });

    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const { mtime } = await stat(file);
    const dosTime = ((mtime.getHours() << 11) | (mtime.getMinutes() << 5) | (mtime.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((mtime.getFullYear() - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate()) & 0xffff;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    out.write(local);
    out.write(nameBuf);
    out.write(compressed);

    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(0, 8);
    centralEntry.writeUInt16LE(8, 10);
    centralEntry.writeUInt16LE(dosTime, 12);
    centralEntry.writeUInt16LE(dosDate, 14);
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(compressed.length, 20);
    centralEntry.writeUInt32LE(data.length, 24);
    centralEntry.writeUInt16LE(nameBuf.length, 28);
    centralEntry.writeUInt16LE(0, 30);
    centralEntry.writeUInt16LE(0, 32);
    centralEntry.writeUInt16LE(0, 34);
    centralEntry.writeUInt16LE(0, 36);
    centralEntry.writeUInt32LE(0, 38);
    centralEntry.writeUInt32LE(offset, 42);
    central.push({ header: centralEntry, name: nameBuf });

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralStart = offset;
  for (const entry of central) {
    out.write(entry.header);
    out.write(entry.name);
    offset += entry.header.length + entry.name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  out.write(end);

  await new Promise((res) => out.end(res));
  console.log(`已打包 ${files.length} 个文件 → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
