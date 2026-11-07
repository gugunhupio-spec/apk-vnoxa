import path from 'node:path';

const positiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const clean = (value) => String(value ?? '').trim();

export const config = {
  port: positiveInt(process.env.PORT, 3000),
  dataDir: clean(process.env.DATA_DIR) || path.join(process.cwd(), 'data'),
  accessCode: clean(process.env.APP_ACCESS_CODE),
  limits: {
    siteBytes: positiveInt(process.env.MAX_SITE_MB, 20) * 1024 * 1024,
    logoBytes: positiveInt(process.env.MAX_LOGO_MB, 2) * 1024 * 1024,
    zipEntries: 3000,
    zipUncompressedBytes: 300 * 1024 * 1024,
  },
  github: {
    token: clean(process.env.GITHUB_TOKEN),
    owner: clean(process.env.GITHUB_OWNER),
    repo: clean(process.env.GITHUB_REPO),
    ref: clean(process.env.GITHUB_BUILD_REF),
    workflow: clean(process.env.GITHUB_WORKFLOW_FILE) || 'build-apk.yml',
  },
  build: {
    timeoutMs: positiveInt(process.env.BUILD_TIMEOUT_MIN, 30) * 60 * 1000,
    refreshThrottleMs: 2500,
  },
};

export function githubConfigured() {
  return Boolean(config.github.token && config.github.owner && config.github.repo);
}

export function missingGithubEnv() {
  const missing = [];
  if (!config.github.token) missing.push('GITHUB_TOKEN');
  if (!config.github.owner) missing.push('GITHUB_OWNER');
  if (!config.github.repo) missing.push('GITHUB_REPO');
  return missing;
}
