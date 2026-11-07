import { config, githubConfigured, missingGithubEnv } from './config.js';
import { GithubError } from './errors.js';

const API_BASE = 'https://api.github.com';
const TIMEOUT_MS = 30_000;

function repoPath(suffix) {
  const owner = encodeURIComponent(config.github.owner);
  const repo = encodeURIComponent(config.github.repo);
  return `/repos/${owner}/${repo}${suffix}`;
}

function requireConfig() {
  if (!githubConfigured()) {
    throw new GithubError(503, 'Backend build APK belum dikonfigurasi di server ini.', {
      missingEnv: missingGithubEnv(),
      hint: 'Set GITHUB_TOKEN, GITHUB_OWNER, dan GITHUB_REPO pada environment server, lalu restart.',
    });
  }
}

function mapErrorStatus(status, payload) {
  const apiMessage = typeof payload?.message === 'string' ? payload.message : '';
  const lower = apiMessage.toLowerCase();

  if (status === 401) {
    return {
      status: 502,
      message: 'Token GitHub ditolak oleh GitHub API (401).',
      hint: 'Periksa kembali nilai GITHUB_TOKEN pada environment server.',
    };
  }
  if (status === 403 || status === 429) {
    if (lower.includes('rate limit')) {
      return {
        status: 503,
        message: 'Kuota GitHub API sedang habis (rate limit).',
        hint: 'Tunggu beberapa menit lalu coba lagi.',
      };
    }
    return {
      status: 502,
      message: 'Token GitHub tidak memiliki izin yang dibutuhkan (403).',
      hint: 'Fine-grained token perlu izin Actions: Read and write serta Contents: Read and write.',
    };
  }
  if (status === 404) {
    return {
      status: 502,
      message: 'Repo, branch, atau workflow build tidak ditemukan di GitHub (404).',
      hint: 'Pastikan GITHUB_OWNER, GITHUB_REPO, GITHUB_BUILD_REF, dan file .github/workflows/build-apk.yml sudah benar.',
    };
  }
  if (status === 422) {
    return {
      status: 502,
      message: 'GitHub menolak permintaan build (422).',
      hint: 'Biasanya karena input workflow tidak cocok dengan definisi di build-apk.yml.',
    };
  }
  return {
    status: 502,
    message: `GitHub API mengembalikan kesalahan ${status}.`,
    hint: apiMessage || 'Periksa log server dan konfigurasi GitHub.',
  };
}

async function request(pathOrUrl, { method = 'GET', body, accept, binary = false } = {}) {
  requireConfig();

  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${API_BASE}${pathOrUrl}`;
  const headers = {
    Authorization: `Bearer ${config.github.token}`,
    Accept: accept ?? 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'APK-V2NOXA/1.0',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new GithubError(502, 'Gagal menghubungi GitHub API dari server.', {
      hint: 'Periksa koneksi internet server lalu coba lagi.',
      cause: error?.message ?? String(error),
    });
  }

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const mapped = mapErrorStatus(response.status, payload);
    throw new GithubError(mapped.status, mapped.message, { hint: mapped.hint });
  }

  if (binary) return Buffer.from(await response.arrayBuffer());
  if (response.status === 204) return null;

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Menyimpan satu file ke repository melalui Contents API.
 * File inilah yang dibaca oleh workflow GitHub Actions.
 */
export async function commitFile({ filePath, buffer, message }) {
  const body = {
    message,
    content: buffer.toString('base64'),
  };
  if (config.github.ref) body.branch = config.github.ref;

  return request(repoPath(`/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`), {
    method: 'PUT',
    body,
  });
}

/**
 * Memicu workflow_dispatch pada repo build.
 */
export async function dispatchWorkflow(inputs) {
  const body = { inputs };
  if (config.github.ref) body.ref = config.github.ref;

  return request(repoPath(`/actions/workflows/${encodeURIComponent(config.github.workflow)}/dispatch`), {
    method: 'POST',
    body,
  });
}

/**
 * Mencari workflow run milik job tertentu (dicocokkan dari run-name).
 */
export async function findRunForJob(jobId) {
  const data = await request(
    repoPath(`/actions/workflows/${encodeURIComponent(config.github.workflow)}/runs?event=workflow_dispatch&per_page=30`),
  );
  const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
  return (
    runs.find((run) => {
      const title = `${run?.display_title ?? ''} ${run?.name ?? ''}`;
      return title.includes(jobId);
    }) ?? null
  );
}

export async function getRun(runId) {
  return request(repoPath(`/actions/runs/${encodeURIComponent(String(runId))}`));
}

export async function listRunArtifacts(runId) {
  const data = await request(repoPath(`/actions/runs/${encodeURIComponent(String(runId))}/artifacts?per_page=100`));
  return Array.isArray(data?.artifacts) ? data.artifacts : [];
}

export async function downloadArtifact(artifactId) {
  return request(repoPath(`/actions/artifacts/${encodeURIComponent(String(artifactId))}/zip`), {
    accept: 'application/vnd.github+json',
    binary: true,
  });
}

export async function repoInfo() {
  return request(repoPath(''));
}
