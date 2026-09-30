'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const soap = require('soap');
const childProcess = require('child_process');
/**
 * ONVIF Compliance Tests
 *
 * These tests spin up an OnvifServer against a mock config and validate
 * that every handler returns a spec-compliant response.
 *
 * Run: npm test
 */

const OnvifServerModule = require('../src/onvif-server');

const DEVICE_WSDL_PATH = path.join(__dirname, '..', 'wsdl', 'device_service.wsdl');
const MEDIA_WSDL_PATH  = path.join(__dirname, '..', 'wsdl', 'media_service.wsdl');
const DEVICE_WSDL_CLIENT_PATH = path.relative(process.cwd(), DEVICE_WSDL_PATH);
const MEDIA_WSDL_CLIENT_PATH  = path.relative(process.cwd(), MEDIA_WSDL_PATH);
const SNAPSHOT_PATH = path.join(__dirname, '..', 'resources', 'snapshot.png');

// ─── Mock logger ─────────────────────────────────────────────────────────────
const noop   = () => {};
const logger = { info: noop, debug: noop, warn: noop, error: noop, trace: noop };

// ─── Minimal valid config ─────────────────────────────────────────────────────
function buildConfig(overrides = {}) {
    return {
        hostname: '192.168.1.100',
        ports:    { server: 8081, rtsp: 8554, snapshot: 8580 },
        name:     'TestCamera',
        uuid:     'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        deviceInfo: {
            manufacturer:    'Samsung',
            model:           'SNH-V6414N',
            firmwareVersion: '2.10.00_b43',
            serialNumber:    'SN-TEST-0001',
            hardwareId:      'SNH-V6414N-1001'
        },
        highQuality: {
            rtsp: '/profile5/media.smp', snapshot: '/onvif/snapshot',
            width: 1920, height: 1080, framerate: 15, bitrate: 2048, quality: 4
        },
        lowQuality: {
            rtsp: '/profile1/media.smp', snapshot: '/onvif/snapshot',
            width: 640, height: 360, framerate: 15, bitrate: 512, quality: 1
        },
        target: { hostname: '192.168.1.200', ports: { rtsp: 554, snapshot: 80 } },
        ...overrides
    };
}

function makeServer(overrides = {}) {
    return OnvifServerModule.createServer(buildConfig(overrides), logger);
}

function httpRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks)
            }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GetSystemDateAndTime', () => {
    const server = makeServer();
    const handler = server.onvif.DeviceService.Device.GetSystemDateAndTime;

    it('returns DateTimeType', () => {
        const res = handler({});
        expect(res.SystemDateAndTime.DateTimeType).toBeDefined();
    });

    it('DateTimeType is NTP or Manual', () => {
        const res = handler({});
        expect(['NTP', 'Manual']).toContain(res.SystemDateAndTime.DateTimeType);
    });

    it('has DaylightSavings boolean', () => {
        const res = handler({});
        expect(typeof res.SystemDateAndTime.DaylightSavings).toBe('boolean');
    });

    it('has TimeZone.TZ string starting with UTC', () => {
        const res = handler({});
        expect(res.SystemDateAndTime.TimeZone.TZ).toMatch(/^UTC/);
    });

    it('has UTCDateTime with valid Hour/Minute/Second', () => {
        const { Time } = handler({}).SystemDateAndTime.UTCDateTime;
        expect(Time.Hour).toBeGreaterThanOrEqual(0);
        expect(Time.Hour).toBeLessThan(24);
        expect(Time.Minute).toBeGreaterThanOrEqual(0);
        expect(Time.Minute).toBeLessThan(60);
        expect(Time.Second).toBeGreaterThanOrEqual(0);
        expect(Time.Second).toBeLessThan(60);
    });

    it('has UTCDateTime with valid Year/Month/Day', () => {
        const { Date } = handler({}).SystemDateAndTime.UTCDateTime;
        expect(Date.Year).toBeGreaterThan(2020);
        expect(Date.Month).toBeGreaterThanOrEqual(1);
        expect(Date.Month).toBeLessThanOrEqual(12);
        expect(Date.Day).toBeGreaterThanOrEqual(1);
        expect(Date.Day).toBeLessThanOrEqual(31);
    });
});

