# Self-contained image: Chromium comes with the Playwright base image.
# docker build -t messages-control . && docker run -it -v messages-control:/data messages-control init
FROM node:26.13.1-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS node-runtime
FROM mcr.microsoft.com/playwright:v1.65.1-noble
COPY --from=node-runtime /usr/local/bin/node /usr/bin/node
RUN test "$(node -p 'process.versions.node')" = 26.13.1
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
