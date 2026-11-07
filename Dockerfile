FROM node:26-alpine

# Perbarui seluruh paket OS Alpine dan pastikan zlib minimal 1.4-r0
# (memperbaiki ALPINE-CVE-2026-4738). Perintah ditulis eksplisit agar layer
# di-rebuild dan tidak memakai cache lama yang masih berisi zlib 1.3.2-r1.
# Catatan: cache apk (/var/cache/apk) sengaja TIDAK dihapus karena dipakai
# oleh pemindai keamanan image untuk membaca basis data paket.
RUN apk update --no-cache \
 && apk upgrade --no-cache \
 && apk add --no-cache --upgrade 'zlib>=1.4-r0'

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
# Server wajib mendengarkan 0.0.0.0 dan memakai process.env.PORT.
CMD ["npm","start"]
