# APK V2NOXA

Platform **HTML → APK** yang mengubah file website menjadi **APK Android sungguhan**.
Build dijalankan di cloud oleh **GitHub Actions** memakai **Android SDK + Gradle**, bukan file palsu dan bukan sekadar mengganti ekstensi.

> Tagline: *Website Anda, kini jadi aplikasi.*

---

## 1. Fitur

| Fitur | Keterangan |
| --- | --- |
| Upload file website | `.html`, `.htm`, `.zip` (ZIP wajib memuat `index.html`, boleh di root atau dalam satu folder) |
| Upload logo APK | `.png`, `.jpg`, `.jpeg` — pratinjau langsung, otomatis dijadikan ikon launcher semua densitas (mdpi → xxxhdpi) |
| Nama aplikasi | Dipakai sebagai label launcher (`strings.xml` → `app_name`) dan nama file APK |
| Nama paket | Opsional; otomatis dibuat (`com.v2noxa.<slug>`) bila dikosongkan |
| Buat APK | Tombol **BUAT APK** mengunggah file ke backend, backend memicu `workflow_dispatch` GitHub Actions |
| Status nyata | Antrean → build → berhasil/gagal, semuanya dibaca dari status run GitHub (tidak ada simulasi) |
| Download APK | Tombol **DOWNLOAD APK** aktif hanya setelah artifact APK benar-benar ada; file diambil dari artifact GitHub dan diverifikasi berisi `AndroidManifest.xml` + `classes.dex` |
| Hasil build | Nama aplikasi, ikon, ukuran APK, SHA-256, status, tautan log build |

Desain: tema **biru neon / putih / navy**, responsif Android & PC, seluruh antarmuka berbahasa Indonesia.

---

## 2. Arsitektur

```
┌──────────────────┐   1. upload (multipart)    ┌───────────────────────┐
│  Browser (HP/PC) │ ─────────────────────────► │  Backend Node.js      │
│  public/         │ ◄───── 3. status & APK ─── │  src/                 │
└──────────────────┘                            └───────────┬───────────┘
                                                            │ 2. GitHub API
                                                            │    (token hanya di server)
                                                            ▼
                                              ┌───────────────────────────────┐
                                              │ Repo build (GITHUB_OWNER/REPO)│
                                              │ builds/<jobId>/site.*, logo.* │
                                              └───────────────┬───────────────┘
                                                              │ workflow_dispatch
                                                              ▼
                                              ┌───────────────────────────────┐
                                              │ GitHub Actions (ubuntu-latest)│
                                              │ JDK 17 · Android SDK 34       │
                                              │ Gradle 8.9 · assembleDebug    │
                                              └───────────────┬───────────────┘
                                                              │ artifact
                                                              ▼
                                              apk-<jobId> (APK asli) + meta-<jobId>
```

Alur detail:

1. Frontend memvalidasi tipe & ukuran file, menampilkan pratinjau logo, lalu `POST /api/build`.
2. Backend memvalidasi ulang (magic bytes, dimensi logo, keamanan ZIP), membuat job, dan meng-commit file input ke repo build lewat **Contents API** pada `builds/<jobId>/`.
3. Backend memicu workflow `build-apk.yml` via **workflow_dispatch**.
4. Runner GitHub Actions menjalankan `scripts/prepare-build.js` (menyalin template Android, mengekstrak ZIP dengan aman, membuat ikon launcher, mengisi nama aplikasi & package), lalu `gradle assembleDebug`.
5. Runner memverifikasi APK (ada `AndroidManifest.xml`, `classes.dex`, ukuran wajar), menulis `apk-info.json`, dan mengunggah artifact `apk-<jobId>` + `meta-<jobId>`.
6. Backend memantau run GitHub. Status `success` hanya diberikan jika **artifact APK benar-benar ada**.
7. Tombol download memanggil `GET /api/jobs/:id/download`; backend mengunduh artifact, mengambil entri `.apk`, dan mengirimkannya sebagai file APK asli.

---

## 3. Struktur repo

```
.
├── src/
│   ├── server.js          # entrypoint HTTP
│   ├── app.js             # Express: API + static + keamanan (helmet, rate limit)
│   ├── config.js          # konfigurasi dari environment
│   ├── validate.js        # validasi upload, sanitasi nama & package
│   ├── zip.js             # pembacaan ZIP aman (yauzl)
│   ├── jobs.js            # penyimpanan status job (JSON)
│   ├── github.js          # klien GitHub API
│   └── build-service.js   # dispatch, polling status, unduh APK
├── public/                # frontend (index.html, styles.css, app.js, favicon.svg)
├── android-template/      # template proyek Android (WebView + Gradle)
├── scripts/prepare-build.js  # dijalankan di runner: siapkan aset & ikon
├── .github/workflows/build-apk.yml
├── test/                  # node:test (25 pengujian)
├── .env.example
└── README.md
```

