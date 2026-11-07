/* ============================================================
   APK V2NOXA — logika frontend
   Semua status berasal dari backend (data GitHub Actions nyata).
   ============================================================ */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    form: $('buildForm'),
    formHint: $('formHint'),
    configBanner: $('configBanner'),
    siteDrop: $('siteDrop'),
    siteInput: $('siteInput'),
    siteFileChip: $('siteFileChip'),
    siteFileName: $('siteFileName'),
    siteFileSize: $('siteFileSize'),
    siteRemove: $('siteRemove'),
    logoDrop: $('logoDrop'),
    logoInput: $('logoInput'),
    logoPreviewRow: $('logoPreviewRow'),
    logoThumb: $('logoThumb'),
    logoName: $('logoName'),
    logoMeta: $('logoMeta'),
    logoRemove: $('logoRemove'),
    appName: $('appName'),
    charCount: $('charCount'),
    packageInput: $('packageInput'),
    accessCodeField: $('accessCodeField'),
    accessCodeInput: $('accessCodeInput'),
    submitBtn: $('submitBtn'),
    submitLabel: $('submitLabel'),
    uploadProgress: $('uploadProgress'),
    uploadBar: $('uploadBar'),
    uploadLabel: $('uploadLabel'),
    statusPill: $('statusPill'),
    statusPillText: $('statusPillText'),
    statusEmpty: $('statusEmpty'),
    statusBody: $('statusBody'),
    jobIdText: $('jobIdText'),
    jobElapsed: $('jobElapsed'),
    timeline: $('timeline'),
    phaseText: $('phaseText'),
    phaseLabel: $('phaseLabel'),
    resultCard: $('resultCard'),
    resultIcon: $('resultIcon'),
    resultName: $('resultName'),
    resultSize: $('resultSize'),
    resultStatus: $('resultStatus'),
    resultHash: $('resultHash'),
    downloadBtn: $('downloadBtn'),
    errorBox: $('errorBox'),
    errorTitle: $('errorTitle'),
    errorText: $('errorText'),
    errorHint: $('errorHint'),
    runLink: $('runLink'),
    resetBtn: $('resetBtn'),
    toasts: $('toasts'),
    heroIcon: $('heroIcon'),
    heroAppName: $('heroAppName'),
  };

  const DEFAULT_ICON = '/favicon.svg';
  const STORAGE_JOB = 'v2noxa.jobId';
  const STORAGE_NAME = 'v2noxa.appName';
  const POLL_MIN_MS = 4000;
  const POLL_MAX_MS = 12000;

  const state = {
    config: null,
    siteFile: null,
    logoFile: null,
    logoObjectUrl: null,
    job: null,
    pollTimer: null,
    tickTimer: null,
    pollDelay: POLL_MIN_MS,
    busy: false,
  };

  /* ---------------- Util ---------------- */

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '—';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.round(Number(ms) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
  }

  const ICONS = {
    error:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
    success:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>',
    info:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
    warn:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>',
  };

  function toast(message, kind = 'info') {
    if (!el.toasts) return;
    const node = document.createElement('div');
    node.className = `toast${kind === 'error' ? ' is-error' : kind === 'success' ? ' is-success' : ''}`;
    node.innerHTML = `${ICONS[kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'info']}<span></span>`;
    node.querySelector('span').textContent = message;
    el.toasts.appendChild(node);
    setTimeout(() => {
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 260);
    }, 5200);
  }

  function setBusy(busy) {
    state.busy = busy;
    el.submitBtn.disabled = busy || !state.config?.githubConfigured;
    el.submitLabel.textContent = busy ? 'MEMPROSES…' : 'BUAT APK';
    let spinner = el.submitBtn.querySelector('.spinner');
    if (busy && !spinner) {
      spinner = document.createElement('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');
      el.submitBtn.prepend(spinner);
    } else if (!busy && spinner) {
      spinner.remove();
    }
  }

  function setProgress(percent, label) {
    el.uploadProgress.classList.add('is-visible');
    el.uploadBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    el.uploadLabel.textContent = label ?? `Mengunggah ${Math.round(percent)}%`;
  }

  function hideProgress() {
    el.uploadProgress.classList.remove('is-visible');
    el.uploadBar.style.width = '0%';
  }

  /* ---------------- Config ---------------- */

  async function loadConfig() {
    try {
      const response = await fetch('/api/config', { headers: { accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error('Konfigurasi server tidak dapat dibaca.');
      state.config = data;
    } catch {
      state.config = {
        githubConfigured: false,
        missingEnv: ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO'],
        accessCodeRequired: false,
        limits: { maxSiteMb: 20, maxLogoMb: 2, maxZipEntries: 3000 },
        buildTarget: null,
      };
      toast('Gagal menghubungi server. Periksa koneksi Anda.', 'error');
    }

    if (state.config.accessCodeRequired) {
      el.accessCodeField.hidden = false;
    }

    if (!state.config.githubConfigured) {
      const envList = (state.config.missingEnv || [])
        .map((name) => `<code>${name}</code>`)
        .join(' ');
      el.configBanner.hidden = false;
      el.configBanner.innerHTML = `
        <div class="alert alert-warn">
          ${ICONS.warn}
          <div>
            <strong>Build cloud belum dikonfigurasi di server ini</strong>
            Tambahkan variabel lingkungan ${envList} pada server, lalu restart. Selama belum diisi,
            tombol BUAT APK dinonaktifkan agar tidak ada status build palsu.
          </div>
        </div>`;
    }

    el.submitBtn.disabled = !state.config.githubConfigured;
  }

  /* ---------------- File handling ---------------- */

  function validateSiteFile(file) {
    const maxMb = state.config?.limits?.maxSiteMb ?? 20;
    const extension = (file.name.split('.').pop() || '').toLowerCase();
    if (!['html', 'htm', 'zip'].includes(extension)) {
      return 'Format tidak didukung. Gunakan file .html, .htm, atau .zip.';
    }
    if (file.size === 0) return 'File kosong. Pilih file lain.';
    if (file.size > maxMb * 1024 * 1024) {
      return `Ukuran file melebihi batas ${maxMb} MB.`;
    }
    return null;
  }

  function validateLogoFile(file) {
    const maxMb = state.config?.limits?.maxLogoMb ?? 2;
    const extension = (file.name.split('.').pop() || '').toLowerCase();
    if (!['png', 'jpg', 'jpeg'].includes(extension)) {
      return 'Logo harus berformat PNG atau JPG.';
    }
    if (file.size > maxMb * 1024 * 1024) {
      return `Ukuran logo melebihi batas ${maxMb} MB.`;
    }
    return null;
  }

  function setSiteFile(file) {
    if (!file) return;
    const problem = validateSiteFile(file);
    if (problem) {
      toast(problem, 'error');
      return;
    }
    state.siteFile = file;
    el.siteFileName.textContent = file.name;
    el.siteFileSize.textContent = formatBytes(file.size);
    el.siteFileChip.classList.add('is-visible');
    el.siteDrop.classList.add('has-file');
    updateFormHint();
  }

  function clearSiteFile() {
    state.siteFile = null;
    el.siteInput.value = '';
    el.siteFileChip.classList.remove('is-visible');
    el.siteDrop.classList.remove('has-file');
    updateFormHint();
  }

  function setLogoFile(file) {
    if (!file) return;
    const problem = validateLogoFile(file);
    if (problem) {
      toast(problem, 'error');
      return;
    }

    if (state.logoObjectUrl) URL.revokeObjectURL(state.logoObjectUrl);
    state.logoFile = file;
    state.logoObjectUrl = URL.createObjectURL(file);

    el.logoThumb.src = state.logoObjectUrl;
    el.logoName.textContent = file.name;
    el.logoMeta.textContent = formatBytes(file.size);
    el.logoPreviewRow.hidden = false;
    el.logoDrop.classList.add('has-file');
    el.heroIcon.src = state.logoObjectUrl;
    el.resultIcon.src = state.logoObjectUrl;
  }

  function clearLogoFile() {
    if (state.logoObjectUrl) URL.revokeObjectURL(state.logoObjectUrl);
    state.logoObjectUrl = null;
    state.logoFile = null;
    el.logoInput.value = '';
    el.logoPreviewRow.hidden = true;
    el.logoDrop.classList.remove('has-file');
    el.heroIcon.src = DEFAULT_ICON;
    el.resultIcon.src = DEFAULT_ICON;
  }

  function updateFormHint() {
    if (state.job) {
      el.formHint.textContent = 'Build tercatat di server';
      return;
    }
    const nameFilled = el.appName.value.trim().length >= 2;
    if (state.siteFile && nameFilled) el.formHint.textContent = 'Siap dibangun';
    else if (state.siteFile) el.formHint.textContent = 'Langkah 3 dari 3';
    else el.formHint.textContent = 'Langkah 1 dari 3';
  }

  function wireDropzone(drop, input, onFile) {
    drop.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        input.click();
      }
    });

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) onFile(file);
    });

    ['dragenter', 'dragover'].forEach((type) => {
      drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.add('is-dragover');
      });
    });

    ['dragleave', 'dragend'].forEach((type) => {
      drop.addEventListener(type, () => drop.classList.remove('is-dragover'));
    });

    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.classList.remove('is-dragover');
      const file = event.dataTransfer?.files?.[0];
      if (file) onFile(file);
    });
  }

  /* ---------------- Status rendering ---------------- */

  const STATUS_META = {
    queued: { label: 'Antrean', pill: 'active', step: 1 },
    building: { label: 'Build', pill: 'active', step: 2 },
    success: { label: 'Berhasil', pill: 'success', step: 3 },
    failed: { label: 'Gagal', pill: 'failed', step: 2 },
  };

  function timelineSteps() {
    return Array.from(el.timeline.querySelectorAll('li'));
  }

  function paintTimeline(job) {
    const meta = STATUS_META[job.status] ?? STATUS_META.queued;
    const steps = timelineSteps();

    let activeIndex = meta.step;
    let failedIndex = -1;

    if (job.status === 'failed') {
      failedIndex = job.runId ? 2 : 1;
      activeIndex = failedIndex;
    }

    steps.forEach((node, index) => {
      node.removeAttribute('data-state');
      if (job.status === 'success') {
        node.setAttribute('data-state', 'done');
        return;
      }
      if (index < activeIndex) node.setAttribute('data-state', 'done');
      else if (index === failedIndex) node.setAttribute('data-state', 'failed');
      else if (index === activeIndex) node.setAttribute('data-state', 'active');
      else node.setAttribute('data-state', 'idle');
    });

    el.statusPill.dataset.state = meta.pill;
    el.statusPillText.textContent = meta.label;
  }

  function phaseMessage(job) {
    if (job.status === 'success') return 'Build selesai. APK asli sudah tersedia.';
    if (job.status === 'failed') return job.error || 'Build gagal diproses.';
    if (job.status === 'building') {
      return job.phase ? `Sedang membangun: ${job.phase}` : 'Gradle sedang menyusun APK Anda…';
    }
    return job.phase ? `Menunggu runner: ${job.phase}` : 'Build masuk antrean GitHub Actions…';
  }

  function renderJob(job) {
    if (!job) return;
    state.job = job;

    el.statusEmpty.hidden = true;
    el.statusBody.hidden = false;
    el.jobIdText.textContent = job.id;
    el.resetBtn.hidden = false;

    paintTimeline(job);

    el.phaseLabel.textContent = phaseMessage(job);
    el.phaseText.classList.toggle('is-idle', job.status === 'success' || job.status === 'failed');

    // Hasil build
    const finished = job.status === 'success';
    el.resultCard.hidden = !finished;
    if (finished) {
      el.resultName.textContent = job.appName || 'Aplikasi Android';
      el.resultSize.textContent = formatBytes(job.apkSize);
      el.resultStatus.textContent = 'APK siap dipasang';
      if (job.apkSha256) {
        el.resultHash.hidden = false;
        el.resultHash.textContent = `SHA-256: ${String(job.apkSha256).slice(0, 32)}…`;
        el.resultHash.title = job.apkSha256;
      } else {
        el.resultHash.hidden = true;
      }
      el.downloadBtn.hidden = false;
      el.downloadBtn.href = job.downloadUrl || `/api/jobs/${job.id}/download`;
      el.downloadBtn.setAttribute('download', job.apkName || 'apk-v2noxa.apk');
      el.resultIcon.src = state.logoObjectUrl || DEFAULT_ICON;
    } else {
      el.downloadBtn.hidden = true;
      el.downloadBtn.removeAttribute('href');
    }

    // Error build
    const failed = job.status === 'failed';
    el.errorBox.hidden = !failed;
    if (failed) {
      el.errorTitle.textContent = 'Build gagal';
      el.errorText.textContent = job.error || 'Build tidak dapat diselesaikan.';
      el.errorHint.textContent =
        job.errorHint || 'Buka log build untuk melihat pesan kompilasi dari runner GitHub Actions.';
    }

    // Log run
    if (job.runUrl) {
      el.runLink.hidden = false;
      el.runLink.href = job.runUrl;
    } else {
      el.runLink.hidden = true;
    }

    el.heroAppName.textContent = job.appName || el.heroAppName.textContent;
    updateElapsed();
    updateFormHint();
  }

  function updateElapsed() {
    const job = state.job;
    if (!job) return;
    const running = job.status === 'queued' || job.status === 'building';
    const end = running ? Date.now() : job.updatedAt || Date.now();
    el.jobElapsed.textContent = formatDuration(end - (job.createdAt || end));
  }

  function startTick() {
    if (state.tickTimer) return;
    state.tickTimer = setInterval(updateElapsed, 1000);
  }

  function stopTick() {
    if (state.tickTimer) clearInterval(state.tickTimer);
    state.tickTimer = null;
  }

  /* ---------------- Polling ---------------- */

  function stopPolling() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  function schedulePoll() {
    stopPolling();
    if (!state.job) return;
    if (state.job.status === 'success' || state.job.status === 'failed') return;
    state.pollTimer = setTimeout(pollJob, state.pollDelay);
  }

  async function pollJob() {
    const id = state.job?.id;
    if (!id) return;
    try {
      const response = await fetch(`/api/jobs/${id}`, { headers: { accept: 'application/json' } });
      const data = await response.json();

      if (response.status === 404) {
        stopPolling();
        localStorage.removeItem(STORAGE_JOB);
        toast('Data build tidak ditemukan di server. Mulai build baru.', 'error');
        return;
      }
      if (!response.ok || !data.ok) throw new Error(data?.error?.message || 'Gagal membaca status build.');

      const previous = state.job?.status;
      renderJob(data.job);

      if (data.job.status === 'success' && previous !== 'success') {
        stopPolling();
        stopTick();
        toast('APK berhasil dibangun. Silakan unduh file .apk Anda.', 'success');
        return;
      }
      if (data.job.status === 'failed' && previous !== 'failed') {
        stopPolling();
        stopTick();
        toast(data.job.error || 'Build gagal. Periksa log build.', 'error');
        return;
      }

      state.pollDelay = Math.min(POLL_MAX_MS, Math.round(state.pollDelay * 1.15));
      schedulePoll();
    } catch (error) {
      state.pollDelay = Math.min(POLL_MAX_MS, state.pollDelay + 2000);
      schedulePoll();
      if (state.pollDelay >= POLL_MAX_MS) {
        toast(error.message || 'Koneksi ke server terputus saat memantau build.', 'error');
      }
    }
  }

  /* ---------------- Submit ---------------- */

  function submitBuild(event) {
    event.preventDefault();
    if (state.busy) return;

    if (!state.config?.githubConfigured) {
      toast('Build cloud belum dikonfigurasi pada server ini.', 'error');
      return;
    }
    if (!state.siteFile) {
      toast('Pilih file HTML, HTM, atau ZIP terlebih dahulu.', 'error');
      el.siteDrop.focus();
      return;
    }
    const appName = el.appName.value.trim();
    if (appName.length < 2) {
      toast('Nama aplikasi minimal 2 karakter.', 'error');
      el.appName.focus();
      return;
    }
    if (state.config.accessCodeRequired && !el.accessCodeInput.value.trim()) {
      toast('Masukkan kode akses yang diberikan admin.', 'error');
      el.accessCodeInput.focus();
      return;
    }

    const formData = new FormData();
    formData.append('site', state.siteFile, state.siteFile.name);
    if (state.logoFile) formData.append('logo', state.logoFile, state.logoFile.name);
    formData.append('appName', appName);
    const packageName = el.packageInput.value.trim();
    if (packageName) formData.append('packageName', packageName);

    setBusy(true);
    setProgress(0, 'Mengunggah 0%');
    stopPolling();
    stopTick();

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/build', true);
    xhr.setRequestHeader('accept', 'application/json');
    const accessCode = el.accessCodeInput.value.trim();
    if (accessCode) xhr.setRequestHeader('x-access-code', accessCode);

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const percent = (event.loaded / event.total) * 100;
      setProgress(percent, percent >= 100 ? 'Memvalidasi & mengirim ke build cloud…' : `Mengunggah ${Math.round(percent)}%`);
    });

    xhr.addEventListener('load', () => {
      let payload = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        payload = null;
      }

      setBusy(false);

      if (xhr.status === 202 && payload?.ok && payload.job) {
        setProgress(100, 'Build diterima. Menunggu runner…');
        localStorage.setItem(STORAGE_JOB, payload.job.id);
        localStorage.setItem(STORAGE_NAME, appName);
        state.pollDelay = POLL_MIN_MS;
        renderJob(payload.job);
        startTick();
        schedulePoll();
        toast('Build masuk antrean cloud. Status akan diperbarui otomatis.', 'success');
        setTimeout(hideProgress, 1500);
        el.statusBody.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      hideProgress();
      const message = payload?.error?.message || `Permintaan gagal (HTTP ${xhr.status}).`;

      if (xhr.status === 503) {
        const missing = (payload?.error?.missingEnv || []).join(', ');
        el.configBanner.hidden = false;
        el.configBanner.innerHTML = `
          <div class="alert alert-warn">
            ${ICONS.warn}
            <div>
              <strong>Build belum dikonfigurasi</strong>
              ${missing ? `Variabel belum diisi: <code>${missing}</code>. ` : ''}
              ${payload?.error?.hint || 'Lengkapi konfigurasi server lalu coba lagi.'}
            </div>
          </div>`;
      }

      toast(message, 'error');
      if (payload?.error) {
        el.statusEmpty.hidden = true;
        el.statusBody.hidden = false;
        el.jobIdText.textContent = '—';
        el.errorBox.hidden = false;
        el.errorTitle.textContent = 'Build tidak dimulai';
        el.errorText.textContent = message;
        el.errorHint.textContent = payload.error.hint || '';
        el.statusPill.dataset.state = 'failed';
        el.statusPillText.textContent = 'Gagal';
      }
    });

    xhr.addEventListener('error', () => {
      setBusy(false);
      hideProgress();
      toast('Koneksi ke server gagal. Periksa jaringan lalu coba lagi.', 'error');
    });

    xhr.addEventListener('timeout', () => {
      setBusy(false);
      hideProgress();
      toast('Waktu unggah habis. Coba lagi dengan koneksi yang lebih stabil.', 'error');
    });

    xhr.send(formData);
  }

  /* ---------------- Reset & restore ---------------- */

  function resetBuilder() {
    stopPolling();
    stopTick();
    state.job = null;
    state.pollDelay = POLL_MIN_MS;
    localStorage.removeItem(STORAGE_JOB);

    clearSiteFile();
    clearLogoFile();
    el.packageInput.value = '';
    el.appName.value = '';
    el.charCount.textContent = '0/40';
    el.heroAppName.textContent = 'Nama Aplikasi Anda';

    el.statusBody.hidden = true;
    el.statusEmpty.hidden = false;
    el.statusPill.dataset.state = 'idle';
    el.statusPillText.textContent = 'Menunggu';
    el.resultCard.hidden = true;
    el.errorBox.hidden = true;
    el.downloadBtn.hidden = true;
    el.downloadBtn.removeAttribute('href');
    el.runLink.hidden = true;
    el.resetBtn.hidden = true;
    el.phaseText.classList.add('is-idle');
    hideProgress();
    updateFormHint();
    el.appName.focus();
  }

  async function restoreJob() {
    const savedId = localStorage.getItem(STORAGE_JOB);
    if (!savedId) return;
    try {
      const response = await fetch(`/api/jobs/${savedId}`, { headers: { accept: 'application/json' } });
      if (!response.ok) {
        localStorage.removeItem(STORAGE_JOB);
        return;
      }
      const data = await response.json();
      if (!data.ok || !data.job) {
        localStorage.removeItem(STORAGE_JOB);
        return;
      }
      const savedName = localStorage.getItem(STORAGE_NAME);
      if (savedName) el.appName.value = savedName;
      el.charCount.textContent = `${el.appName.value.length}/40`;
      renderJob(data.job);
      startTick();
      schedulePoll();
      if (data.job.status === 'queued' || data.job.status === 'building') {
        toast('Melanjutkan pemantauan build terakhir Anda.', 'info');
      }
    } catch {
      /* diamkan: pemulihan bersifat opsional */
    }
  }

  /* ---------------- Events ---------------- */

  function wireEvents() {
    wireDropzone(el.siteDrop, el.siteInput, setSiteFile);
    wireDropzone(el.logoDrop, el.logoInput, setLogoFile);

    el.siteRemove.addEventListener('click', (event) => {
      event.preventDefault();
      clearSiteFile();
    });
    el.logoRemove.addEventListener('click', (event) => {
      event.preventDefault();
      clearLogoFile();
    });

    el.form.addEventListener('submit', submitBuild);
    el.resetBtn.addEventListener('click', resetBuilder);

    el.appName.addEventListener('input', () => {
      const value = el.appName.value;
      el.charCount.textContent = `${value.length}/40`;
      el.heroAppName.textContent = value.trim() || 'Nama Aplikasi Anda';
      updateFormHint();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (state.job && (state.job.status === 'queued' || state.job.status === 'building')) {
        state.pollDelay = POLL_MIN_MS;
        pollJob();
      }
    });

    window.addEventListener('beforeunload', () => {
      if (state.logoObjectUrl) URL.revokeObjectURL(state.logoObjectUrl);
    });
  }

  async function init() {
    wireEvents();
    await loadConfig();
    await restoreJob();
    updateFormHint();
  }

  init();
})();
