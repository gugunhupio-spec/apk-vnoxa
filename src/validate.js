import path from 'node:path';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { readZipEntries } from './zip.js';

const SITE_EXTENSIONS = new Set(['.html', '.htm', '.zip']);
const LOGO_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const MB = 1024 * 1024;

export function fileExtension(name) {
  return path.extname(String(name ?? '')).toLowerCase();
}

export function formatMb(bytes) {
  return `${Math.round((bytes / MB) * 10) / 10} MB`;
}

function isZipSignature(buffer) {
  if (buffer.length < 4) return false;
  return (
    (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) ||
    (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x05 && buffer[3] === 0x06) ||
    (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x07 && buffer[3] === 0x08)
  );
}

function normalizeEntryName(name) {
  return String(name).replace(/\\/g, '/');
}

function hasUnsafePath(name) {
  const normalized = normalizeEntryName(name);
  if (normalized.startsWith('/')) return true;
  if (/^[a-zA-Z]:/.test(normalized)) return true;
  return normalized.split('/').some((part) => part === '..');
}

/**
 * Validasi file website: .html, .htm, atau .zip (wajib memuat index.html).
 */
export async function validateSiteUpload(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new HttpError(400, 'File website wajib diunggah (HTML, HTM, atau ZIP).');
  }
  if (file.buffer.length > config.limits.siteBytes) {
    throw new HttpError(413, `Ukuran file website melebihi batas ${formatMb(config.limits.siteBytes)}.`);
  }

  const extension = fileExtension(file.originalname);
  if (!SITE_EXTENSIONS.has(extension)) {
    throw new HttpError(400, 'Format file tidak didukung. Gunakan file .html, .htm, atau .zip.');
  }

  if (extension === '.zip') {
    if (!isZipSignature(file.buffer)) {
      throw new HttpError(400, 'File ZIP rusak atau bukan arsip ZIP yang valid.');
    }

    let entries;
    try {
      entries = await readZipEntries(file.buffer, { maxEntries: config.limits.zipEntries + 1 });
    } catch (error) {
      if (error?.code === 'UNSAFE_ZIP_ENTRY') {
        throw new HttpError(400, 'ZIP mengandung path tidak aman (../ atau path absolut) dan ditolak.');
      }
      throw new HttpError(400, 'File ZIP tidak dapat dibaca. Pastikan arsip tidak rusak atau terenkripsi.');
    }

    const files = entries.filter((entry) => !entry.isDirectory);
    if (files.length === 0) {
      throw new HttpError(400, 'ZIP kosong. Masukkan minimal index.html beserta aset website Anda.');
    }
    if (files.length > config.limits.zipEntries) {
      throw new HttpError(400, `ZIP berisi terlalu banyak file (maksimal ${config.limits.zipEntries}).`);
    }
    if (entries.some((entry) => entry.encrypted)) {
      throw new HttpError(400, 'ZIP terenkripsi tidak didukung. Hapus kata sandi arsip lalu unggah ulang.');
    }
    if (entries.some((entry) => hasUnsafePath(entry.name))) {
      throw new HttpError(400, 'ZIP mengandung path tidak aman (../ atau path absolut) dan ditolak.');
    }

    const totalUncompressed = files.reduce((sum, entry) => sum + Math.max(0, entry.uncompressedSize), 0);
    if (totalUncompressed > config.limits.zipUncompressedBytes) {
      throw new HttpError(413, `Isi ZIP setelah ekstraksi terlalu besar (maksimal ${formatMb(config.limits.zipUncompressedBytes)}).`);
    }
    if (files.some((entry) => entry.uncompressedSize > 0 && entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 400)) {
      throw new HttpError(400, 'ZIP terdeteksi mencurigakan (rasio kompresi ekstrem) dan ditolak.');
    }

    const indexEntry = files.find((entry) => {
      const normalized = normalizeEntryName(entry.name).toLowerCase();
      const depth = normalized.split('/').length;
      return normalized === 'index.html' || (depth === 2 && normalized.endsWith('/index.html'));
    });
    if (!indexEntry) {
      throw new HttpError(400, 'ZIP harus berisi index.html (di root atau di dalam satu folder).');
    }

    return {
      kind: 'zip',
      extension: '.zip',
      entryCount: files.length,
      indexEntry: normalizeEntryName(indexEntry.name),
      totalUncompressed,
    };
  }

  const text = file.buffer.toString('utf8');
  if (!/<(?:!doctype\s+html|html|head|body|div|section|main|script|style)\b/i.test(text)) {
    throw new HttpError(400, 'File HTML tidak valid atau kosong. Pastikan file berisi struktur HTML.');
  }

  return { kind: 'html', extension, entryCount: 1 };
}

