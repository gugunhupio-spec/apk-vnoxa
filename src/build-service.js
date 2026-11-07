import { config, githubConfigured } from './config.js';
import { GithubError, HttpError } from './errors.js';
import * as github from './github.js';
import { jobStore } from './jobs.js';
import { apkFileName } from './validate.js';
import { extractFirstEntry } from './zip.js';

const lastRefreshAt = new Map();
const inflightRefresh = new Map();

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required']);

function artifactName(jobId) {
  return `apk-${jobId}`;
}

function metaArtifactName(jobId) {
  return `meta-${jobId}`;
}

/**
 * Mengunggah input build ke repo lalu memicu workflow GitHub Actions.
 * Tidak ada status "berhasil" di sini — keberhasilan hanya ditentukan
 * setelah GitHub menyelesaikan build dan artifact APK benar-benar ada.
 */
export async function startBuild({ job, siteFile, siteInfo, logoFile, logoInfo }) {
  const sitePath = `builds/${job.id}/site${siteInfo.extension}`;
  const logoPath = `builds/${job.id}/logo${logoInfo.extension}`;

  await jobStore.update(job.id, { phase: 'mengunggah file ke repo build' });

  await github.commitFile({
    filePath: sitePath,
    buffer: siteFile.buffer,
    message: `build(${job.id}): input website`,
  });

  await github.commitFile({
    filePath: logoPath,
    buffer: logoFile.buffer,
    message: `build(${job.id}): logo aplikasi`,
  });

  await jobStore.update(job.id, { phase: 'mengirim pekerjaan ke GitHub Actions' });

  await github.dispatchWorkflow({
    job_id: job.id,
    app_name: job.appName,
    package_name: job.packageName,
    site_path: sitePath,
    logo_path: logoPath,
  });

  return jobStore.update(job.id, {
    status: 'queued',
    phase: 'menunggu antrean runner GitHub Actions',
    sitePath,
    logoPath,
  });
}

async function readMetaArtifact(runId, jobId) {
  const artifacts = await github.listRunArtifacts(runId);
  const meta = artifacts.find((item) => item?.name === metaArtifactName(jobId) && !item?.expired);
  if (!meta) return null;

  try {
    const zipBuffer = await github.downloadArtifact(meta.id);
    const entry = await extractFirstEntry(zipBuffer, (name) => name.toLowerCase().endsWith('apk-info.json'));
    if (!entry) return null;
    return JSON.parse(entry.data.toString('utf8'));
  } catch {
    return null;
  }
}

async function refreshInternal(job) {
  if (!githubConfigured()) return job;
  if (job.status === 'success' || job.status === 'failed') return job;

  let runId = job.runId;
  if (!runId) {
    const run = await github.findRunForJob(job.id);
    if (!run) {
      return jobStore.update(job.id, { phase: 'menunggu antrean runner GitHub Actions' });
    }
    runId = run.id;
    await jobStore.update(job.id, { runId: run.id, runUrl: run.html_url });
  }

  const run = await github.getRun(runId);
  const runUrl = run?.html_url ?? job.runUrl ?? null;

  if (run?.status === 'completed') {
    if (run.conclusion === 'success') {
      const artifacts = await github.listRunArtifacts(runId);
      const apkArtifact = artifacts.find((item) => item?.name === artifactName(job.id) && !item?.expired);

      if (!apkArtifact) {
        return jobStore.update(job.id, {
          status: 'failed',
          phase: 'selesai tanpa artifact',
          runUrl,
          error: 'Build selesai tetapi artifact APK tidak ditemukan atau sudah kedaluwarsa.',
          errorHint: 'Buka tautan log build di GitHub untuk memeriksa langkah upload artifact.',
        });
      }

      const meta = await readMetaArtifact(runId, job.id);
      const name = typeof meta?.apkName === 'string' && meta.apkName.endsWith('.apk') ? meta.apkName : apkFileName(job.appName);
      const size = Number.isFinite(meta?.sizeBytes) ? Number(meta.sizeBytes) : Number(apkArtifact.size_in_bytes) || null;

      return jobStore.update(job.id, {
        status: 'success',
        phase: 'APK berhasil dibuat',
        runUrl,
        apkName: name,
        apkSize: size,
        apkSha256: typeof meta?.sha256 === 'string' ? meta.sha256 : null,
        error: null,
        errorHint: null,
      });
    }

    const conclusion = String(run.conclusion ?? 'failure');
    return jobStore.update(job.id, {
      status: 'failed',
      phase: 'build gagal',
      runUrl,
      error: FAILED_CONCLUSIONS.has(conclusion)
        ? `Build APK gagal (${conclusion}).`
        : `Build APK tidak berhasil diselesaikan (${conclusion}).`,
      errorHint: 'Buka tautan log build di GitHub untuk melihat langkah Gradle yang gagal.',
    });
  }

  const phaseByStatus = {
    queued: 'antrean runner GitHub Actions',
    waiting: 'menunggu runner tersedia',
    requested: 'menunggu runner tersedia',
    pending: 'menunggu runner tersedia',
    in_progress: 'Gradle sedang membangun APK di cloud',
  };

  return jobStore.update(job.id, {
    status: 'building',
    phase: phaseByStatus[run?.status] ?? 'proses build berjalan',
    runUrl,
  });
}

/**
 * Menyegarkan status job dari GitHub (dengan throttle & anti-duplikasi).
 */
export async function refreshJob(job) {
  if (!job) return null;
  if (job.status === 'success' || job.status === 'failed') return job;
  if (!githubConfigured()) return job;

  const now = Date.now();
  const last = lastRefreshAt.get(job.id) ?? 0;
  if (now - last < config.build.refreshThrottleMs) return job;
  lastRefreshAt.set(job.id, now);

  if (inflightRefresh.has(job.id)) return inflightRefresh.get(job.id);

  const promise = refreshInternal(job)
    .catch((error) => {
      if (error instanceof HttpError) throw error;
      throw new GithubError(502, 'Gagal memeriksa status build di GitHub.', {
        hint: 'Coba muat ulang halaman beberapa saat lagi.',
      });
    })
    .finally(() => {
      inflightRefresh.delete(job.id);
    });

  inflightRefresh.set(job.id, promise);
  return promise;
}

/**
 * Mengambil file APK asli dari artifact build.
 */
export async function getApkFile(job) {
  if (!job?.runId) {
    throw new HttpError(409, 'Build belum menghasilkan APK.');
  }

  const artifacts = await github.listRunArtifacts(job.runId);
  const artifact = artifacts.find((item) => item?.name === artifactName(job.id) && !item?.expired);
  if (!artifact) {
    throw new HttpError(410, 'Artifact APK sudah tidak tersedia di GitHub (kedaluwarsa atau dihapus).');
  }

  const zipBuffer = await github.downloadArtifact(artifact.id);
  const entry = await extractFirstEntry(zipBuffer, (name) => name.toLowerCase().endsWith('.apk'));
  if (!entry || entry.data.length === 0) {
    throw new HttpError(502, 'Artifact build tidak berisi file .apk.');
  }

  return {
    name: job.apkName && job.apkName.endsWith('.apk') ? job.apkName : apkFileName(job.appName),
    data: entry.data,
  };
}
