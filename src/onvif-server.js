'use strict';

const soap  = require('soap');
const http  = require('http');
const dgram = require('dgram');
const xml2js = require('xml2js');
const uuid  = require('node-uuid');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const childProcess = require('child_process');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// Timezone helpers — isolated so we don't pollute Date.prototype globally
// ---------------------------------------------------------------------------
function getStdTimezoneOffset(d) {
    const jan = new Date(d.getFullYear(), 0, 1);
    const jul = new Date(d.getFullYear(), 6, 1);
    return Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
}

function isDstObserved(d) {
    return d.getTimezoneOffset() < getStdTimezoneOffset(d);
}

function buildTzString(d) {
    const offset    = d.getTimezoneOffset();
    const absOffset = Math.abs(offset);
    const hrs       = Math.floor(absOffset / 60);
    const mins      = absOffset % 60;
    // POSIX TZ sign is inverted vs ISO 8601
    const sign = offset <= 0 ? '+' : '-';
    return `UTC${sign}${hrs}${mins === 0 ? '' : ':' + String(mins).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Resolve IP from MAC address (optional — hostname may be supplied directly)
// ---------------------------------------------------------------------------
function getIpAddressFromMac(macAddress) {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const net of ifaces[name]) {
            if (net.family === 'IPv4' && net.mac.toLowerCase() === macAddress.toLowerCase()) {
                return net.address;
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// ONVIF XML Namespace Normalization
// Ensures payload elements use standard tt: (http://www.onvif.org/ver10/schema)
// so strict ONVIF parsers (Dahua, Hikvision, etc.) can deserialize profiles.
// ---------------------------------------------------------------------------
const ROOT_SOAP_RESPONSES = new Set([
    'GetProfilesResponse', 'GetProfileResponse', 'GetVideoSourcesResponse', 'GetVideoSourceConfigurationsResponse',
    'GetVideoSourceConfigurationResponse', 'GetVideoSourceConfigurationOptionsResponse', 'GetVideoEncoderConfigurationsResponse',
    'GetVideoEncoderConfigurationResponse', 'GetVideoEncoderConfigurationOptionsResponse', 'GetGuaranteedNumberOfVideoChannelsResponse',
    'GetAudioSourcesResponse', 'GetAudioSourceConfigurationsResponse', 'GetAudioEncoderConfigurationsResponse',
    'GetAudioEncoderConfigurationResponse', 'GetAudioEncoderConfigurationOptionsResponse', 'GetCompatibleVideoEncoderConfigurationsResponse',
    'GetCompatibleVideoSourceConfigurationsResponse', 'GetCompatibleAudioEncoderConfigurationsResponse', 'GetCompatibleAudioSourceConfigurationsResponse',
    'GetVideoAnalyticsConfigurationsResponse', 'GetMetadataConfigurationsResponse', 'GetMetadataConfigurationOptionsResponse',
    'GetAudioOutputsResponse', 'GetAudioOutputConfigurationsResponse', 'GetSnapshotUriResponse', 'GetStreamUriResponse',
    'GetCapabilitiesResponse', 'GetServiceCapabilitiesResponse', 'GetServicesResponse', 'GetDeviceInformationResponse',
    'GetNetworkInterfacesResponse', 'GetUsersResponse', 'GetScopesResponse', 'GetNetworkDefaultGatewayResponse',
    'GetDNSResponse', 'GetNTPResponse', 'GetHostnameResponse', 'GetNetworkProtocolsResponse', 'GetDiscoveryModeResponse',
    'GetRelayOutputsResponse', 'GetDynamicDNSResponse', 'GetWsdlUrlResponse', 'SystemRebootResponse',
    'GetSystemDateAndTimeResponse', 'SetSystemDateAndTimeResponse'
]);

const ONVIF_SCHEMA_NS = 'http://www.onvif.org/ver10/schema';
const ONVIF_MEDIA_WSDL_NS = 'http://www.onvif.org/ver10/media/wsdl';
const ONVIF_DEVICE_WSDL_NS = 'http://www.onvif.org/ver10/device/wsdl';
const ONVIF_DEFAULT_NAMESPACES = new Set([
    ONVIF_SCHEMA_NS,
    ONVIF_MEDIA_WSDL_NS,
    ONVIF_DEVICE_WSDL_NS
]);

function getSoapResponsePrefix(tag) {
    return tag.startsWith('GetCapabilities') || tag.startsWith('GetServices') ||
           tag.startsWith('GetDevice') || tag.startsWith('GetNetwork') ||
           tag.startsWith('GetUsers') || tag.startsWith('GetScopes') ||
           tag.startsWith('GetDNS') || tag.startsWith('GetNTP') ||
           tag.startsWith('GetHostname') || tag.startsWith('GetDiscovery') ||
           tag.startsWith('GetRelay') || tag.startsWith('GetDynamic') ||
           tag.startsWith('GetWsdl') || tag.startsWith('GetServiceCapabilities') || tag.startsWith('System') ||
           tag.startsWith('SetSystem') || tag.startsWith('GetSystemDate') ? 'tds' : 'trt';
}

function stripDefaultOnvifNamespace(suffix) {
    return suffix
        .replace(` xmlns="${ONVIF_DEVICE_WSDL_NS}"`, '')
        .replace(` xmlns="${ONVIF_MEDIA_WSDL_NS}"`, '')
        .replace(` xmlns="${ONVIF_SCHEMA_NS}"`, '');
}

function normalizeDefaultOnvifTags(body) {
    const defaultNamespaceStack = [];

    return body.replace(/<(\/?)(?:([a-zA-Z0-9_]+):)?([a-zA-Z0-9_]+)([^>]*)>/g, (match, slash, tagPrefix, tag, suffix) => {
        const isClosingTag = slash === '/';
        const isSelfClosingTag = !isClosingTag && /\/\s*$/.test(suffix);
        const currentDefaultNamespace = defaultNamespaceStack.length > 0
            ? defaultNamespaceStack[defaultNamespaceStack.length - 1]
            : null;
        const defaultNamespaceMatch = !isClosingTag ? suffix.match(/\sxmlns="([^"]*)"/) : null;
        const nextDefaultNamespace = defaultNamespaceMatch
            ? (defaultNamespaceMatch[1] || null)
            : currentDefaultNamespace;
        let nextMatch = match;

        if (!tagPrefix && tag !== 'Envelope' && tag !== 'Header' && tag !== 'Body' &&
            nextDefaultNamespace && ONVIF_DEFAULT_NAMESPACES.has(nextDefaultNamespace)) {
            const normalizedPrefix = ROOT_SOAP_RESPONSES.has(tag) ? getSoapResponsePrefix(tag) : 'tt';
            const nextSuffix = !isClosingTag ? stripDefaultOnvifNamespace(suffix) : suffix;
            nextMatch = `<${slash}${normalizedPrefix}:${tag}${nextSuffix}>`;
        }

        if (isClosingTag) {
            if (defaultNamespaceStack.length > 0) {
                defaultNamespaceStack.pop();
            }
        } else if (!isSelfClosingTag) {
            defaultNamespaceStack.push(nextDefaultNamespace);
        }

        return nextMatch;
    });
}

function fixOnvifNamespaces(body) {
    if (!body || (!body.includes('<soap:Envelope') && !body.includes(':Envelope'))) return body;

    const missingNamespaces = [];
    if (!/\sxmlns:tt=/.test(body)) {
        missingNamespaces.push(`xmlns:tt="${ONVIF_SCHEMA_NS}"`);
    }
    if (!/\sxmlns:trt=/.test(body)) {
        missingNamespaces.push(`xmlns:trt="${ONVIF_MEDIA_WSDL_NS}"`);
    }
    if (!/\sxmlns:tds=/.test(body)) {
        missingNamespaces.push(`xmlns:tds="${ONVIF_DEVICE_WSDL_NS}"`);
    }

    if (missingNamespaces.length > 0) {
        body = body.replace(
            /(<[a-zA-Z0-9_]*:?Envelope[^>]*)(>)/i,
            `$1 ${missingNamespaces.join(' ')}$2`
        );
    }

    body = body.replace(/<(\/?)(?:trt|tds):([a-zA-Z0-9_]+)(?=[>\s/])/g, (match, slash, tag) => {
        if (ROOT_SOAP_RESPONSES.has(tag)) {
            return `<${slash}${getSoapResponsePrefix(tag)}:${tag}`;
        }
        return `<${slash}tt:${tag}`;
    });

    return normalizeDefaultOnvifTags(body);
}

function getRequestPathname(request) {
    try {
        const parsed = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
        return parsed.pathname;
    } catch (_) {
        return (request.url || '/').split('?')[0];
    }
}

function sanitizeSoapXml(rawXml) {
    if (typeof rawXml !== 'string') return '';

    return rawXml
        .replace(/(<(?:[\w.-]+:)?(?:Username|Password|Nonce|Created)\b[^>]*>)[\s\S]*?(<\/(?:[\w.-]+:)?(?:Username|Password|Nonce|Created)\s*>)/gi, '$1[REDACTED]$2')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000);
}

function sanitizeUriForLog(uri) {
    try {
        const parsed = new URL(uri);
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch (_) {
        return String(uri).replace(/[?#].*$/, '').replace(/\/\/[^/@]+@/, '//[REDACTED]@');
    }
}

function wrapSoapHttpResponse(soapServer) {
    const origSendHttpResponse = soapServer._sendHttpResponse.bind(soapServer);
    soapServer._sendHttpResponse = (response, statusCode, result) => {
        const nextResult = typeof result === 'string' ? fixOnvifNamespaces(result) : result;
        return origSendHttpResponse(response, statusCode, nextResult);
    };
}

function wrapSoapRequestValidation(soapServer, handlers, logger, serviceName) {
    const supportedOperations = new Set(Object.keys(handlers));
    const origXmlToObject = soapServer.wsdl.xmlToObject.bind(soapServer.wsdl);

    soapServer.wsdl.xmlToObject = (xml, ...args) => {
        const bodyMatch = typeof xml === 'string'
            ? xml.match(/<(?:[\w.-]+:)?Body\b[^>]*>\s*<(?:[\w.-]+:)?([\w.-]+)\b/i)
            : null;
        const operation = bodyMatch && bodyMatch[1];

        if (operation && operation !== 'Fault' && !supportedOperations.has(operation)) {
            logger.warn(`${serviceName}: unsupported SOAP operation '${operation}'`);
            throw {
                Fault: {
                    Code: {
                        Value: 'soap:Sender',
                        Subcode: { Value: 'ter:ActionNotSupported' }
                    },
                    Reason: { Text: 'The requested ONVIF operation is not supported.' },
                    statusCode: 500
                }
            };
        }

        return origXmlToObject(xml, ...args);
    };
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------
const DEVICE_WSDL_PATH = path.join(__dirname, '..', 'wsdl', 'device_service.wsdl');
const MEDIA_WSDL_PATH  = path.join(__dirname, '..', 'wsdl', 'media_service.wsdl');
const SNAPSHOT_PATH    = path.join(__dirname, '..', 'resources', 'snapshot.png');
const DEVICE_WSDL_CLIENT_PATH = path.relative(process.cwd(), DEVICE_WSDL_PATH);
const MEDIA_WSDL_CLIENT_PATH  = path.relative(process.cwd(), MEDIA_WSDL_PATH);

function createCameraLogger(logger, cameraName) {
    const levels = ['info', 'debug', 'warn', 'error', 'trace'];
    const scopedLogger = {};

    for (const level of levels) {
        if (typeof logger[level] === 'function') {
            scopedLogger[level] = (message, ...args) =>
                logger[level](`[${cameraName}] ${message}`, ...args);
        }
    }

    return scopedLogger;
}

class OnvifServer {
    constructor(config, logger) {
        this.config = config;
        this.logger = config.name ? createCameraLogger(logger, config.name) : logger;

        // --- PR #26 additions ---
        this.snapshotCache       = null;
        this.snapshotInProgress  = false;
        this.debugListenersAdded = false;
        this.xmlParser           = new xml2js.Parser({ tagNameProcessors: [xml2js.processors.stripPrefix] });

        // --- PR #28 additions ---
        this.realPtzProfileToken = null;
        this.ptzTarget           = null;
        this.audioConfig         = null;

        // --- Hostname resolution ---
        // hostname may be set directly in config (preferred for Windows).
        // Fall back to MAC-to-IP resolution for Linux macvlan setups.
        if (!this.config.hostname) {
            if (this.config.mac) {
                this.config.hostname = getIpAddressFromMac(this.config.mac);
            }
        }

        // --- Device identity (Samsung-specific defaults) ---
        const deviceInfo = this.config.deviceInfo || {};
        this.manufacturer    = deviceInfo.manufacturer  || 'Samsung';
        this.model           = deviceInfo.model         || 'SNH-V6414N';
        this.firmwareVersion = deviceInfo.firmwareVersion || '2.10.00_b43';
        this.serialNumber    = deviceInfo.serialNumber  || `${(this.config.name || 'cam').replace(/\s+/g, '_')}-0000`;
        this.hardwareId      = deviceInfo.hardwareId    || `${this.model}-1001`;

        // --- Audio (PR #28) ---
        if (this.config.audio) {
            const audioOpts = typeof this.config.audio === 'object' ? this.config.audio : {};
            this.audioConfig = {
                encoding:   audioOpts.encoding   || 'AAC',
                bitrate:    audioOpts.bitrate     || 64,
                samplerate: audioOpts.samplerate  || 16
            };
            this.audioSource = {
                attributes: { token: 'audio_src_token' },
                Channels: 1
            };
            this.audioSourceConfiguration = {
                attributes: { token: 'audio_src_config_token' },
                Name:       'AudioSource',
                UseCount:   2,
                SourceToken: 'audio_src_token'
            };
            this.audioEncoderConfiguration = {
                attributes: { token: 'audio_encoder_config_token' },
                Name:       'SamsungAudioConfiguration',
                UseCount:   2,
                Encoding:   this.audioConfig.encoding,
                Bitrate:    this.audioConfig.bitrate,
                SampleRate: this.audioConfig.samplerate,
                SessionTimeout: 'PT1000S'
            };
        }

        // --- Video source ---
        this.videoSource = {
            attributes: { token: 'video_src_token' },
            Framerate:  this.config.highQuality.framerate,
            Resolution: {
                Width:  this.config.highQuality.width,
                Height: this.config.highQuality.height
            }
        };

        // --- Profiles ---
        this.profiles = [
            this._buildProfile('MainStream', 'main_stream', 'encoder_hq_config_token', this.config.highQuality)
        ];

        if (this.config.lowQuality) {
            this.profiles.push(
                this._buildProfile('SubStream', 'sub_stream', 'encoder_lq_config_token', this.config.lowQuality)
            );
        }

        // Inject audio into profiles (PR #28)
        if (this.audioConfig) {
            this.profiles = this.profiles.map(p => ({
                Name:                        p.Name,
                attributes:                  p.attributes,
                VideoSourceConfiguration:    p.VideoSourceConfiguration,
                AudioSourceConfiguration:    this.audioSourceConfiguration,
                VideoEncoderConfiguration:   p.VideoEncoderConfiguration,
                AudioEncoderConfiguration:   this.audioEncoderConfiguration
            }));
        }

        // --- SOAP service handlers ---
        this.onvif = {
            DeviceService: {
                Device: this._buildDeviceHandlers()
            },
            MediaService: {
                Media: this._buildMediaHandlers()
            }
        };
    }

    // -------------------------------------------------------------------------
    // Profile factory
    // -------------------------------------------------------------------------
    _buildProfile(name, token, encoderToken, quality) {
        return {
            Name:       name,
            attributes: { token, fixed: 'true' },
            VideoSourceConfiguration: {
                Name:     'VideoSource',
                UseCount: 2,
                attributes: { token: 'video_src_config_token' },
                SourceToken: 'video_src_token',
                Bounds: {
                    attributes: {
                        x: 0, y: 0,
                        width:  this.config.highQuality.width,
                        height: this.config.highQuality.height
                    }
                }
            },
            VideoEncoderConfiguration: {
                attributes: { token: encoderToken },
                Name:     `${this.model.replace(/[^a-zA-Z0-9]/g, '')}${name}`,
                UseCount: 1,
                Encoding: 'H264',
                Resolution: { Width: quality.width, Height: quality.height },
                Quality:    quality.quality,
                RateControl: {
                    FrameRateLimit:   quality.framerate,
                    EncodingInterval: 1,
                    BitrateLimit:     quality.bitrate
                },
                H264: {
                    GovLength:   quality.framerate,
                    H264Profile: 'Main'
                },
                Multicast: {
                    Address: {
                        Type: 'IPv4',
                        IPv4Address: '0.0.0.0'
                    },
                    Port: 0,
                    TTL: 1,
                    AutoStart: false
                },
                SessionTimeout: 'PT1000S'
            }
        };
    }

    // -------------------------------------------------------------------------
    // Device service handlers
    // -------------------------------------------------------------------------
    _buildDeviceHandlers() {
        return {
            GetSystemDateAndTime: (_args) => {
                const now = new Date();
                return {
                    SystemDateAndTime: {
                        DateTimeType:   'NTP',
                        DaylightSavings: isDstObserved(now),
                        TimeZone: {
                            TZ: buildTzString(now)
                        },
                        UTCDateTime: {
                            Time: { Hour: now.getUTCHours(), Minute: now.getUTCMinutes(), Second: now.getUTCSeconds() },
                            Date: { Year: now.getUTCFullYear(), Month: now.getUTCMonth() + 1, Day: now.getUTCDate() }
                        },
                        LocalDateTime: {
                            Time: { Hour: now.getHours(), Minute: now.getMinutes(), Second: now.getSeconds() },
                            Date: { Year: now.getFullYear(), Month: now.getMonth() + 1, Day: now.getDate() }
                        },
                        Extension: {}
                    }
                };
            },

            // Stub — DVRs often send this; respond with success
            SetSystemDateAndTime: (_args) => {
                return {};
            },

            GetCapabilities: (args) => {
                const cat = args ? args.Category : undefined;
                const all = !cat || cat === 'All';
                const response = { Capabilities: {} };

                if (all || cat === 'Device') {
                    response.Capabilities.Device = {
                        XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/device_service`,
                        Network: {
                            IPFilter:          false,
                            ZeroConfiguration: false,
                            IPVersion6:        false,
                            DynDNS:            false,
                            Extension: {
                                Dot11Configuration: false,
                                Extension: {}
                            }
                        },
                        System: {
                            DiscoveryResolve: false,
                            DiscoveryBye:     false,
                            RemoteDiscovery:  false,
                            SystemBackup:     false,
                            SystemLogging:    false,
                            FirmwareUpgrade:  false,
                            SupportedVersions: { Major: 2, Minor: 6 },
                            Extension: {
                                HttpFirmwareUpgrade:  false,
                                HttpSystemBackup:     false,
                                HttpSystemLogging:    false,
                                HttpSupportInformation: false,
                                Extension: {}
                            }
                        },
                        IO: {
                            InputConnectors: 0,
                            RelayOutputs:    0,
                            Extension: {
                                Auxiliary:         false,
                                AuxiliaryCommands: '',
                                Extension: {}
                            }
                        },
                        Security: {
                            'TLS1.1':             false,
                            'TLS1.2':             false,
                            OnboardKeyGeneration: false,
                            AccessPolicyConfig:   false,
                            'X.509Token':         false,
                            SAMLToken:            false,
                            KerberosToken:        false,
                            RELToken:             false,
                            Extension: {
                                'TLS1.0': false,
                                Extension: {
                                    Dot1X:              false,
                                    RemoteUserHandling: false
                                }
                            }
                        },
                        Extension: {}
                    };
                }

                if (all || cat === 'Media') {
                    response.Capabilities.Media = {
                        XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/media_service`,
                        StreamingCapabilities: {
                            RTPMulticast: false,
                            RTP_TCP:      true,
                            RTP_RTSP_TCP: true,
                            Extension:    {}
                        },
                        Extension: {
                            ProfileCapabilities: {
                                MaximumNumberOfProfiles: this.profiles.length
                            }
                        }
                    };
                }

                if (this.config.ptz && (all || cat === 'PTZ')) {
                    response.Capabilities.PTZ = {
                        XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/ptz_service`
                    };
                }

                return response;
            },

            GetServices: (args) => {
                const services = [
                    {
                        Namespace: 'http://www.onvif.org/ver10/device/wsdl',
                        XAddr:     `http://${this.config.hostname}:${this.config.ports.server}/onvif/device_service`,
                        Version:   { Major: 2, Minor: 6 }
                    },
                    {
                        Namespace: 'http://www.onvif.org/ver10/media/wsdl',
                        XAddr:     `http://${this.config.hostname}:${this.config.ports.server}/onvif/media_service`,
                        Version:   { Major: 2, Minor: 6 }
                    }
                ];

                if (this.config.ptz) {
                    services.push({
                        Namespace: 'http://www.onvif.org/ver20/ptz/wsdl',
                        XAddr:     `http://${this.config.hostname}:${this.config.ports.server}/onvif/ptz_service`,
                        Version:   { Major: 2, Minor: 6 }
                    });
                }

                return { Service: services };
            },

            GetServiceCapabilities: (_args) => {
                return {
                    Capabilities: {
                        attributes: {
                            NetworkCapabilities:  false,
                            SecurityCapabilities: false,
                            SystemCapabilities:   true,
                            'tds:MiscCapabilities': false
                        }
                    }
                };
            },

            GetDeviceInformation: (_args) => {
                return {
                    Manufacturer:    this.manufacturer,
                    Model:           this.model,
                    FirmwareVersion: this.firmwareVersion,
                    SerialNumber:    this.serialNumber,
                    HardwareId:      this.hardwareId
                };
            },

            // Required by many strict ONVIF clients (Dahua XVR probes this)
            GetNetworkInterfaces: (_args) => {
                return {
                    NetworkInterfaces: [
                        {
                            attributes: { token: 'eth0' },
                            Enabled: true,
                            Info: {
                                Name:        'eth0',
                                HwAddress:   this.config.mac || '00:00:00:00:00:00',
                                MTU:         1500
                            },
                            IPv4: {
                                Enabled: true,
                                Config: {
                                    Manual: {
                                        Address:      this.config.hostname,
                                        PrefixLength: 24
                                    },
                                    DHCP: true
                                }
                            }
                        }
                    ]
                };
            },

            // Return empty user list — avoids auth errors from strict clients
            GetUsers: (_args) => {
                return { User: [] };
            },

            // Return scopes matching this camera's identity
            GetScopes: (_args) => {
                const camName = (this.config.name || 'Camera').replace(/\s+/g, '');
                return {
                    Scopes: [
                        { ScopeDef: 'Fixed', ScopeItem: 'onvif://www.onvif.org/type/video_encoder' },
                        { ScopeDef: 'Fixed', ScopeItem: `onvif://www.onvif.org/name/${camName}` },
                        { ScopeDef: 'Fixed', ScopeItem: 'onvif://www.onvif.org/location/home' },
                        { ScopeDef: 'Fixed', ScopeItem: `onvif://www.onvif.org/hardware/${this.model}` },
                        { ScopeDef: 'Fixed', ScopeItem: `onvif://www.onvif.org/Profile/Streaming` }
                    ]
                };
            },

            // Stub — Dahua may probe this
            GetNetworkDefaultGateway: (_args) => {
                return { NetworkGateway: { IPv4Address: '', IPv6Address: '' } };
            },

            // Stub — respond gracefully
            GetDNS: (_args) => {
                return { DNSInformation: { FromDHCP: true, SearchDomain: '', DNSManual: '' } };
            },

            GetNTP: (_args) => {
                return { NTPInformation: { FromDHCP: true } };
            },

            GetHostname: (_args) => {
                return {
                    HostnameInformation: {
                        FromDHCP: true,
                        Name:     (this.config.name || 'Camera').replace(/\s+/g, '')
                    }
                };
            },

            GetNetworkProtocols: (_args) => {
                return {
                    NetworkProtocols: [
                        { Name: 'HTTP', Enabled: true, Port: this.config.ports.server },
                        { Name: 'RTSP', Enabled: true, Port: this.config.ports.rtsp }
                    ]
                };
            },

            GetDiscoveryMode: (_args) => {
                return { DiscoveryMode: 'Discoverable' };
            },

            GetRelayOutputs: (_args) => {
                return { RelayOutputs: [] };
            },

            GetDynamicDNS: (_args) => {
                return { DynamicDNSInformation: { Type: 'NoUpdate' } };
            },

            GetWsdlUrl: (_args) => {
                return { WsdlUrl: 'http://www.onvif.org/onvif/ver10/device/wsdl/devicemgmt.wsdl' };
            },

            // Stub reboot — respond success, do nothing
            SystemReboot: (_args) => {
                return { Message: 'Rebooting' };
            }
        };
    }

    // -------------------------------------------------------------------------
    // Media service handlers
    // -------------------------------------------------------------------------
    _buildMediaHandlers() {
        return {
            GetProfiles: (_args) => {
                return { Profiles: this.profiles };
            },

            GetProfile: (args) => {
                const token   = args && args.ProfileToken;
                const profile = this.profiles.find(p => p.attributes.token === token);
                if (this.debugLogging) {
                    this.logger.debug(`MediaService: GetProfile token="${token || '(missing)'}" → ${profile ? 'matched' : 'not found; falling back to main_stream'}`);
                }
                return { Profile: profile || this.profiles[0] };
            },

            GetVideoSources: (_args) => {
                return { VideoSources: [ this.videoSource ] };
            },

            GetGuaranteedNumberOfVideoChannels: (_args) => {
                return {
                    NumOfVideoChannels: 1
                };
            },

            GetVideoSourceConfigurations: (_args) => {
                return { Configurations: this.profiles.map(p => p.VideoSourceConfiguration) };
            },

            GetVideoSourceConfiguration: (args) => {
                const token = args && args.ConfigurationToken;
                const config = this.profiles.map(p => p.VideoSourceConfiguration).find(c => c.attributes.token === token);
                return { Configuration: config || this.profiles[0].VideoSourceConfiguration };
            },

            GetVideoSourceConfigurationOptions: (_args) => {
                return {
                    Options: {
                        BoundsRange: {
                            XRange:      { Min: 0, Max: 0 },
                            YRange:      { Min: 0, Max: 0 },
                            WidthRange:  { Min: 640, Max: this.config.highQuality.width },
                            HeightRange: { Min: 360, Max: this.config.highQuality.height }
                        },
                        VideoSourceTokensAvailable: ['video_src_token'],
                        Extension: {}
                    }
                };
            },

            GetVideoEncoderConfigurations: (_args) => {
                return { Configurations: this.profiles.map(p => p.VideoEncoderConfiguration) };
            },

            GetVideoEncoderConfiguration: (args) => {
                const token = args && args.ConfigurationToken;
                const config = this.profiles.map(p => p.VideoEncoderConfiguration).find(c => c.attributes.token === token);
                return { Configuration: config || this.profiles[0].VideoEncoderConfiguration };
            },

            GetVideoEncoderConfigurationOptions: (_args) => {
                return {
                    Options: {
                        QualityRange: {
                            Min: 1,
                            Max: 6
                        },
                        H264: {
                            ResolutionsAvailable: [
                                { Width: 1920, Height: 1080 },
                                { Width: 1280, Height: 720 },
                                { Width: 640,  Height: 360 }
                            ],
                            GovLengthRange: { Min: 1, Max: 60 },
                            FrameRateRange: { Min: 1, Max: 30 },
                            EncodingIntervalRange: { Min: 1, Max: 1 },
                            H264ProfilesSupported: ['Main', 'High', 'Baseline']
                        },
                        Extension: {}
                    }
                };
            },

            // --- Audio (PR #28) ---
            GetAudioSources: (_args) => {
                return { AudioSources: this.audioConfig ? [ this.audioSource ] : [] };
            },

            GetAudioSourceConfigurations: (_args) => {
                return { Configurations: this.audioConfig ? [ this.audioSourceConfiguration ] : [] };
            },

            GetAudioEncoderConfigurations: (_args) => {
                return { Configurations: this.audioConfig ? [ this.audioEncoderConfiguration ] : [] };
            },

            GetAudioEncoderConfiguration: (_args) => {
                if (this.audioConfig) return { Configuration: this.audioEncoderConfiguration };
                return {};
            },

            GetAudioEncoderConfigurationOptions: (_args) => {
                if (!this.audioConfig) return { Options: {} };
                return {
                    Options: {
                        Options: [{
                            Encoding:        this.audioConfig.encoding,
                            BitrateList:     { Items: [ this.audioConfig.bitrate ] },
                            SampleRateList:  { Items: [ this.audioConfig.samplerate ] }
                        }]
                    }
                };
            },

            GetCompatibleVideoEncoderConfigurations: (_args) => {
                return { Configurations: this.profiles.map(p => p.VideoEncoderConfiguration) };
            },

            GetCompatibleVideoSourceConfigurations: (_args) => {
                return { Configurations: this.profiles.map(p => p.VideoSourceConfiguration) };
            },

            GetCompatibleAudioEncoderConfigurations: (_args) => {
                return { Configurations: this.audioConfig ? [ this.audioEncoderConfiguration ] : [] };
            },

            GetCompatibleAudioSourceConfigurations: (_args) => {
                return { Configurations: this.audioConfig ? [ this.audioSourceConfiguration ] : [] };
            },

            GetVideoAnalyticsConfigurations: (_args) => {
                return { Configurations: [] };
            },

            GetMetadataConfigurations: (_args) => {
                return { Configurations: [] };
            },

            GetMetadataConfigurationOptions: (_args) => {
                return { Options: {} };
            },

            GetAudioOutputs: (_args) => {
                return { AudioOutputs: [] };
            },

            GetAudioOutputConfigurations: (_args) => {
                return { Configurations: [] };
            },

            GetSnapshotUri: (args) => {
                const profileToken = args && args.ProfileToken;
                let uri = `http://${this.config.hostname}:${this.config.ports.server}/snapshot.png`;
                const quality = profileToken === 'sub_stream' && this.config.lowQuality
                    ? this.config.lowQuality : this.config.highQuality;

                const extractCleanPath = (p) => {
                    if (!p) return '';
                    if (p.includes('://')) {
                        try { return new URL(p).pathname; } catch (_) {
                            const idx = p.indexOf('/', p.indexOf('//') + 2);
                            return idx > -1 ? p.substring(idx) : p;
                        }
                    }
                    return p.startsWith('/') ? p : '/' + p;
                };

                if (quality.snapshot && this.config.ports.snapshot) {
                    uri = `http://${this.config.hostname}:${this.config.ports.snapshot}${extractCleanPath(quality.snapshot)}`;
                } else if (/^rtsp:\/\//i.test(quality.rtsp || '')) {
                    uri = `http://${this.config.hostname}:${this.config.ports.server}/snapshot.jpg?profile=${profileToken === 'sub_stream' ? 'sub_stream' : 'main_stream'}`;
                }

                if (this.debugLogging) {
                    this.logger.debug(`MediaService: GetSnapshotUri token="${profileToken || '(missing)'}" → ${sanitizeUriForLog(uri)}`);
                }
                return {
                    MediaUri: {
                        Uri:                  uri,
                        InvalidAfterConnect:  false,
                        InvalidAfterReboot:   false,
                        Timeout:              'PT30S'
                    }
                };
            },

            GetStreamUri: (args) => {
                const profileToken = args && args.ProfileToken;
                let rawPath = this.config.highQuality.rtsp;
                if (profileToken === 'sub_stream' && this.config.lowQuality) {
                    rawPath = this.config.lowQuality.rtsp;
                }

                let cleanPath = rawPath || '';
                if (cleanPath && !cleanPath.startsWith('/')) {
                    cleanPath = '/' + cleanPath;
                }

                const uri = /^rtsp:\/\//i.test(rawPath || '')
                    ? rawPath : `rtsp://${this.config.hostname}:${this.config.ports.rtsp}${cleanPath}`;
                if (this.debugLogging) {
                    this.logger.debug(`MediaService: GetStreamUri token="${profileToken || '(missing)'}" → ${sanitizeUriForLog(uri)}`);
                }
                return {
                    MediaUri: {
                        Uri: uri,
                        InvalidAfterConnect: false,
                        InvalidAfterReboot:  false,
                        Timeout:             'PT30S'
                    }
                };
            }
        };
    }

    // -------------------------------------------------------------------------
    // HTTP request handler
    // -------------------------------------------------------------------------
    _handleRequest(request, response) {
        const pathname = getRequestPathname(request);

        if (pathname === '/snapshot.jpg' && request.method === 'GET') {
            const profile = new URL(request.url, 'http://localhost').searchParams.get('profile');
            const quality = profile === 'sub_stream' && this.config.lowQuality
                ? this.config.lowQuality : this.config.highQuality;
            if (quality.snapshot || !/^rtsp:\/\//i.test(quality.rtsp || '')) {
                response.writeHead(404);
                response.end();
                return;
            }
            if (this.snapshotInProgress) {
                response.writeHead(503, { 'Retry-After': '1' });
                response.end();
                return;
            }
            this.snapshotInProgress = true;
            childProcess.execFile('ffmpeg', ['-nostdin', '-loglevel', 'error', '-rtsp_transport', 'tcp',
                '-i', quality.rtsp, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'],
            { encoding: 'buffer', timeout: 10000, maxBuffer: 10 * 1024 * 1024 },
            (err, stdout) => {
                this.snapshotInProgress = false;
                if (err || !stdout || !stdout.length) {
                const details = err
                    ? [err.code, err.signal, err.killed ? 'timed out' : null].filter(Boolean).join(', ')
                    : 'empty FFmpeg output';
                this.logger.error(`Failed to generate RTSP snapshot${details ? ` (${details})` : ''}`);
                response.writeHead(502);
                    response.end();
                    return;
                }
                response.writeHead(200, { 'Content-Type': 'image/jpeg' });
                response.end(stdout);
            });
            return;
        }

        if (pathname === '/snapshot.png') {
            // Cache snapshot image to avoid repeated disk I/O (PR #26)
            if (!this.snapshotCache) {
                try {
                    this.snapshotCache = fs.readFileSync(SNAPSHOT_PATH);
                } catch (err) {
                    this.logger.error('Failed to read snapshot.png: ' + err.message);
                    response.writeHead(500, { 'Content-Type': 'text/plain' });
                    response.end('Internal Server Error\n');
                    return;
                }
            }
            response.writeHead(200, { 'Content-Type': 'image/png' });
            response.end(this.snapshotCache, 'binary');
            return;
        }

        // PTZ passthrough (PR #28)
        if (this.config.ptz && pathname === '/onvif/ptz_service' && request.method === 'POST') {
            this._relayPtz(request, response);
            return;
        }

        // Allow SOAP routes to be handled by soap.listen
        if (pathname === '/onvif/device_service' || pathname === '/onvif/media_service') {
            return;
        }

        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.write('404 Not Found\n');
        response.end();
    }

    // -------------------------------------------------------------------------
    // PTZ relay (PR #28)
    // -------------------------------------------------------------------------
    _relayPtz(request, response) {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            if (!this.ptzTarget) {
                this.logger.warn('PtzService: request received before passthrough initialization');
                response.writeHead(502, { 'Content-Type': 'text/plain' });
                response.end('PTZ passthrough not initialised\n');
                return;
            }

            let body = Buffer.concat(chunks).toString('utf8');
            this.logger.debug(`PtzService: relaying ${body.length} request bytes to ${this.ptzTarget.hostname}:${this.ptzTarget.port}${this.ptzTarget.path}`);

            // Rewrite virtual profile tokens → real camera profile token
            if (this.realPtzProfileToken) {
                body = body.replace(
                    /(<[^>]*ProfileToken[^>]*>)\s*(?:main_stream|sub_stream)\s*(<\/[^>]*ProfileToken[^>]*>)/g,
                    `$1${this.realPtzProfileToken}$2`
                );
            }

            const relay = http.request({
                hostname: this.ptzTarget.hostname,
                port:     this.ptzTarget.port,
                path:     this.ptzTarget.path,
                method:   'POST',
                headers: {
                    'Content-Type':   request.headers['content-type'] || 'application/soap+xml; charset=utf-8',
                    'Content-Length': Buffer.byteLength(body)
                }
            }, relayResponse => {
                this.logger.debug(`PtzService: upstream response ${relayResponse.statusCode}`);
                response.writeHead(relayResponse.statusCode, {
                    'Content-Type': relayResponse.headers['content-type'] || 'application/soap+xml; charset=utf-8'
                });
                relayResponse.pipe(response);
            });

            relay.setTimeout(10000, () => relay.destroy(new Error('PTZ relay timeout')));
            relay.on('error', err => {
                this.logger.error(`PtzService relay error: ${err.message}`);
                if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain' });
                response.end();
            });
            relay.end(body);
        });
    }

    // -------------------------------------------------------------------------
    // PTZ startup discovery (PR #28)
    // -------------------------------------------------------------------------
    async startPtz() {
        const ptzConfig  = this.config.ptz;
        const onvifPort  = ptzConfig.port || 8000;
        const mediaEndpoint = `http://${this.config.target.hostname}:${onvifPort}/onvif/media_service`;
        const endpoint   = `http://${this.config.target.hostname}:${onvifPort}/onvif/device_service`;
        const soapOpts   = { forceSoap12Headers: true };
        const secOpts    = { hasNonce: true, passwordType: 'PasswordDigest' };

        const mediaClient = await soap.createClientAsync(MEDIA_WSDL_CLIENT_PATH, soapOpts);
        mediaClient.setEndpoint(mediaEndpoint);
        mediaClient.setSecurity(new soap.WSSecurity(ptzConfig.username, ptzConfig.password, secOpts));

        const profiles = (await mediaClient.GetProfilesAsync({}))[0].Profiles;
        let realProfile = null;

        for (const profile of profiles) {
            if (!profile.PTZConfiguration) continue;
            if (ptzConfig.profileToken) {
                if (profile.attributes.token === ptzConfig.profileToken) {
                    realProfile = profile;
                    break;
                }
            } else {
                realProfile = profile;
                break;
            }
        }

        if (!realProfile) {
            throw new Error('No camera profile with PTZConfiguration found' +
                (ptzConfig.profileToken ? ` (token '${ptzConfig.profileToken}')` : ''));
        }

        this.realPtzProfileToken = realProfile.attributes.token;
        for (const profile of this.profiles) {
            profile.PTZConfiguration = realProfile.PTZConfiguration;
        }

        // Discover real PTZ endpoint
        const devClient = await soap.createClientAsync(DEVICE_WSDL_CLIENT_PATH, soapOpts);
        devClient.setEndpoint(endpoint);
        devClient.setSecurity(new soap.WSSecurity(ptzConfig.username, ptzConfig.password, secOpts));

        let ptzPath = '/onvif/ptz_service';
        let ptzPort = onvifPort;

        try {
            const caps = (await devClient.GetCapabilitiesAsync({ Category: 'PTZ' }))[0];
            if (caps && caps.Capabilities && caps.Capabilities.PTZ && caps.Capabilities.PTZ.XAddr) {
                const xaddr = new URL(caps.Capabilities.PTZ.XAddr);
                ptzPath = xaddr.pathname || ptzPath;
                ptzPort = parseInt(xaddr.port) || (xaddr.protocol === 'https:' ? 443 : 80);
            }
        } catch (err) {
            this.logger.warn(`PtzService: GetCapabilities(PTZ) failed (${err.message}), using ${ptzPath}:${ptzPort}`);
        }

        this.ptzTarget = {
            hostname: this.config.target.hostname,
            port:     ptzPort,
            path:     ptzPath
        };

        return this.realPtzProfileToken;
    }

    _loadWsdl(wsdlPath, servicePath) {
        const serviceUrl = `http://${this.config.hostname}:${this.config.ports.server}${servicePath}`;
        return fs.readFileSync(wsdlPath, 'utf8')
            .replace(/(<soap12:address location=")[^"]+(")/, `$1${serviceUrl}$2`);
    }

    _logHttpRequest(request, response) {
        if (!this.debugLogging) return;
        const requestStarted = Date.now();
        const requestPath = getRequestPathname(request);
        const client = request.socket.remoteAddress || 'unknown';
        this.logger.debug(`HTTP request: ${request.method} ${requestPath} from ${client}`);
        response.once('finish', () => {
            const contentLength = response.getHeader('Content-Length');
            this.logger.debug(`HTTP response: ${request.method} ${requestPath} → ${response.statusCode}` +
                `${contentLength === undefined ? '' : ` (${contentLength} bytes)`}, ${Date.now() - requestStarted}ms`);
        });
        response.once('close', () => {
            if (!response.writableFinished) {
                this.logger.warn(`HTTP response closed before completion: ${request.method} ${requestPath} → ${response.statusCode || 'no status'}`);
            }
        });
    }

    _wrapSoapHttpDiagnostics(soapServer) {
        const origRequestListener = soapServer._requestListener.bind(soapServer);
        soapServer._requestListener = (request, response) => {
            this._logHttpRequest(request, response);
            return origRequestListener(request, response);
        };
    }

    // -------------------------------------------------------------------------
    // Start HTTP + SOAP services
    // -------------------------------------------------------------------------
    startServer() {
        this.server = http.createServer((request, response) => {
            this._logHttpRequest(request, response);

            const origWrite = response.write;
            const origEnd   = response.end;
            const chunks    = [];

            response.write = function(chunk, encoding, callback) {
                if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
                if (typeof callback === 'function') callback();
                return true;
            };

            response.end = function(chunk, encoding, callback) {
                if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
                const contentTypeHeader = response.getHeader('Content-Type') || response.getHeader('content-type') || '';
                const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader.join(';') : String(contentTypeHeader);
                const shouldTransform = /^(?:text\/xml|application\/xml|application\/soap\+xml)(?:\s*;|$)/i.test(contentType.trim());

                if (!shouldTransform) {
                    const body = Buffer.concat(chunks);
                    return origEnd.call(this, body, undefined, callback);
                }

                let body = Buffer.concat(chunks).toString('utf8');
                body = fixOnvifNamespaces(body);

                try {
                    response.setHeader('Content-Length', Buffer.byteLength(body));
                } catch (_) {}

                return origEnd.call(this, body, 'utf8', callback);
            };

            this._handleRequest(request, response);
        });

        this.server.on('error', err => {
            this.logger.error(`HTTP server error: ${err.message}`);
        });
        this.server.listen(this.config.ports.server, this.config.hostname);

        this.deviceService = soap.listen(this.server, {
            path:             '/onvif/device_service',
            services:         this.onvif,
            xml:              this._loadWsdl(DEVICE_WSDL_PATH, '/onvif/device_service'),
            forceSoap12Headers: true,
            suppressStack:     true
        });
        this._wrapSoapHttpDiagnostics(this.deviceService);
        wrapSoapRequestValidation(
            this.deviceService,
            this.onvif.DeviceService.Device,
            this.logger,
            'DeviceService'
        );
        wrapSoapHttpResponse(this.deviceService);

        this.mediaService = soap.listen(this.server, {
            path:             '/onvif/media_service',
            services:         this.onvif,
            xml:              this._loadWsdl(MEDIA_WSDL_PATH, '/onvif/media_service'),
            forceSoap12Headers: true,
            suppressStack:     true
        });
        this._wrapSoapHttpDiagnostics(this.mediaService);
        wrapSoapRequestValidation(
            this.mediaService,
            this.onvif.MediaService.Media,
            this.logger,
            'MediaService'
        );
        wrapSoapHttpResponse(this.mediaService);
    }

    // -------------------------------------------------------------------------
    // Debug output (PR #26: guard duplicate listeners + verbose Auth logging)
    // -------------------------------------------------------------------------
    _logSoapRequest(serviceName, rawXml, methodName) {
        let authInfo = 'None / Anonymous';
        if (typeof rawXml === 'string') {
            const userMatch    = rawXml.match(/<[^:]*:?Username[^>]*>([^<]+)<\/[^:]*:?Username>/i);
            const passMatch    = rawXml.match(/<[^:]*:?Password([^>]*)>([^<]*)<\/[^:]*:?Password>/i);
            const createdMatch = rawXml.match(/<[^:]*:?Created[^>]*>([^<]+)<\/[^:]*:?Created>/i);
            const nonceMatch   = rawXml.match(/<[^:]*:?Nonce[^>]*>([^<]+)<\/[^:]*:?Nonce>/i);

            if (userMatch) {
                const typeAttr = passMatch && passMatch[1] ? (passMatch[1].match(/Type="([^"]+)"/i) || [])[1] : '';
                const passType = typeAttr ? typeAttr.split('#').pop() : 'PasswordDigest';
                const hasPass  = passMatch && passMatch[2] ? 'Yes' : 'No';
                authInfo = `WS-Security [Username: present, Type: ${passType}, Digest: ${hasPass}, Nonce: ${nonceMatch ? 'present' : 'missing'}, Created: ${createdMatch ? 'present' : 'missing'}]`;
            }
        }
        const requestSummary = sanitizeSoapXml(rawXml);
        this.logger.debug(`${serviceName}: ${methodName.padEnd(35)} | ${authInfo}` +
            `${requestSummary ? ` | Request: ${requestSummary}` : ''}`);
    }

    enableDebugOutput() {
        this.debugLogging = true;
        if (this.debugListenersAdded) return;
        this.debugListenersAdded = true;

        this.deviceService.on('request', (rawXml, methodName) => {
            this._logSoapRequest('DeviceService', rawXml, methodName);
        });
        this.mediaService.on('request', (rawXml, methodName) => {
            this._logSoapRequest('MediaService', rawXml, methodName);
        });
    }

    // -------------------------------------------------------------------------
    // WS-Discovery (enhanced: reuse socket, stable UUID, correct scopes)
    // -------------------------------------------------------------------------
    startDiscovery() {
        this.discoveryMessageNo = 0;
        this.discoverySocket    = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        this.discoverySocket.on('error', err => {
            this.logger.error(`Discovery socket error: ${err.message}`);
        });

        this.discoverySocket.on('message', (message, remote) => {
            this.logger.debug(`Discovery: ${message.length} bytes from ${remote.address}:${remote.port}`);

            // PR #26: reuse the parser instance
            this.xmlParser.parseString(message.toString(), (err, result) => {
                if (err) {
                    this.logger.error(`Discovery XML parse error: ${err.message}`);
                    return;
                }

                let probeUuid = '';
                let probeType = '';

                try {
                    probeUuid = result['Envelope']['Header'][0]['MessageID'][0];
                    if (typeof probeUuid === 'object') probeUuid = probeUuid._;
                } catch (_) { /* malformed – send anyway */ }

                try {
                    probeType = result['Envelope']['Body'][0]['Probe'][0]['Types'][0];
                    if (typeof probeType === 'object') probeType = probeType._;
                } catch (_) { probeType = ''; }

                this.logger.debug(`Discovery: parsed Probe MessageID=${probeUuid || '(missing)'}, Types=${probeType || '(any)'}`);
                if (probeType === '' || probeType.indexOf('NetworkVideoTransmitter') > -1) {
                    const msgNo   = this.discoveryMessageNo++;
                    const xmlResp = this._buildDiscoveryResponse(probeUuid, msgNo);
                    const buf     = Buffer.from(xmlResp, 'utf8');

                    // PR #26: reuse socket, no ephemeral socket per response
                    this.discoverySocket.send(buf, 0, buf.length, remote.port, remote.address, sendErr => {
                        if (sendErr) this.logger.error(`Discovery send error: ${sendErr.message}`);
                        else this.logger.debug(`Discovery: sent ProbeMatch to ${remote.address}:${remote.port} (${buf.length} bytes, MessageNumber ${msgNo})`);
                    });
                } else {
                    this.logger.debug(`Discovery: ignored unsupported probe type '${probeType}'`);
                }
            });
        });

        this.discoverySocket.bind(3702, () => {
            try {
                this.discoverySocket.addMembership('239.255.255.250', this.config.hostname);
            } catch (err) {
                this.logger.error(`Discovery multicast join error: ${err.message}`);
            }
        });
    }

    // -------------------------------------------------------------------------
    // Discovery response XML
    // Uses s: / a: / d: prefixes matching proxy.py style (RFC compliant)
    // Scopes reflect actual config name and model
    // -------------------------------------------------------------------------
    _buildDiscoveryResponse(relatesTo, messageNo) {
        const camName  = (this.config.name || 'Camera').replace(/\s+/g, '');
        const xaddr    = `http://${this.config.hostname}:${this.config.ports.server}/onvif/device_service`;

        return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope
    xmlns:s="http://www.w3.org/2003/05/soap-envelope"
    xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
    xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
    xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <s:Header>
    <a:MessageID>uuid:${uuid.v4()}</a:MessageID>
    <a:RelatesTo>${relatesTo}</a:RelatesTo>
    <a:To s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:To>
    <a:Action s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</a:Action>
    <d:AppSequence s:mustUnderstand="true" MessageNumber="${messageNo}" InstanceId="1234567890"/>
  </s:Header>
  <s:Body>
    <d:ProbeMatches>
      <d:ProbeMatch>
        <a:EndpointReference>
          <a:Address>urn:uuid:${this.config.uuid}</a:Address>
        </a:EndpointReference>
        <d:Types>dn:NetworkVideoTransmitter</d:Types>
        <d:Scopes>
          onvif://www.onvif.org/type/video_encoder
          onvif://www.onvif.org/name/${camName}
          onvif://www.onvif.org/hardware/${this.model}
          onvif://www.onvif.org/location/home
          onvif://www.onvif.org/Profile/Streaming
        </d:Scopes>
        <d:XAddrs>${xaddr}</d:XAddrs>
        <d:MetadataVersion>1</d:MetadataVersion>
      </d:ProbeMatch>
    </d:ProbeMatches>
  </s:Body>
</s:Envelope>`;
    }

    // -------------------------------------------------------------------------
    // Graceful shutdown (PR #26)
    // -------------------------------------------------------------------------
    shutdown() {
        return new Promise(resolve => {
            let remaining = 2;
            const done = () => { if (--remaining <= 0) { this.logger.info(`Shutdown: ${this.config.name}`); resolve(); } };

            this.snapshotCache = null;

            if (this.server) {
                this.server.close(err => {
                    if (err) this.logger.error(`HTTP close error: ${err.message}`);
                    done();
                });
            } else {
                done();
            }

            if (this.discoverySocket) {
                try {
                    this.discoverySocket.close(() => done());
                } catch (err) {
                    this.logger.error(`Discovery socket close error: ${err.message}`);
                    done();
                }
            } else {
                done();
            }
        });
    }

    getHostname() {
        return this.config.hostname;
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
function createServer(config, logger) {
    return new OnvifServer(config, logger);
}

exports.createServer = createServer;