---

## 4. Prasyarat

- Node.js **20.11+** (disarankan LTS terbaru).
- Sebuah repo GitHub yang berisi kode ini **dan** workflow `.github/workflows/build-apk.yml` pada branch yang akan dipakai build.
- GitHub Actions aktif pada repo tersebut (repo publik: gratis; repo privat: kuota menit Actions).
- Personal Access Token GitHub dengan izin tulis (lihat bagian 5).

---

## 5. Membuat token GitHub

**Disarankan: fine-grained token** (Settings → Developer settings → Personal access tokens → Fine-grained tokens), scope hanya ke repo build:

| Izin | Level | Kegunaan |
| --- | --- | --- |
| **Contents** | Read and write | commit file input ke `builds/<jobId>/`, hapus setelah build |
| **Actions** | Read and write | `workflow_dispatch` (menjalankan build) |
| **Metadata** | Read (otomatis) | info repo |

Alternatif klasik (classic token): centang `repo` **dan** `workflow`.

> Token **hanya** dibaca backend dari `process.env.GITHUB_TOKEN`. Tidak pernah dikirim ke browser, tidak pernah ditulis ke HTML/JS, dan tidak pernah dikembalikan oleh API.

---

## 6. Konfigurasi environment

Salin `.env.example` → `.env` lalu isi:

| Variabel | Wajib | Default | Keterangan |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | ✅ | – | Token dari bagian 5 |
| `GITHUB_OWNER` | ✅ | – | Pemilik repo build, mis. `namauser` |
| `GITHUB_REPO` | ✅ | – | Nama repo build, mis. `apk-v2noxa` |
| `GITHUB_BUILD_REF` | ⬜ | default branch | Branch yang memuat workflow + template, mis. `appjet` atau `main` |
| `GITHUB_WORKFLOW_FILE` | ⬜ | `build-apk.yml` | Nama file workflow di `.github/workflows/` |
| `APP_ACCESS_CODE` | ⬜ | kosong | Bila diisi, tombol BUAT APK meminta kode akses ini (mencegah penyalahgunaan) |
| `MAX_SITE_MB` | ⬜ | `20` | Batas ukuran file website |
| `MAX_LOGO_MB` | ⬜ | `2` | Batas ukuran logo |
| `BUILD_RATE_LIMIT_MAX` | ⬜ | `10` | Maksimum build per IP per jam |
| `DATA_DIR` | ⬜ | `./data` | Lokasi penyimpanan status job |
| `PORT` | ⬜ | `3000` | Port server (hosting biasanya mengisi otomatis) |

Bila variabel wajib belum diisi, aplikasi **tetap berjalan** tetapi tombol BUAT APK akan menampilkan pesan bahwa backend belum dikonfigurasi beserta daftar variabel yang kurang — tidak ada status berhasil palsu.

---

## 7. Menjalankan lokal

```bash
npm install
cp .env.example .env      # isi GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO
npm start                 # http://localhost:3000
```

Uji otomatis:

```bash
npm test
```

Tes mencakup validasi format/ukuran, keamanan ZIP (path traversal, ZIP tanpa `index.html`, arsip rusak), validasi logo & dimensi, sanitasi nama aplikasi/package, serta memastikan **tidak ada respons "sukses" ketika kredensial build belum ada**.

---

## 8. Deployment

Aplikasi ini adalah Node.js biasa (Express) yang menyajikan frontend statis + API, jadi bisa dijalankan di AppJet, VPS, Railway, Render, Fly.io, atau Docker.

### AppJet

1. Deploy repo ini (branch `appjet`) melalui panel AppJet.
2. Buka **Settings → Environment Variables**, tambahkan: `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BUILD_REF`, dan opsional `APP_ACCESS_CODE`.
3. Redeploy, lalu buka `https://<domain-anda>/api/health` → `githubConfigured` harus `true`.

> Catatan paket **Free**: tidak ada persistent disk. Status job disimpan di `data/jobs.json`, sehingga riwayat job hilang setiap kali aplikasi di-restart/redeploy (APK yang sudah jadi tetap dapat diunduh selama artifact GitHub belum kedaluwarsa). Untuk riwayat permanen, gunakan disk persisten (paket Starter/Pro) atau `DATA_DIR` ke volume yang persisten.

### Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
```

```bash
docker build -t apk-v2noxa .
docker run -p 3000:3000 --env-file .env apk-v2noxa
```

### Catatan penting untuk hosting

- Server harus mendengarkan di `0.0.0.0` (sudah dilakukan `src/server.js`).
- Reverse proxy/CDN sebaiknya mengizinkan body multipart hingga `MAX_SITE_MB` + `MAX_LOGO_MB` (mis. Nginx `client_max_body_size 25m;`).
- Jika server berada di belakang proxy, `trust proxy` sudah diaktifkan agar rate limit membaca IP asli.

---

## 9. API

| Method | Endpoint | Keterangan |
| --- | --- | --- |
| `GET` | `/api/health` | Status server + `githubConfigured` |
| `GET` | `/api/config` | Batas upload, kebutuhan kode akses, target build (tanpa rahasia) |
| `POST` | `/api/build` | Multipart: `site`, `logo`, `appName`, `packageName` (opsional). Header `x-access-code` bila `APP_ACCESS_CODE` diset. → `202 {ok:true, job}` |
| `GET` | `/api/jobs/:id` | Status job terkini (disinkronkan dengan GitHub) |
| `GET` | `/api/jobs/:id/download` | Mengunduh file `.apk` asli (hanya bila build berhasil) |

Contoh:

```bash
curl -X POST https://domain-anda/api/build \
  -H "x-access-code: KODE_ANDA" \
  -F "site=@website.zip" \
  -F "logo=@logo.png" \
  -F "appName=Toko Bunga" \
  -F "packageName=id.tokobunga.app"
```

Status job: `queued` → `building` → `success` | `failed`, plus `phase` (tahap yang sedang berjalan), `runUrl` (tautan log GitHub), `apkName`, `apkSize`, `apkSha256`.

---

## 10. Keamanan

- **Token GitHub tidak pernah menyentuh frontend.** Semua panggilan GitHub terjadi di server.
- **Validasi berlapis**: ekstensi + ukuran + magic bytes (PNG/JPG/ZIP) + dimensi logo (64–4096 px).
- **Keamanan ZIP**: penolakan path traversal/absolut, penolakan ZIP terenkripsi, batas jumlah entri (3000), batas total hasil ekstraksi (300 MB), deteksi rasio kompresi ekstrem (zip bomb), dan `unzip` di runner hanya mengekstrak ke folder sementara.
- **Sanitasi**: nama aplikasi & package name dibersihkan/diwhitelist sebelum masuk `strings.xml`, `build.gradle`, dan nama file.
- **HTTP**: `helmet` + CSP ketat (`script-src 'self'`), `express-rate-limit` (400 req/15 menit per IP; build dibatasi `BUILD_RATE_LIMIT_MAX` per jam), batas ukuran body.
- **Kode akses opsional** dibandingkan dengan `crypto.timingSafeEqual`.
- **Tanpa klaim palsu**: status `success` hanya jika run GitHub selesai `success` **dan** artifact APK ada.
- File input di repo build dihapus otomatis di akhir workflow (`if: always()`), dan artifact disimpan 7 hari.

---

## 11. Troubleshooting

| Gejala | Penyebab & solusi |
| --- | --- |
| Tombol BUAT APK → "belum dikonfigurasi" | `GITHUB_TOKEN`/`GITHUB_OWNER`/`GITHUB_REPO` belum diset di server. Cek `/api/config` → `missingEnv`. |
| Status tetap "menunggu antrean" | Workflow tidak ditemukan pada `GITHUB_BUILD_REF`, atau Actions dimatikan. Pastikan `.github/workflows/build-apk.yml` ada di branch tersebut. |
| `401 Bad credentials` | Token kedaluwarsa/salah, atau fine-grained token tidak punya akses ke repo build. |
| `403 Resource not accessible by integration` | Izin token kurang: butuh **Contents: write** dan **Actions: write**. |
| Build gagal di langkah Gradle | Buka `runUrl` → log. Umumnya `sdkmanager`/lisensi atau memori runner. |
| "artifact APK tidak ditemukan" | Langkah upload artifact gagal atau artifact sudah kedaluwarsa (7 hari). |
| Download → 410 | Artifact sudah kedaluwarsa; jalankan build baru. |
| ZIP ditolak | Pastikan ZIP memuat `index.html` (root atau satu folder), tidak terenkripsi, dan tanpa entri `../`. |
| Logo ditolak | Harus PNG/JPG asli minimal 64×64 px (disarankan 512×512), maksimal 4096×4096. |

---

## 12. Batasan yang perlu diketahui

- APK yang dihasilkan memakai **signing debug** (`assembleDebug`) sehingga **dapat dipasang langsung di Android** (aktifkan "Instal dari sumber tidak dikenal"), tetapi **tidak bisa dipublikasikan ke Google Play**. Untuk Play Store, tambahkan `signingConfigs` release + keystore Anda di `android-template/app/build.gradle` dan ganti tugas Gradle menjadi `assembleRelease`.
- Aplikasi hasil build adalah **WebView wrapper**: konten website dijalankan dari aset lokal (`file:///android_asset/www/index.html`), sehingga fitur yang butuh server (PHP, database, API pihak ketiga) tetap memerlukan hosting sendiri.
- Butuh kuota GitHub Actions dan koneksi internet server → GitHub.
- Ukuran APK hasil build berkisar 1–3 MB (bertambah sesuai aset website).
- Artifact APK disimpan **7 hari**; setelah itu pengguna perlu build ulang.
