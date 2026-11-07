FROM node:26-alpine

# Perbarui seluruh paket OS Alpine dan pastikan zlib terpasang minimal 1.4-r0
# (memperbaiki ALPINE-CVE-2026-4738). Perintah ini sengaja eksplisit agar
# layer di-rebuild, bukan memakai cache lama yang masih berisi zlib 1.3.2-r1.
RUN apk update --no-cache \
 && apk upgrade --no-cache \
 && apk add --no-cache --upgrade 'zlib>=1.4-r0' \
 && rm -rf /var/cache/apk/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
# Server wajib mendengarkan 0.0.0.0 dan memakai process.env.PORT.
CMD ["npm","start"]
