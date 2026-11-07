import yauzl from 'yauzl';

/**
 * yauzl menolak sendiri entri dengan path absolut / "../" / backslash.
 * Error tersebut dipetakan ke kode khusus agar bisa dijelaskan ke pengguna
 * sebagai masalah keamanan, bukan arsip rusak.
 */
function classifyZipError(error) {
  const message = String(error?.message ?? '');
  if (/invalid relative path|absolute path|invalid characters in fileName/i.test(message)) {
    const unsafe = new Error('ZIP mengandung entri dengan path tidak aman');
    unsafe.code = 'UNSAFE_ZIP_ENTRY';
    return unsafe;
  }
  return error;
}

/**
 * Membaca daftar entri ZIP tanpa mengekstrak isinya.
 * Dipakai untuk validasi keamanan (path traversal, zip bomb, enkripsi).
 */
export function readZipEntries(buffer, { maxEntries = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(new Error('ZIP tidak dapat dibaca'));
        return;
      }

      const entries = [];
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      zipfile.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(classifyZipError(err));
      });

      zipfile.on('entry', (entry) => {
        entries.push({
          name: entry.fileName,
          isDirectory: /\/$/.test(entry.fileName),
          encrypted: (entry.generalPurposeBitFlag & 0x1) !== 0,
          uncompressedSize: entry.uncompressedSize,
          compressedSize: entry.compressedSize,
        });

        if (entries.length >= maxEntries) {
          try {
            zipfile.close();
          } catch {
            /* diabaikan */
          }
          finish(entries);
          return;
        }
        zipfile.readEntry();
      });

      zipfile.on('end', () => finish(entries));
      zipfile.readEntry();
    });
  });
}

/**
 * Mengambil entri pertama yang cocok sebagai Buffer.
 */
export function extractFirstEntry(buffer, predicate, { maxBytes = 150 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(new Error('ZIP tidak dapat dibaca'));
        return;
      }

      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try {
          zipfile.close();
        } catch {
          /* diabaikan */
        }
        reject(err);
      };
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      zipfile.on('error', (err) => fail(classifyZipError(err)));
      zipfile.on('entry', (entry) => {
        if (settled) return;
        if (!predicate(entry.fileName)) {
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError || new Error('Gagal membaca isi ZIP'));
            return;
          }
          const chunks = [];
          let total = 0;
          stream.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
              stream.destroy(new Error('Isi file terlalu besar'));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('error', fail);
          stream.on('end', () => done({ name: entry.fileName, data: Buffer.concat(chunks) }));
        });
      });
      zipfile.on('end', () => done(null));
      zipfile.readEntry();
    });
  });
}
