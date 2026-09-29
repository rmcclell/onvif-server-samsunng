FROM node:22-alpine

RUN apk add --no-cache ffmpeg

ADD . /app
WORKDIR /app
RUN npm install

ENTRYPOINT node main.js /onvif.yaml
