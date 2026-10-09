# Self-contained image: Chromium comes with the Playwright base image.
# docker build -t messages-control . && docker run -it -v messages-control:/data -e LITELLM_API_KEY messages-control pair
FROM mcr.microsoft.com/playwright:v1.64.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV MESSAGES_CONTROL_STATE=/data
VOLUME /data
ENTRYPOINT ["node", "bin/messages-control.js"]
CMD ["run"]
