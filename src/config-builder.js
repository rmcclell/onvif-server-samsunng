'use strict';

const soap = require('soap');
const uuid = require('node-uuid');

function extractPath(fullUrl) {
    try {
        const { URL } = require('url');
        return new URL(fullUrl).pathname;
    } catch (_) {
        // fallback: strip scheme + host
        const idx = fullUrl.indexOf('/', fullUrl.indexOf('//') + 2);
        return idx > -1 ? fullUrl.substr(idx) : '/';
    }
}

async function createConfig(hostname, username, password) {
    const options = { forceSoap12Headers: true };
    const securityOptions = { hasNonce: true, passwordType: 'PasswordDigest' };

    const client = await soap.createClientAsync('./wsdl/media_service.wsdl', options);

    // PR #26: wrap in try/finally to destroy HTTP agent
    try {
        client.setEndpoint(`http://${hostname}/onvif/device_service`);
        client.setSecurity(new soap.WSSecurity(username, password, securityOptions));

        let hostport = 80;
        if (hostname.indexOf(':') > -1) {
            hostport = parseInt(hostname.substr(hostname.indexOf(':') + 1));
            hostname = hostname.substr(0, hostname.indexOf(':'));
        }

        const cameras = {};

        const profiles = await client.GetProfilesAsync({});
        for (const profile of profiles[0].Profiles) {
            const videoSource = profile.VideoSourceConfiguration.SourceToken;
            if (!cameras[videoSource]) cameras[videoSource] = [];

            const snapshotUri = await client.GetSnapshotUriAsync({
                ProfileToken: profile.attributes.token
            });

            const streamUri = await client.GetStreamUriAsync({
                StreamSetup: {
                    Stream:    'RTP-Unicast',
                    Transport: { Protocol: 'RTSP' }
                },
                ProfileToken: profile.attributes.token
            });

            profile.streamUri   = streamUri[0].MediaUri.Uri;
            profile.snapshotUri = snapshotUri[0].MediaUri.Uri;
            cameras[videoSource].push(profile);
        }

        const config = { onvif: [] };
        let serverPort = 8081;

        for (const camera in cameras) {
            let mainStream = cameras[camera][0];
            let subStream  = cameras[camera][cameras[camera].length > 1 ? 1 : 0];

            // Determine which is actually higher quality
            let swap = false;
            if (subStream.VideoEncoderConfiguration.Quality > mainStream.VideoEncoderConfiguration.Quality)
                swap = true;
            else if (subStream.VideoEncoderConfiguration.Quality === mainStream.VideoEncoderConfiguration.Quality)
                if (subStream.VideoEncoderConfiguration.Resolution.Width > mainStream.VideoEncoderConfiguration.Resolution.Width)
                    swap = true;

            if (swap) { const t = subStream; subStream = mainStream; mainStream = t; }

            config.onvif.push({
                hostname:   '<YOUR_SERVER_IP>',   // set to the IP of the machine running this server
                ports: {
                    server:   serverPort,
                    rtsp:     8554,
                    snapshot: 8580
                },
                name:   mainStream.VideoSourceConfiguration.Name,
                uuid:   uuid.v4(),
                deviceInfo: {
                    manufacturer:    'Samsung',
                    model:           'SNH-V6414N',
                    firmwareVersion: '2.10.00_b43',
                    serialNumber:    `${mainStream.VideoSourceConfiguration.Name.replace(/\s+/g, '_')}-0000`,
                    hardwareId:      'SNH-V6414N-1001'
                },
                highQuality: {
                    rtsp:      extractPath(mainStream.streamUri),
                    snapshot:  extractPath(mainStream.snapshotUri),
                    width:     mainStream.VideoEncoderConfiguration.Resolution.Width,
                    height:    mainStream.VideoEncoderConfiguration.Resolution.Height,
                    framerate: mainStream.VideoEncoderConfiguration.RateControl.FrameRateLimit,
                    bitrate:   mainStream.VideoEncoderConfiguration.RateControl.BitrateLimit,
                    quality:   4.0
                },
                lowQuality: {
                    rtsp:      extractPath(subStream.streamUri),
                    snapshot:  extractPath(subStream.snapshotUri),
                    width:     subStream.VideoEncoderConfiguration.Resolution.Width,
                    height:    subStream.VideoEncoderConfiguration.Resolution.Height,
                    framerate: subStream.VideoEncoderConfiguration.RateControl.FrameRateLimit,
                    bitrate:   subStream.VideoEncoderConfiguration.RateControl.BitrateLimit,
                    quality:   1.0
                },
                target: {
                    hostname: hostname,
                    ports: {
                        rtsp:     554,
                        snapshot: hostport
                    }
                }
            });
            serverPort++;
        }

        return config;
    } catch (err) {
        if (err.root && err.root.Envelope && err.root.Envelope.Body &&
            err.root.Envelope.Body.Fault && err.root.Envelope.Body.Fault.Reason &&
            err.root.Envelope.Body.Fault.Reason.Text) {
            throw `Error: ${err.root.Envelope.Body.Fault.Reason.Text['$value']}`;
        }
        throw `Error: ${err.message}`;
    } finally {
        // PR #26: destroy HTTP agent to prevent connection pool leak
        if (client && client.httpClient && client.httpClient.agent &&
            typeof client.httpClient.agent.destroy === 'function') {
            client.httpClient.agent.destroy();
        }
    }
}

exports.createConfig = async function(hostname, username, password) {
    let config;
    // PR #26: save and restore Date.prototype.getUTCHours if we monkey-patch it
    let originalGetUTCHours = null;

    try {
        config = await createConfig(hostname, username, password);
    } catch (err) {
        console.log(err);
        if (typeof err === 'string' && err.includes('time check failed')) {
            console.log('Retrying with time offset...');
            const utcHours = (new Date()).getUTCHours();
            originalGetUTCHours = Date.prototype.getUTCHours;
            Date.prototype.getUTCHours = function() { return utcHours + 1; };

            try {
                config = await createConfig(hostname, username, password);
            } catch (err2) {
                console.log(err2);
            }
        }
    } finally {
        if (originalGetUTCHours !== null) {
            Date.prototype.getUTCHours = originalGetUTCHours;
        }
    }

    return config;
};