describe('GetCapabilities', () => {
    const server = makeServer();
    const handler = server.onvif.DeviceService.Device.GetCapabilities;

    it('returns Device capability when Category=Device', () => {
        const res = handler({ Category: 'Device' });
        expect(res.Capabilities.Device).toBeDefined();
        expect(res.Capabilities.Media).toBeUndefined();
    });

    it('returns Media capability when Category=Media', () => {
        const res = handler({ Category: 'Media' });
        expect(res.Capabilities.Media).toBeDefined();
        expect(res.Capabilities.Device).toBeUndefined();
    });

    it('returns all capabilities when Category=All', () => {
        const res = handler({ Category: 'All' });
        expect(res.Capabilities.Device).toBeDefined();
        expect(res.Capabilities.Media).toBeDefined();
    });

    it('returns all capabilities when Category omitted', () => {
        const res = handler({});
        expect(res.Capabilities.Device).toBeDefined();
        expect(res.Capabilities.Media).toBeDefined();
    });

    it('Device XAddr includes correct host and port', () => {
        const res = handler({ Category: 'Device' });
        expect(res.Capabilities.Device.XAddr).toContain('192.168.1.100');
        expect(res.Capabilities.Device.XAddr).toContain('8081');
    });

    it('Media XAddr includes media_service path', () => {
        const res = handler({ Category: 'Media' });
        expect(res.Capabilities.Media.XAddr).toContain('/onvif/media_service');
    });

    it('Media has StreamingCapabilities', () => {
        const res = handler({ Category: 'Media' });
        expect(res.Capabilities.Media.StreamingCapabilities).toBeDefined();
        expect(res.Capabilities.Media.StreamingCapabilities.RTP_RTSP_TCP).toBe(true);
    });

    it('advertises PTZ capability when ptz config present', () => {
        const s = makeServer({ ptz: { port: 8080, username: 'admin', password: '4321' } });
        const res = s.onvif.DeviceService.Device.GetCapabilities({ Category: 'All' });
        expect(res.Capabilities.PTZ).toBeDefined();
        expect(res.Capabilities.PTZ.XAddr).toContain('/onvif/ptz_service');
    });
});

describe('GetServices', () => {
    const server  = makeServer();
    const handler = server.onvif.DeviceService.Device.GetServices;

    it('returns an array with at least 2 services', () => {
        const res = handler({});
        expect(Array.isArray(res.Service)).toBe(true);
        expect(res.Service.length).toBeGreaterThanOrEqual(2);
    });

    it('includes device service namespace', () => {
        const res = handler({});
        const ns  = res.Service.map(s => s.Namespace);
        expect(ns).toContain('http://www.onvif.org/ver10/device/wsdl');
    });

    it('includes media service namespace', () => {
        const res = handler({});
        const ns  = res.Service.map(s => s.Namespace);
        expect(ns).toContain('http://www.onvif.org/ver10/media/wsdl');
    });

    it('all services have Version with Major and Minor', () => {
        const res = handler({});
        for (const svc of res.Service) {
            expect(svc.Version.Major).toBeDefined();
            expect(svc.Version.Minor).toBeDefined();
        }
    });
});

describe('GetDeviceInformation', () => {
    const server  = makeServer();
    const handler = server.onvif.DeviceService.Device.GetDeviceInformation;

    it('returns Manufacturer', () => {
        expect(handler({}).Manufacturer).toBe('Samsung');
    });
    it('returns Model', () => {
        expect(handler({}).Model).toBe('SNH-V6414N');
    });
    it('returns FirmwareVersion', () => {
        expect(handler({}).FirmwareVersion).toBeDefined();
    });
    it('returns SerialNumber', () => {
        expect(handler({}).SerialNumber).toBeDefined();
    });
    it('returns HardwareId', () => {
        expect(handler({}).HardwareId).toBeDefined();
    });
});

describe('GetScopes', () => {
    const server  = makeServer();
    const handler = server.onvif.DeviceService.Device.GetScopes;

    it('returns Scopes array', () => {
        const res = handler({});
        expect(Array.isArray(res.Scopes)).toBe(true);
        expect(res.Scopes.length).toBeGreaterThan(0);
    });

    it('has video_encoder type scope', () => {
        const items = handler({}).Scopes.map(s => s.ScopeItem);
        expect(items.some(i => i.includes('video_encoder'))).toBe(true);
    });

    it('has camera name scope', () => {
        const items = handler({}).Scopes.map(s => s.ScopeItem);
        expect(items.some(i => i.includes('TestCamera'))).toBe(true);
    });
});

