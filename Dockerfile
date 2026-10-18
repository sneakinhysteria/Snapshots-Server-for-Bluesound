# shairport-sync (AirPlay 2, with nqptp and avahi) as base; the app adds Node.js and ffmpeg.
FROM mikebrady/shairport-sync:5.5.2
RUN apk add --no-cache nodejs npm ffmpeg avahi-tools
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8095
# Set by the GitHub workflow; shown in the UI footer and compared with the latest build.
ARG APP_COMMIT=dev
ARG APP_COMMIT_DATE=
ENV APP_COMMIT=$APP_COMMIT APP_COMMIT_DATE=$APP_COMMIT_DATE
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY docker ./docker
VOLUME /data
EXPOSE 8095
ENTRYPOINT ["/app/docker/start.sh"]
