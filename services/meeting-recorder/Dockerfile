# Playwright base ships Chromium's system dependencies. We still run
# `playwright install chromium` below so the browser binary matches whatever
# playwright version npm resolves (avoids base-image/package version drift).
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

RUN apt-get update && apt-get install -y --no-install-recommends \
    pulseaudio pulseaudio-utils ffmpeg xvfb \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
RUN npx playwright install chromium

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# Typecheck gate only — runtime uses tsx (Node ESM needs explicit .js extensions
# that our extensionless source omits; tsx resolves them transparently).
RUN npx tsc -p tsconfig.build.json --noEmit

COPY docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV DISPLAY=:99
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
