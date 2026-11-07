import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import multer from 'multer';
import { getApkFile, refreshJob, startBuild } from './build-service.js';
import { config, githubConfigured, missingGithubEnv } from './config.js';
import { HttpError } from './errors.js';
import { jobStore } from './jobs.js';
import {
  formatMb,
  sanitizeAppName,
  sanitizePackageName,
  validateLogoUpload,
  validateSiteUpload,
} from './validate.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(currentDir, '..', 'public');

const JOB_ID_PATTERN = /^[a-f0-9]{20}$/;

function cleanFileName(name) {
  const base = path.basename(String(name ?? 'file'));
  return base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 90) || 'file';
}

function accessCodeMatches(provided) {
  if (!config.accessCode) return true;
  const expected = Buffer.from(config.accessCode, 'utf8');
  const actual = Buffer.from(String(provided ?? ''), 'utf8');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export function createApp({ disableRateLimit = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", 'https://fonts.googleapis.com'],
          fontSrc: ['https://fonts.gstatic.com', "'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: null,
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '64kb' }));

  const apiLimiter = disableRateLimit
    ? (req, res, next) => next()
    : rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 400,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { ok: false, error: { message: 'Terlalu banyak permintaan. Coba lagi beberapa saat lagi.' } },
      });

  const buildLimiter = disableRateLimit
    ? (req, res, next) => next()
    : rateLimit({
        windowMs: 60 * 60 * 1000,
        limit: Number.parseInt(process.env.BUILD_RATE_LIMIT_MAX ?? '10', 10) || 10,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: {
          ok: false,
          error: { message: 'Batas jumlah build per jam tercapai. Silakan coba lagi nanti.' },
        },
      });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: Math.max(config.limits.siteBytes, config.limits.logoBytes),
      files: 2,
      fields: 8,
      parts: 12,
    },
  });

  const requireAccessCode = (req, res, next) => {
    if (accessCodeMatches(req.get('x-access-code'))) return next();
    return next(new HttpError(401, 'Kode akses salah atau belum diisi.'));
  };

  app.use('/api', apiLimiter);
  app.use(express.static(publicDir, { extensions: ['html'], maxAge: '1h', index: 'index.html' }));

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      service: 'apk-v2noxa',
      githubConfigured: githubConfigured(),
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.get('/api/config', (req, res) => {
    res.json({
      ok: true,
      githubConfigured: githubConfigured(),
      missingEnv: githubConfigured() ? [] : missingGithubEnv(),
      accessCodeRequired: Boolean(config.accessCode),
      limits: {
        maxSiteMb: Math.round(config.limits.siteBytes / (1024 * 1024)),
        maxLogoMb: Math.round(config.limits.logoBytes / (1024 * 1024)),
        maxZipEntries: config.limits.zipEntries,
      },
      buildTarget: githubConfigured()
        ? {
            owner: config.github.owner,
            repo: config.github.repo,
            ref: config.github.ref || 'default branch',
            workflow: config.github.workflow,
          }
        : null,
    });
  });

  app.post(
    '/api/build',
    requireAccessCode,
    buildLimiter,
    upload.fields([
      { name: 'site', maxCount: 1 },
      { name: 'logo', maxCount: 1 },
    ]),
    async (req, res) => {
      const siteFile = req.files?.site?.[0];
      const logoFile = req.files?.logo?.[0];

      const appName = sanitizeAppName(req.body?.appName);
      const packageName = sanitizePackageName(req.body?.packageName, appName);
      const siteInfo = await validateSiteUpload(siteFile);
      const logoInfo = validateLogoUpload(logoFile);

      if (!githubConfigured()) {
        throw new HttpError(503, 'Backend build APK belum dikonfigurasi di server ini.', {
          missingEnv: missingGithubEnv(),
          hint: 'Tambahkan variabel environment tersebut pada server (lihat README.md bagian Konfigurasi) lalu restart.',
        });
      }

      const job = await jobStore.create({
        appName,
        packageName,
        siteFileName: cleanFileName(siteFile.originalname),
        siteKind: siteInfo.kind,
        siteEntry: siteInfo.indexEntry ?? 'index.html',
        logoFileName: cleanFileName(logoFile.originalname),
        logoSize: `${logoInfo.width}x${logoInfo.height}`,
      });

      try {
        const updated = await startBuild({ job, siteFile, siteInfo, logoFile, logoInfo });
        res.status(202).json({ ok: true, job: jobStore.publicView(updated) });
      } catch (error) {
        await jobStore.update(job.id, {
          status: 'failed',
          phase: 'gagal memulai build',
          error: error instanceof HttpError ? error.message : 'Gagal memulai build di GitHub Actions.',
          errorHint: error?.details?.hint ?? null,
        });
        throw error;
      }
    },
  );

  app.get('/api/jobs/:id', async (req, res) => {
    const { id } = req.params;
    if (!JOB_ID_PATTERN.test(id)) throw new HttpError(400, 'ID build tidak valid.');

    const job = await jobStore.get(id);
    if (!job) {
      throw new HttpError(404, 'Data build tidak ditemukan. Mulai build baru untuk membuat APK.');
    }

    let current = job;
    if (job.status !== 'success' && job.status !== 'failed') {
      current = await refreshJob(job);
    }
    res.json({ ok: true, job: jobStore.publicView(current) });
  });

  app.get('/api/jobs/:id/download', async (req, res) => {
    const { id } = req.params;
    if (!JOB_ID_PATTERN.test(id)) throw new HttpError(400, 'ID build tidak valid.');

    const job = await jobStore.get(id);
    if (!job) throw new HttpError(404, 'Data build tidak ditemukan.');

    let current = job;
    if (job.status !== 'success' && job.status !== 'failed') {
      current = await refreshJob(job);
    }
    if (current.status !== 'success') {
      throw new HttpError(409, 'APK belum siap diunduh karena build belum berhasil.');
    }

    const apk = await getApkFile(current);
    const asciiName = apk.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(apk.name)}`,
    );
    res.setHeader('Content-Length', String(apk.data.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-APK-SHA256', current.apkSha256 ?? '');
    res.end(apk.data);
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ ok: false, error: { message: 'Endpoint API tidak ditemukan.' } });
  });

  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
      const message =
        error.code === 'LIMIT_FILE_SIZE'
          ? `Ukuran file melebihi batas. Maksimal ${formatMb(config.limits.siteBytes)} untuk file website dan ${formatMb(config.limits.logoBytes)} untuk logo.`
          : 'Upload ditolak: ' + error.message;
      res.status(413).json({ ok: false, error: { message } });
      return;
    }

    const status = error instanceof HttpError ? error.status : 500;
    const message =
      error instanceof HttpError ? error.message : 'Terjadi kesalahan pada server saat memproses permintaan.';

    if (status >= 500) {
      console.error('[apk-v2noxa]', error?.name ?? 'Error', '-', error?.message ?? error);
    }

    res.status(status).json({
      ok: false,
      error: {
        message,
        ...(error?.details && typeof error.details === 'object' ? error.details : {}),
      },
    });
  });

  return app;
}
