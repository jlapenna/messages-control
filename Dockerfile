# Self-contained image: Chromium comes with the Playwright base image.
# docker build -t messages-control . && docker run -it -v messages-control:/data messages-control init
FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS node-runtime
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
