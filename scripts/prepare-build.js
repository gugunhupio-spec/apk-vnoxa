import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Menyiapkan proyek Android dari template + input pengguna.
 * Dijalankan di dalam runner GitHub Actions sebelum Gradle build.
 *
 * Tanpa dependency npm: hanya Node.js core + utilitas OS (unzip, ImageMagick).
 */

const args = parseArgs(process.argv.slice(2));

const required = ['job-id', 'app-name', 'package', 'site', 'logo', 'out'];
for (const key of required) {
  if (!args[key]) {
    console.error(`Argumen --${key} wajib diisi.`);
    process.exit(1);
  }
}

const jobId = args['job-id'];
const appName = args['app-name'];
const packageName = args.package;
const sitePath = path.resolve(args.site);
const logoPath = path.resolve(args.logo);
const outDir = path.resolve(args.out);
const templateDir = path.resolve(args.template || 'android-template');
const entryHint = args.entry || null;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      result[key] = true;
    } else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function log(message) {
  console.log(`[prepare-build] ${message}`);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeJava(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Perintah gagal (${result.status}): ${command} ${commandArgs.join(' ')}`);
  }
}

function commandAvailable(command) {
  const result = spawnSync(command, ['-version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

/* ------------------------------------------------------------------ */
/* Ikon bawaan (tanpa file logo) — PNG murni Node.js                   */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Ikon brand APK V2NOXA: kotak gradien navy→biru dengan huruf V putih. */
function renderDefaultIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const strokeWidth = size * 0.085;
  const navy = [4, 9, 26];
  const blue = [46, 125, 255];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const cx = x + 0.5;
      const cy = y + 0.5;

      // Sudut membulat
      const dx = Math.max(radius - cx, 0, cx - (size - radius));
      const dy = Math.max(radius - cy, 0, cy - (size - radius));
      const cornerDistance = Math.hypot(dx, dy);
      let alpha = cornerDistance > radius ? 0 : cornerDistance > radius - 1 ? radius - cornerDistance : 1;
      if (alpha <= 0) continue;

      const t = Math.min(1, Math.max(0, (cx / size) * 0.45 + (cy / size) * 0.55));
      const eased = t * t * (3 - 2 * t);
      let r = Math.round(navy[0] + (blue[0] - navy[0]) * eased);
      let g = Math.round(navy[1] + (blue[1] - navy[1]) * eased);
      let b = Math.round(navy[2] + (blue[2] - navy[2]) * eased);

      // Huruf V
      const left = distanceToSegment(cx, cy, size * 0.24, size * 0.24, size * 0.5, size * 0.78);
      const right = distanceToSegment(cx, cy, size * 0.76, size * 0.24, size * 0.5, size * 0.78);
      const glyph = Math.min(left, right);
      const coverage = glyph <= strokeWidth ? 1 : glyph <= strokeWidth + 1 ? strokeWidth + 1 - glyph : 0;
      if (coverage > 0) {
        r = Math.round(r + (255 - r) * coverage);
        g = Math.round(g + (255 - g) * coverage);
        b = Math.round(b + (255 - b) * coverage);
      }

      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }

  return encodePng(size, size, rgba);
}

/* ------------------------------------------------------------------ */
/* Langkah build                                                       */
/* ------------------------------------------------------------------ */

const DENSITIES = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];

async function prepareProject() {
  log(`menyalin template dari ${templateDir}`);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.cp(templateDir, outDir, { recursive: true });

  const wwwDir = path.join(outDir, 'app', 'src', 'main', 'assets', 'www');
  await fs.mkdir(wwwDir, { recursive: true });

  if (sitePath.toLowerCase().endsWith('.zip')) {
    const tempExtract = await fs.mkdtemp(path.join(os.tmpdir(), 'v2noxa-zip-'));
    log('mengekstrak ZIP website');
    run('unzip', ['-q', '-o', sitePath, '-d', tempExtract, '-x', '__MACOSX/*', '*.DS_Store']);
    const base = await resolveSiteRoot(tempExtract, entryHint);
    log(`akar website: ${path.relative(tempExtract, base) || '.'}`);
    await fs.cp(base, wwwDir, { recursive: true });
    await fs.rm(tempExtract, { recursive: true, force: true });
  } else {
    log('menyalin file HTML sebagai index.html');
    await fs.copyFile(sitePath, path.join(wwwDir, 'index.html'));
  }

  if (!(await exists(path.join(wwwDir, 'index.html')))) {
    throw new Error('index.html tidak ditemukan setelah persiapan aset.');
  }

  await prepareIcons();

  log('mengganti placeholder nama aplikasi & package');
  const javaTemplate = path.join(outDir, 'app', 'src', 'main', 'java', 'com', 'v2noxa', 'webapp', 'MainActivity.java');
  const javaSource = await fs.readFile(javaTemplate, 'utf8');
  const javaTargetDir = path.join(outDir, 'app', 'src', 'main', 'java', ...packageName.split('.'));
  await fs.mkdir(javaTargetDir, { recursive: true });
  await fs.writeFile(
    path.join(javaTargetDir, 'MainActivity.java'),
    javaSource.replace(/__PACKAGE_NAME__/g, packageName),
    'utf8',
  );
  await fs.rm(path.join(outDir, 'app', 'src', 'main', 'java', 'com', 'v2noxa'), { recursive: true, force: true });

  const gradleFile = path.join(outDir, 'app', 'build.gradle');
  const gradleSource = await fs.readFile(gradleFile, 'utf8');
  await fs.writeFile(gradleFile, gradleSource.replace(/__PACKAGE_NAME__/g, packageName), 'utf8');

  const stringsFile = path.join(outDir, 'app', 'src', 'main', 'res', 'values', 'strings.xml');
  const stringsSource = await fs.readFile(stringsFile, 'utf8');
  await fs.writeFile(stringsFile, stringsSource.replace(/__APP_NAME__/g, escapeXml(appName)), 'utf8');

  await fs.writeFile(
    path.join(outDir, 'build-info.json'),
    JSON.stringify({ jobId, appName, packageName, entry: entryHint, preparedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );

  log('proyek Android siap dibangun');
}

async function resolveSiteRoot(extractDir, entry) {
  if (entry) {
    const normalized = entry.replace(/\\/g, '/');
    const index = normalized.toLowerCase().lastIndexOf('index.html');
    if (index >= 0) {
      const relativeDir = normalized.slice(0, index);
      const candidate = path.join(extractDir, relativeDir);
      if (await exists(path.join(candidate, 'index.html'))) return candidate;
    }
  }

  if (await exists(path.join(extractDir, 'index.html'))) return extractDir;

  const items = await fs.readdir(extractDir, { withFileTypes: true });
  const directories = items.filter((item) => item.isDirectory() && !item.name.startsWith('__'));
  for (const directory of directories) {
    const candidate = path.join(extractDir, directory.name);
    if (await exists(path.join(candidate, 'index.html'))) return candidate;
  }

  throw new Error('ZIP tidak memuat index.html pada struktur yang dikenali.');
}

async function prepareIcons() {
  const resDir = path.join(outDir, 'app', 'src', 'main', 'res');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v2noxa-icon-'));
  const converter = commandAvailable('magick') ? 'magick' : commandAvailable('convert') ? 'convert' : null;

  let sourceSquare = null;
  if (converter) {
    try {
      const square = path.join(tempDir, 'square.png');
      run(converter, [
        logoPath,
        '-auto-orient',
        '-resize',
        '1024x1024^',
        '-gravity',
        'center',
        '-extent',
        '1024x1024',
        '-alpha',
        'remove',
        '-alpha',
        'off',
        '-strip',
        square,
      ]);
      sourceSquare = square;
      log('logo pengguna disiapkan menjadi ikon persegi 1024×1024');
    } catch (error) {
      log(`konversi logo gagal, memakai ikon bawaan: ${error.message}`);
    }
  } else {
    log('ImageMagick tidak tersedia di runner, memakai ikon bawaan');
  }

  for (const [density, size] of DENSITIES) {
    const targetDir = path.join(resDir, `mipmap-${density}`);
    await fs.mkdir(targetDir, { recursive: true });
    const iconPath = path.join(targetDir, 'ic_launcher.png');
    const roundPath = path.join(targetDir, 'ic_launcher_round.png');

    if (sourceSquare) {
      try {
        run(converter, [sourceSquare, '-resize', `${size}x${size}`, iconPath]);
        await fs.copyFile(iconPath, roundPath);
        continue;
      } catch (error) {
        log(`resize ${density} gagal, memakai ikon bawaan: ${error.message}`);
      }
    }

    const png = renderDefaultIcon(size);
    await fs.writeFile(iconPath, png);
    await fs.writeFile(roundPath, png);
  }

  await fs.rm(tempDir, { recursive: true, force: true });
  log('ikon launcher dibuat untuk semua densitas');
}

try {
  await prepareProject();
} catch (error) {
  console.error(`[prepare-build] GAGAL: ${error.message}`);
  process.exit(1);
}
