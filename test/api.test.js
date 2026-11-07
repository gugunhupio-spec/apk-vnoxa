import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { buildJpeg, buildPng, buildZip } from './helpers/fixtures.js';

// Pastikan lingkungan uji tidak memiliki kredensial build nyata.
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'v2noxa-test-'));
process.env.DATA_DIR = tempDir;
delete process.env.GITHUB_TOKEN;
delete process.env.GITHUB_OWNER;
delete process.env.GITHUB_REPO;
delete process.env.GITHUB_BUILD_REF;
delete process.env.APP_ACCESS_CODE;

const { createApp } = await import('../src/app.js');
const { sanitizeAppName, sanitizePackageName, slugifyAppName, apkFileName } = await import('../src/validate.js');

const app = createApp({ disableRateLimit: true });
let server;
let baseUrl;

const HTML_DOC = '<!doctype html><html><head><title>Uji</title></head><body><h1>Halo</h1></body></html>';

function form({ site, siteName, siteType, logo, logoName, logoType, appName = 'Aplikasi Uji', packageName }) {
  const body = new FormData();
  body.set('appName', appName);
  if (packageName) body.set('packageName', packageName);
  if (site) body.set('site', new Blob([site], { type: siteType ?? 'text/html' }), siteName ?? 'index.html');
  if (logo) body.set('logo', new Blob([logo], { type: logoType ?? 'image/png' }), logoName ?? 'logo.png');
  return body;
}

async function postBuild(payload) {
  const response = await fetch(`${baseUrl}/api/build`, { method: 'POST', body: payload });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
});

describe('Halaman & konfigurasi', () => {
  test('halaman utama menampilkan brand APK V2NOXA', async () => {
    const response = await fetch(`${baseUrl}/`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /APK V2NOXA/);
    assert.match(html, /BUAT APK/i);
  });

  test('/api/config melaporkan kredensial build yang belum diset', async () => {
    const response = await fetch(`${baseUrl}/api/config`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.githubConfigured, false);
    assert.ok(body.missingEnv.includes('GITHUB_TOKEN'));
    assert.equal(body.accessCodeRequired, false);
    assert.equal(body.limits.maxSiteMb > 0, true);
  });

  test('/api/health tersedia', async () => {
    const body = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.equal(body.service, 'apk-v2noxa');
  });

  test('aset frontend dapat diakses', async () => {
    for (const asset of ['/styles.css', '/app.js', '/favicon.svg']) {
      const response = await fetch(`${baseUrl}${asset}`);
      assert.equal(response.status, 200, `${asset} harus tersedia`);
    }
  });
});

