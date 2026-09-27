const path = require('path');
const soap = require('soap');
const onvifServer = require('./src/onvif-server');

const MEDIA_WSDL_PATH = path.join(__dirname, 'wsdl', 'ver10', 'media', 'wsdl', 'media.wsdl');

const config = {
  name: 'SamsungCamera',
  hostname: '127.0.0.1',
  ports: { server: 8991, rtsp: 8554, snapshot: 8080 },
  highQuality: { width: 1920, height: 1080, framerate: 30, bitrate: 3072, quality: 4, rtsp: '/profile5/media.smp' },
  lowQuality: { width: 1280, height: 720, framerate: 15, bitrate: 1024, quality: 4, rtsp: '/profile4/media.smp' }
};

const server = onvifServer.createServer(config, { info: () => {}, debug: () => {}, error: console.error, warn: () => {} });
server.startServer();

setTimeout(async () => {
  const client = await soap.createClientAsync(MEDIA_WSDL_PATH, { forceSoap12Headers: true });
  client.setEndpoint('http://127.0.0.1:8991/onvif/media_service');
  client.GetProfiles({}, (err, result, rawResponse) => {
    console.log('TRANSFORMED RESPONSE:\n', rawResponse);
    process.exit(0);
  });
}, 300);
