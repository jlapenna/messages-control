# Self-contained image: Chromium comes with the Playwright base image.
# docker build -t messages-control . && docker run -it -v messages-control:/data messages-control init
FROM node:24.22.2-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS node-runtime
FROM mcr.microsoft.com/playwright:v1.64.1-noble
COPY --from=node-runtime /usr/local/bin/node /usr/bin/node
RUN test "$(node -p 'process.versions.node')" = 24.22.1
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
