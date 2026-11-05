# Self-contained image: Chromium comes with the Playwright base image.
# docker build -t messages-control . && docker run -it -v messages-control:/data messages-control init
FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS node-runtime
FROM mcr.microsoft.com/playwright:v1.64.1-noble
COPY --from=node-runtime /usr/local/bin/node /usr/bin/node
RUN test "$(node -p 'process.versions.node')" = 26.13.0
WORKDIR /app
COPY package.json package-lock.json ./
# No lifecycle scripts in the image: "prepare" runs husky, a dev dependency.
RUN npm ci --omit=dev --ignore-scripts
COPY . .
ENV MESSAGES_CONTROL_STATE=/data
ENV MESSAGES_CONTROL_CONFIG=/data/config.json
VOLUME /data
ENTRYPOINT ["node", "bin/messages-control.js"]
CMD ["run"]
