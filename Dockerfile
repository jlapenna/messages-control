# Self-contained image: Chromium comes with the Playwright base image.
# docker build -t messages-control . && docker run -it -v messages-control:/data messages-control init
FROM mcr.microsoft.com/playwright:v1.64.0-noble
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