describe('GetNetworkInterfaces', () => {
    const server  = makeServer();
    const handler = server.onvif.DeviceService.Device.GetNetworkInterfaces;

    it('returns NetworkInterfaces array', () => {
        const res = handler({});
        expect(Array.isArray(res.NetworkInterfaces)).toBe(true);
    });

    it('first interface has Enabled property', () => {
        const res = handler({});
        expect(res.NetworkInterfaces[0].Enabled).toBeDefined();
    });
});

describe('GetProfiles', () => {
    const server  = makeServer();
    const handler = server.onvif.MediaService.Media.GetProfiles;

    it('returns Profiles array with 2 entries', () => {
        const res = handler({});
        expect(Array.isArray(res.Profiles)).toBe(true);
        expect(res.Profiles.length).toBe(2);
    });

    it('first profile has token attribute', () => {
        const res = handler({});
        expect(res.Profiles[0].attributes.token).toBeDefined();
    });

    it('first profile has VideoSourceConfiguration', () => {
        const res = handler({});
        expect(res.Profiles[0].VideoSourceConfiguration).toBeDefined();
    });

    it('first profile has VideoEncoderConfiguration with H264', () => {
        const res = handler({});
        expect(res.Profiles[0].VideoEncoderConfiguration.Encoding).toBe('H264');
    });

    it('main_stream profile has correct resolution', () => {
        const res     = handler({});
        const main    = res.Profiles.find(p => p.attributes.token === 'main_stream');
        const { Width, Height } = main.VideoEncoderConfiguration.Resolution;
        expect(Width).toBe(1920);
        expect(Height).toBe(1080);
    });
});

describe('GetVideoSources', () => {
    const server  = makeServer();
    const handler = server.onvif.MediaService.Media.GetVideoSources;

    it('returns VideoSources array', () => {
        const res = handler({});
        expect(Array.isArray(res.VideoSources)).toBe(true);
    });

    it('video source has Framerate', () => {
        const res = handler({});
        expect(res.VideoSources[0].Framerate).toBeGreaterThan(0);
    });

    it('video source has Resolution with Width and Height', () => {
        const res = handler({});
        expect(res.VideoSources[0].Resolution.Width).toBe(1920);
        expect(res.VideoSources[0].Resolution.Height).toBe(1080);
    });
});

