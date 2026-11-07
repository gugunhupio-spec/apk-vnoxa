import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PUBLIC_FIELDS = [
  'id',
  'appName',
  'packageName',
  'siteFileName',
  'siteKind',
  'logoFileName',
  'status',
  'phase',
  'createdAt',
  'updatedAt',
  'runUrl',
  'runId',
  'apkName',
  'apkSize',
  'apkSha256',
  'error',
  'errorHint',
];

/**
 * Penyimpanan status job build.
 *
 * Status tidak bergantung pada file ini saja: bila server restart, status
 * dipulihkan langsung dari GitHub Actions berdasarkan ID job yang tertanam
 * pada nama workflow run.
 */
export class JobStore {
  #file;
  #jobs = new Map();
  #loaded = false;
  #writing = Promise.resolve();

  constructor(directory = config.dataDir) {
    this.#file = path.join(directory, 'jobs.json');
  }

  async #ensureLoaded() {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const raw = await fs.readFile(this.#file, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const job of parsed) {
          if (job && typeof job.id === 'string') this.#jobs.set(job.id, job);
        }
      }
    } catch {
      /* file belum ada — mulai dari kosong */
    }
  }

  async #persist() {
    const snapshot = [...this.#jobs.values()].filter((job) => Date.now() - job.createdAt < JOB_TTL_MS);
    const payload = JSON.stringify(snapshot);
    this.#writing = this.#writing
      .then(async () => {
        await fs.mkdir(path.dirname(this.#file), { recursive: true });
        const temp = `${this.#file}.${process.pid}.tmp`;
        await fs.writeFile(temp, payload, 'utf8');
        await fs.rename(temp, this.#file);
      })
      .catch(() => {
        /* kegagalan tulis tidak boleh menggagalkan request */
      });
    return this.#writing;
  }

  async create(fields) {
    await this.#ensureLoaded();
    const now = Date.now();
    const job = {
      id: crypto.randomBytes(10).toString('hex'),
      status: 'queued',
      phase: 'menyiapkan',
      createdAt: now,
      updatedAt: now,
      runId: null,
      runUrl: null,
      apkName: null,
      apkSize: null,
      apkSha256: null,
      error: null,
      errorHint: null,
      ...fields,
    };
    this.#jobs.set(job.id, job);
    await this.#persist();
    return job;
  }

  async get(id) {
    await this.#ensureLoaded();
    return this.#jobs.get(id) ?? null;
  }

  async update(id, patch) {
    await this.#ensureLoaded();
    const current = this.#jobs.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.#jobs.set(id, next);
    await this.#persist();
    return next;
  }

  async remove(id) {
    await this.#ensureLoaded();
    const existed = this.#jobs.delete(id);
    if (existed) await this.#persist();
    return existed;
  }

  publicView(job) {
    if (!job) return null;
    const view = {};
    for (const field of PUBLIC_FIELDS) view[field] = job[field] ?? null;
    view.canDownload = job.status === 'success' && Boolean(job.runId);
    view.downloadUrl = view.canDownload ? `/api/jobs/${job.id}/download` : null;
    view.elapsedMs = Math.max(0, (job.updatedAt ?? Date.now()) - (job.createdAt ?? Date.now()));
    return view;
  }
}

export const jobStore = new JobStore();
