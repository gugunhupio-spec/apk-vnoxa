import { createApp } from './app.js';
import { config, githubConfigured, missingGithubEnv } from './config.js';

const app = createApp();

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`APK V2NOXA berjalan di http://0.0.0.0:${config.port}`);
  if (githubConfigured()) {
    console.log(`Build cloud aktif → repo ${config.github.owner}/${config.github.repo} (ref: ${config.github.ref || 'default branch'})`);
  } else {
    console.warn(
      `PERINGATAN: build APK belum aktif. Variabel belum diisi: ${missingGithubEnv().join(', ') || '-'}. ` +
        'Lihat README.md bagian Konfigurasi.',
    );
  }
});

const shutdown = (signal) => {
  console.log(`Menerima ${signal}, menutup server...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app, server };