function readPngSize(buffer) {
  if (buffer.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < signature.length; index += 1) {
    if (buffer[index] !== signature[index]) return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readJpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * Validasi logo aplikasi: PNG/JPG asli (cek magic bytes) + dimensi minimal.
 */
export function validateLogoUpload(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new HttpError(400, 'Logo aplikasi wajib diunggah (PNG atau JPG) untuk dijadikan ikon APK.');
  }
  if (file.buffer.length > config.limits.logoBytes) {
    throw new HttpError(413, `Ukuran logo melebihi batas ${formatMb(config.limits.logoBytes)}.`);
  }

  const extension = fileExtension(file.originalname);
  if (!LOGO_EXTENSIONS.has(extension)) {
    throw new HttpError(400, 'Format logo tidak didukung. Gunakan file .png, .jpg, atau .jpeg.');
  }

  const png = readPngSize(file.buffer);
  const jpeg = png ? null : readJpegSize(file.buffer);
  const size = png || jpeg;
  if (!size) {
    throw new HttpError(400, 'Logo bukan file PNG/JPG yang valid.');
  }
  if (!size.width || !size.height) {
    throw new HttpError(400, 'Dimensi logo tidak dapat dibaca. Gunakan PNG atau JPG yang valid.');
  }
  if (size.width < 64 || size.height < 64) {
    throw new HttpError(400, 'Resolusi logo terlalu kecil. Gunakan minimal 64 × 64 piksel (disarankan 512 × 512).');
  }
  if (size.width > 4096 || size.height > 4096) {
    throw new HttpError(400, 'Resolusi logo terlalu besar. Maksimal 4096 × 4096 piksel.');
  }

  const normalizedExtension = extension === '.jpeg' ? '.jpg' : extension;
  return { kind: png ? 'png' : 'jpeg', extension: normalizedExtension, width: size.width, height: size.height };
}

/**
 * Membersihkan nama aplikasi agar aman untuk nama file & resource Android.
 */
export function sanitizeAppName(raw) {
  const source = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>&"'`\\/:*?|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (source.length < 2) {
    throw new HttpError(400, 'Nama aplikasi minimal 2 karakter.');
  }
  if (source.length > 40) {
    throw new HttpError(400, 'Nama aplikasi maksimal 40 karakter.');
  }
  return source;
}

export function apkFileName(appName) {
  const safe = String(appName)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return `${safe || 'Aplikasi'}.apk`;
}

export function slugifyAppName(appName) {
  const slug = String(appName)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24);
  return slug || 'aplikasi';
}

/**
 * Menghasilkan / memvalidasi applicationId Android.
 */
export function sanitizePackageName(raw, appName) {
  const provided = String(raw ?? '').trim();
  if (!provided) {
    return `com.v2noxa.${slugifyAppName(appName)}`;
  }
  if (provided.length > 100) {
    throw new HttpError(400, 'Nama paket maksimal 100 karakter.');
  }
  const segments = provided.split('.');
  const valid =
    segments.length >= 3 &&
    segments.every((segment) => /^[a-z][a-z0-9_]{0,29}$/.test(segment)) &&
    !/^(?:com|org|net|id|io|android|java|javax|kotlin)$/.test(segments[segments.length - 1] ?? '');

  if (!valid) {
    throw new HttpError(
      400,
      'Nama paket tidak valid. Gunakan format seperti com.perusahaan.aplikasi (huruf kecil, minimal 3 segmen).',
    );
  }
  return provided;
}