describe('GetStreamUri', () => {
    const server  = makeServer();
    const handler = server.onvif.MediaService.Media.GetStreamUri;

    it('returns MediaUri object', () => {
        const res = handler({ ProfileToken: 'main_stream' });
        expect(res.MediaUri).toBeDefined();
    });

    it('URI starts with rtsp://', () => {
        const res = handler({ ProfileToken: 'main_stream' });
        expect(res.MediaUri.Uri).toMatch(/^rtsp:\/\//);
    });

    it('main_stream uses highQuality rtsp path', () => {
        const res = handler({ ProfileToken: 'main_stream' });
        expect(res.MediaUri.Uri).toContain('/profile5/media.smp');
    });

    it('sub_stream uses lowQuality rtsp path', () => {
        const res = handler({ ProfileToken: 'sub_stream' });
        expect(res.MediaUri.Uri).toContain('/profile1/media.smp');
    });

    it('URI contains the server hostname and rtsp port', () => {
        const res = handler({ ProfileToken: 'main_stream' });
        expect(res.MediaUri.Uri).toContain('192.168.1.100');
        expect(res.MediaUri.Uri).toContain('8554');
    });

    it('has Timeout field', () => {
        const res = handler({ ProfileToken: 'main_stream' });
        expect(res.MediaUri.Timeout).toBeDefined();
    });

    it('preserves full RTSP URLs instead of routing them through the TCP proxy', () => {
        const direct = makeServer({
            highQuality: { ...buildConfig().highQuality, rtsp: 'rtsp://camera.example:554/main?transport=tcp' },
            lowQuality: { ...buildConfig().lowQuality, rtsp: 'rtsp://camera.example:554/sub' }
        });
        const getUri = direct.onvif.MediaService.Media.GetStreamUri;
        expect(getUri({ ProfileToken: 'main_stream' }).MediaUri.Uri)
            .toBe('rtsp://camera.example:554/main?transport=tcp');
        expect(getUri({ ProfileToken: 'sub_stream' }).MediaUri.Uri)
            .toBe('rtsp://camera.example:554/sub');
    });
});

describe('GetSnapshotUri', () => {
    const server  = makeServer();
    const handler = server.onvif.MediaService.Media.GetSnapshotUri;

    it('returns MediaUri object', () => {
        const res = handler({ ProfileToken: 'main_stream' });
        expect(res.MediaUri).toBeDefined();
    });

    it('URI starts with http://', () => {
        const res = handler({ ProfileToken: 'main_stream' });
        expect(res.MediaUri.Uri).toMatch(/^http:\/\//);
    });

    it('has Timeout field', () => {
        const res = handler({ ProfileToken: 'main_stream' });
        expect(res.MediaUri.Timeout).toBeDefined();
    });

    it('advertises a JPEG generated from RTSP when no snapshot URL is configured', () => {
        const direct = makeServer({
            highQuality: { ...buildConfig().highQuality, rtsp: 'rtsp://camera.example/main', snapshot: undefined }
        });
        expect(direct.onvif.MediaService.Media.GetSnapshotUri({ ProfileToken: 'main_stream' }).MediaUri.Uri)
            .toBe('http://192.168.1.100:8081/snapshot.jpg?profile=main_stream');
        expect(handler({ ProfileToken: 'main_stream' }).MediaUri.Uri)
            .toBe('http://192.168.1.100:8580/onvif/snapshot');
    });
});

describe('Audio handlers (no audio config)', () => {
    const server = makeServer();

    it('GetAudioSources returns empty array when audio not configured', () => {
        const res = server.onvif.MediaService.Media.GetAudioSources({});
        expect(res.AudioSources).toEqual([]);
    });

    it('GetAudioEncoderConfigurations returns empty array when audio not configured', () => {
        const res = server.onvif.MediaService.Media.GetAudioEncoderConfigurations({});
        expect(res.Configurations).toEqual([]);
    });
});

describe('Audio handlers (audio: true)', () => {
    const server = makeServer({ audio: true });

    it('GetAudioSources returns one source', () => {
        const res = server.onvif.MediaService.Media.GetAudioSources({});
        expect(res.AudioSources.length).toBe(1);
    });

    it('GetAudioEncoderConfigurations returns AAC config', () => {
        const res = server.onvif.MediaService.Media.GetAudioEncoderConfigurations({});
        expect(res.Configurations[0].Encoding).toBe('AAC');
    });

    it('profiles include AudioSourceConfiguration', () => {
        const profiles = server.onvif.MediaService.Media.GetProfiles({}).Profiles;
        expect(profiles[0].AudioSourceConfiguration).toBeDefined();
    });
});

describe('Discovery response XML', () => {
    const server = makeServer();

    it('produces valid XML string', () => {
        const xml = server._buildDiscoveryResponse('urn:uuid:test-probe-id', 0);
        expect(typeof xml).toBe('string');
        expect(xml).toContain('<?xml');
        expect(xml).toContain('ProbeMatches');
    });

    it('contains correct uuid', () => {
        const xml = server._buildDiscoveryResponse('urn:uuid:test', 0);
        expect(xml).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('contains NetworkVideoTransmitter type', () => {
        const xml = server._buildDiscoveryResponse('urn:uuid:test', 0);
        expect(xml).toContain('NetworkVideoTransmitter');
    });

    it('contains correct XAddrs', () => {
        const xml = server._buildDiscoveryResponse('urn:uuid:test', 0);
        expect(xml).toContain('192.168.1.100:8081');
    });

    it('RelatesTo echoes the probe UUID', () => {
        const xml = server._buildDiscoveryResponse('urn:uuid:my-probe', 0);
        expect(xml).toContain('urn:uuid:my-probe');
    });

    it('has correct SOAP 1.2 envelope namespace', () => {
        const xml = server._buildDiscoveryResponse('urn:uuid:test', 0);
        expect(xml).toContain('http://www.w3.org/2003/05/soap-envelope');
    });

    it('includes camera name in scopes', () => {
        const xml = server._buildDiscoveryResponse('urn:uuid:test', 0);
        expect(xml).toContain('TestCamera');
    });

    it('increments MessageNumber', () => {
        const xml0 = server._buildDiscoveryResponse('probe', 0);
        const xml5 = server._buildDiscoveryResponse('probe', 5);
        expect(xml0).toContain('MessageNumber="0"');
        expect(xml5).toContain('MessageNumber="5"');
    });
});

describe('Live SOAP services', () => {
    const server = makeServer({
        hostname: '127.0.0.1',
        ports: { server: 19081, rtsp: 19554, snapshot: 19580 }
    });

    describe('Verbose diagnostics', () => {
        const diagnosticLogs = [];
        const diagnosticLogger = {
            debug: message => diagnosticLogs.push(message),
            info: () => {},
            warn: message => diagnosticLogs.push(message),
            error: message => diagnosticLogs.push(message),
            trace: () => {}
        };
        const server = OnvifServerModule.createServer(buildConfig({
            hostname: '127.0.0.1',
            ports: { server: 19085, rtsp: 19559, snapshot: 19585 }
        }), diagnosticLogger);

        beforeAll(() => {
            server.startServer();
            server.enableDebugOutput();
        });

        afterAll(async () => {
            await server.shutdown();
        });

        it('logs every HTTP endpoint response without query-string values', async () => {
            diagnosticLogs.length = 0;
            const response = await httpRequest({
                hostname: '127.0.0.1', port: 19085, path: '/not-a-route?token=private-value', method: 'GET'
            });

            expect(response.statusCode).toBe(404);
            expect(diagnosticLogs.join('\n')).toContain('HTTP request: GET /not-a-route');
            expect(diagnosticLogs.join('\n')).toContain('HTTP response: GET /not-a-route → 404');
            expect(diagnosticLogs.join('\n')).not.toContain('private-value');
        });

        it('logs GetProfile request details and the selected fallback profile', async () => {
            diagnosticLogs.length = 0;
            const client = await soap.createClientAsync(MEDIA_WSDL_CLIENT_PATH, { forceSoap12Headers: true });

            try {
                client.setEndpoint('http://127.0.0.1:19085/onvif/media_service');
                const [response] = await client.GetProfileAsync({ ProfileToken: 'not-a-profile' });
                expect(response.Profile.attributes.token).toBe('main_stream');
                expect(diagnosticLogs.join('\n')).toContain('GetProfile token="not-a-profile"');
                expect(diagnosticLogs.join('\n')).toContain('falling back to main_stream');
                expect(diagnosticLogs.join('\n')).toContain('HTTP response: POST /onvif/media_service → 200');
            } finally {
                if (client.httpClient && client.httpClient.agent && typeof client.httpClient.agent.destroy === 'function') {
                    client.httpClient.agent.destroy();
                }
            }
        });

        it('logs GetProfiles response status and count without exposing profile data', async () => {
            diagnosticLogs.length = 0;
            const client = await soap.createClientAsync(MEDIA_WSDL_CLIENT_PATH, { forceSoap12Headers: true });
            try {
                client.setEndpoint('http://127.0.0.1:19085/onvif/media_service');
                const [response] = await client.GetProfilesAsync({});
                expect(response.Profiles).toHaveLength(2);
                expect(diagnosticLogs.join('\n')).toMatch(/MediaService: GetProfiles response → HTTP 200 \(\d+ bytes, 2 profiles\)/);
                expect(diagnosticLogs.join('\n')).not.toContain('SN-TEST-0001');
            } finally {
                if (client.httpClient && client.httpClient.agent && typeof client.httpClient.agent.destroy === 'function') {
                    client.httpClient.agent.destroy();
                }
            }
        });

        it('logs SOAP faults by status without logging the fault payload', async () => {
            diagnosticLogs.length = 0;
            const body = '<?xml version="1.0"?>' +
                '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" ' +
                'xmlns:tds="http://www.onvif.org/ver10/device/wsdl">' +
                '<soap:Body><tds:GetUnsupportedOperation/></soap:Body></soap:Envelope>';
            const response = await httpRequest({
                hostname: '127.0.0.1', port: 19085, path: '/onvif/device_service',
                method: 'POST',
                headers: { 'Content-Type': 'application/soap+xml', 'Content-Length': Buffer.byteLength(body) }
            }, body);

            expect(response.statusCode).toBe(500);
            expect(diagnosticLogs.join('\n')).toMatch(/DeviceService: SOAP Fault or unknown response → HTTP 500 \(\d+ bytes\)/);
            expect(diagnosticLogs.join('\n')).not.toContain('The requested ONVIF operation is not supported.');
        });

        it('redacts authentication values but retains SOAP request parameters', () => {
            diagnosticLogs.length = 0;
            server._logSoapRequest('MediaService',
                '<Envelope><Body><GetProfile><ProfileToken>main_stream</ProfileToken>' +
                '<Username>admin</Username><Password>example-password</Password></GetProfile></Body></Envelope>',
                'GetProfile');

            expect(diagnosticLogs.join('\n')).toContain('<ProfileToken>main_stream</ProfileToken>');
            expect(diagnosticLogs.join('\n')).toContain('<Password>[REDACTED]</Password>');
            expect(diagnosticLogs.join('\n')).not.toContain('example-password');
            expect(diagnosticLogs.join('\n')).not.toContain('admin');
        });

        it('redacts RTSP URL credentials and query values from URI diagnostics', () => {
            const rtspUri = `rtsp:${'//'}admin:private-password@camera.example/stream?token=private-token`;
            const direct = OnvifServerModule.createServer(buildConfig({
                highQuality: { ...buildConfig().highQuality, rtsp: rtspUri }
            }), diagnosticLogger);
            direct.debugLogging = true;
            diagnosticLogs.length = 0;

            const response = direct.onvif.MediaService.Media.GetStreamUri({ ProfileToken: 'main_stream' });

            expect(response.MediaUri.Uri).toBe(rtspUri);
            expect(diagnosticLogs.join('\n')).toContain('rtsp://camera.example/stream');
            expect(diagnosticLogs.join('\n')).not.toContain('private-password');
            expect(diagnosticLogs.join('\n')).not.toContain('private-token');
            expect(diagnosticLogs.join('\n')).not.toContain('admin');
        });
    });

    beforeAll(() => {
        server.startServer();
    });

    afterAll(async () => {
        await server.shutdown();
    });

    it('serves GetSystemDateAndTime through the SOAP device endpoint', async () => {
        const client = await soap.createClientAsync(DEVICE_WSDL_CLIENT_PATH, { forceSoap12Headers: true });

        try {
            client.setEndpoint('http://127.0.0.1:19081/onvif/device_service');
            const [res] = await client.GetSystemDateAndTimeAsync({});
            expect(res.SystemDateAndTime).toBeDefined();
            expect(res.SystemDateAndTime.UTCDateTime).toBeDefined();
        } finally {
            if (client.httpClient && client.httpClient.agent && typeof client.httpClient.agent.destroy === 'function') {
                client.httpClient.agent.destroy();
            }
        }
    });

    it('serves GetProfiles through the SOAP media endpoint', async () => {
        const client = await soap.createClientAsync(MEDIA_WSDL_CLIENT_PATH, { forceSoap12Headers: true });

        try {
            client.setEndpoint('http://127.0.0.1:19081/onvif/media_service');
            const [res] = await client.GetProfilesAsync({});
            expect(Array.isArray(res.Profiles)).toBe(true);
            expect(res.Profiles[0].attributes.token).toBe('main_stream');
        } finally {
            if (client.httpClient && client.httpClient.agent && typeof client.httpClient.agent.destroy === 'function') {
                client.httpClient.agent.destroy();
            }
        }
    });

    it('serves WSDL with the active device endpoint address', async () => {
        const wsdl = await new Promise((resolve, reject) => {
            http.get('http://127.0.0.1:19081/onvif/device_service?wsdl', res => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => resolve(data));
            }).on('error', reject);
        });

        expect(wsdl).toContain('http://127.0.0.1:19081/onvif/device_service');
    });

    it('serves WSDL with the active media endpoint address', async () => {
        const wsdl = await new Promise((resolve, reject) => {
            http.get('http://127.0.0.1:19081/onvif/media_service?wsdl', res => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => resolve(data));
            }).on('error', reject);
        });

        expect(wsdl).toContain('http://127.0.0.1:19081/onvif/media_service');
    });

    it('preserves snapshot.png bytes', async () => {
        const expected = fs.readFileSync(SNAPSHOT_PATH);
        const response = await httpRequest({
            hostname: '127.0.0.1',
            port: 19081,
            path: '/snapshot.png',
            method: 'GET'
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('image/png');
        expect(response.body.equals(expected)).toBe(true);
    });

    it('generates JPEG snapshots from a configured RTSP URL', async () => {
        const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
        const mock = jest.spyOn(childProcess, 'execFile').mockImplementation((_file, _args, _opts, cb) => {
            cb(null, image);
        });
        const direct = makeServer({
            hostname: '127.0.0.1',
            ports: { server: 19082, rtsp: 19555 },
            highQuality: { ...buildConfig().highQuality, rtsp: 'rtsp://camera.example/main', snapshot: undefined }
        });
        direct.startServer();
        try {
            const res = await httpRequest({
                hostname: '127.0.0.1', port: 19082, path: '/snapshot.jpg?profile=main_stream', method: 'GET'
            });
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toBe('image/jpeg');
            expect(res.body.equals(image)).toBe(true);
            expect(mock).toHaveBeenCalledWith('ffmpeg',
                expect.arrayContaining(['-i', 'rtsp://camera.example/main']),
                expect.objectContaining({ timeout: 10000 }), expect.any(Function));
        } finally {
            await direct.shutdown();
            mock.mockRestore();
        }
    });

    it('returns a gateway error when FFmpeg cannot retrieve a frame', async () => {
        const mock = jest.spyOn(childProcess, 'execFile').mockImplementation((_file, _args, _opts, cb) => {
            cb(new Error('failed'), Buffer.alloc(0));
        });
        const direct = makeServer({
            hostname: '127.0.0.1',
            ports: { server: 19083, rtsp: 19555 },
            highQuality: { ...buildConfig().highQuality, rtsp: 'rtsp://camera.example/main', snapshot: undefined }
        });
        direct.startServer();
        try {
            const res = await httpRequest({
                hostname: '127.0.0.1', port: 19083, path: '/snapshot.jpg', method: 'GET'
            });
            expect(res.statusCode).toBe(502);
        } finally {
            await direct.shutdown();
            mock.mockRestore();
        }
    });

    it('limits concurrent FFmpeg snapshot processes', async () => {
        let finish;
        let started;
        const running = new Promise(resolve => { started = resolve; });
        const mock = jest.spyOn(childProcess, 'execFile').mockImplementation((_file, _args, _opts, cb) => {
            finish = cb;
            started();
        });
        const direct = makeServer({
            hostname: '127.0.0.1',
            ports: { server: 19084, rtsp: 19555 },
            highQuality: { ...buildConfig().highQuality, rtsp: 'rtsp://camera.example/main', snapshot: undefined }
        });
        direct.startServer();
        try {
            const options = { hostname: '127.0.0.1', port: 19084, path: '/snapshot.jpg', method: 'GET' };
            const first = httpRequest(options);
            await running;
            const second = await httpRequest(options);
            expect(second.statusCode).toBe(503);
            expect(mock).toHaveBeenCalledTimes(1);
            finish(null, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
            expect((await first).statusCode).toBe(200);
        } finally {
            await direct.shutdown();
            mock.mockRestore();
        }
    });

    it('does not duplicate SOAP namespace declarations', async () => {
        const requestBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
  <soap:Body>
    <tds:GetSystemDateAndTime/>
  </soap:Body>
</soap:Envelope>`;
        const response = await httpRequest({
            hostname: '127.0.0.1',
            port: 19081,
            path: '/onvif/device_service',
            method: 'POST',
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8',
                'Content-Length': Buffer.byteLength(requestBody)
            }
        }, requestBody);
        const xml = response.body.toString('utf8');

        expect(response.statusCode).toBe(200);
        expect((xml.match(/xmlns:tds=/g) || []).length).toBe(1);
        expect((xml.match(/xmlns:tt=/g) || []).length).toBe(1);
        expect(xml).toContain('<tds:GetSystemDateAndTimeResponse');
        expect(xml).toContain('<tt:SystemDateAndTime>');
    });

    it.each([
        ['/onvif/device_service', 'tds', 'http://www.onvif.org/ver10/device/wsdl', 'GetSystemUris'],
        ['/onvif/media_service', 'trt', 'http://www.onvif.org/ver10/media/wsdl', 'GetOSDs']
    ])('returns an ONVIF fault for unsupported operations on %s', async (endpoint, prefix, namespace, operation) => {
        const requestBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:${prefix}="${namespace}">
  <soap:Body>
    <${prefix}:${operation}/>
  </soap:Body>
</soap:Envelope>`;
        const response = await httpRequest({
            hostname: '127.0.0.1',
            port: 19081,
            path: endpoint,
            method: 'POST',
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8',
                'Content-Length': Buffer.byteLength(requestBody)
            }
        }, requestBody);
        const xml = response.body.toString('utf8');

        expect(response.statusCode).toBe(500);
        expect(xml).toContain('ter:ActionNotSupported');
        expect(xml).toContain('The requested ONVIF operation is not supported.');
        expect(xml).not.toContain('TypeError');
        expect(xml).not.toContain('node_modules');
    });
});