describe('Validasi upload website', () => {
  test('menolak permintaan tanpa file', async () => {
    const { status, body } = await postBuild(form({}));
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error.message, /wajib/i);
  });

  test('menolak ekstensi selain html/htm/zip', async () => {
    const { status, body } = await postBuild(
      form({ site: HTML_DOC, siteName: 'website.php', logo: buildPng(512, 512) }),
    );
    assert.equal(status, 400);
    assert.match(body.error.message, /Format file tidak didukung/i);
  });

  test('menolak file HTML yang bukan dokumen HTML', async () => {
    const { status, body } = await postBuild(
      form({ site: 'bukan html sama sekali', siteName: 'file.html', logo: buildPng(512, 512) }),
    );
    assert.equal(status, 400);
    assert.match(body.error.message, /HTML tidak valid/i);
  });

  test('menolak ZIP dengan path traversal', async () => {
    const zip = buildZip([
      { name: 'index.html', data: HTML_DOC },
      { name: '../../etc/passwd', data: 'jahat' },
    ]);
    const { status, body } = await postBuild(form({ site: zip, siteName: 'site.zip', logo: buildPng(512, 512) }));
    assert.equal(status, 400);
    assert.match(body.error.message, /path tidak aman/i);
  });

  test('menolak ZIP tanpa index.html', async () => {
    const zip = buildZip([
      { name: 'halaman.html', data: HTML_DOC },
      { name: 'aset/gambar.png', data: Buffer.from('x') },
    ]);
    const { status, body } = await postBuild(form({ site: zip, siteName: 'site.zip', logo: buildPng(512, 512) }));
    assert.equal(status, 400);
    assert.match(body.error.message, /index\.html/i);
  });

  test('menolak ZIP yang rusak', async () => {
    const { status, body } = await postBuild(
      form({ site: Buffer.from('PK\x03\x04rusak'), siteName: 'site.zip', logo: buildPng(512, 512) }),
    );
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  test('ZIP dengan index.html di dalam folder diterima validasinya', async () => {
    const zip = buildZip([
      { name: 'website/index.html', data: HTML_DOC },
      { name: 'website/aset/app.js', data: 'console.log(1)' },
    ]);
    const { status, body } = await postBuild(form({ site: zip, siteName: 'site.zip', logo: buildPng(512, 512) }));
    // Validasi lolos; permintaan berhenti di 503 karena kredensial build tidak ada di uji ini.
    assert.equal(status, 503);
    assert.equal(body.error.missingEnv.includes('GITHUB_TOKEN'), true);
  });
});

describe('Validasi logo & nama aplikasi', () => {
  test('menolak logo tanpa file', async () => {
    const { status, body } = await postBuild(form({ site: HTML_DOC }));
    assert.equal(status, 400);
    assert.match(body.error.message, /Logo aplikasi wajib/i);
  });

  test('menolak ekstensi logo yang tidak didukung', async () => {
    const { status, body } = await postBuild(
      form({ site: HTML_DOC, logo: buildPng(512, 512), logoName: 'logo.gif' }),
    );
    assert.equal(status, 400);
    assert.match(body.error.message, /Format logo tidak didukung/i);
  });

  test('menolak logo berukuran terlalu kecil', async () => {
    const { status, body } = await postBuild(
      form({ site: HTML_DOC, logo: buildPng(32, 32), logoName: 'logo.png' }),
    );
    assert.equal(status, 400);
    assert.match(body.error.message, /Resolusi logo terlalu kecil/i);
  });

  test('menolak berkas PNG yang bukan gambar valid', async () => {
    const { status, body } = await postBuild(
      form({ site: HTML_DOC, logo: Buffer.from('bukan png'), logoName: 'logo.png' }),
    );
    assert.equal(status, 400);
    assert.match(body.error.message, /bukan file PNG\/JPG/i);
  });

  test('menerima logo JPG valid', async () => {
    const { status, body } = await postBuild(
      form({ site: HTML_DOC, logo: buildJpeg(512, 512), logoName: 'logo.jpg', logoType: 'image/jpeg' }),
    );
    assert.equal(status, 503);
    assert.equal(body.error.missingEnv.length > 0, true);
  });

  test('menolak nama aplikasi terlalu pendek', async () => {
    const { status, body } = await postBuild(
      form({ site: HTML_DOC, logo: buildPng(512, 512), appName: 'A' }),
    );
    assert.equal(status, 400);
    assert.match(body.error.message, /minimal 2 karakter/i);
  });

  test('menolak nama paket tidak valid', async () => {
    const { status, body } = await postBuild(
      form({ site: HTML_DOC, logo: buildPng(512, 512), packageName: 'com.Bad-Package' }),
    );
    assert.equal(status, 400);
    assert.match(body.error.message, /Nama paket tidak valid/i);
  });
});

describe('Status build tidak pernah dipalsukan', () => {
  test('build tanpa kredensial mengembalikan 503, bukan sukses', async () => {
    const { status, body } = await postBuild(
      form({ site: HTML_DOC, logo: buildPng(512, 512), appName: 'Aplikasi Nyata' }),
    );
    assert.equal(status, 503);
    assert.equal(body.ok, false);
    assert.match(body.error.message, /belum dikonfigurasi/i);
    assert.equal(body.error.missingEnv.includes('GITHUB_TOKEN'), true);
    assert.equal(body.job, undefined);
  });

  test('job tidak valid ditolak, job tidak dikenal menghasilkan 404', async () => {
    const invalid = await fetch(`${baseUrl}/api/jobs/bukan-id`);
    assert.equal(invalid.status, 400);

    const unknown = await fetch(`${baseUrl}/api/jobs/${'a'.repeat(20)}`);
    assert.equal(unknown.status, 404);

    const download = await fetch(`${baseUrl}/api/jobs/${'a'.repeat(20)}/download`);
    assert.equal(download.status, 404);
  });

  test('endpoint API tidak dikenal mengembalikan 404 JSON', async () => {
    const response = await fetch(`${baseUrl}/api/tidak-ada`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.ok, false);
  });
});

describe('Sanitasi nama aplikasi & paket', () => {
  test('membersihkan karakter berbahaya dari nama aplikasi', () => {
    assert.equal(sanitizeAppName('  Toko <script>"Bunga"  '), 'Toko script Bunga');
    assert.throws(() => sanitizeAppName('x'), /minimal 2 karakter/);
    assert.throws(() => sanitizeAppName('a'.repeat(41)), /maksimal 40 karakter/);
  });

  test('membuat package name dari nama aplikasi', () => {
    assert.equal(sanitizePackageName('', 'Toko Bunga'), 'com.v2noxa.tokobunga');
    assert.equal(sanitizePackageName('id.toko.bunga', 'X'), 'id.toko.bunga');
    assert.equal(slugifyAppName('Aplikasi Keren!'), 'aplikasikeren');
  });

  test('nama file APK aman untuk diunduh', () => {
    assert.equal(apkFileName('Toko/Bunga: "Spesial"'), 'Toko_Bunga_ _Spesial_.apk');
  });
});
