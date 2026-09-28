'use strict';

const net          = require('net');
const onvifServer  = require('./src/onvif-server');
const configBuilder = require('./src/config-builder');
const pkg          = require('./package.json');
const argparse     = require('argparse');
const readline     = require('readline');
const stream       = require('stream');
const yaml         = require('yaml');
const fs           = require('fs');
const simpleLogger = require('simple-node-logger-se');

const parser = new argparse.ArgumentParser({
    description: 'Virtual ONVIF Server for Samsung cameras with Dahua DVR'
});

parser.add_argument('-v', '--version',       { action: 'store_true', help: 'Show version' });
parser.add_argument('-cc', '--create-config',{ action: 'store_true', help: 'Interactively generate a config from a real ONVIF camera' });
parser.add_argument('-d', '--debug',         { action: 'store_true', help: 'Enable SOAP request debug logging' });
parser.add_argument('config', { help: 'Path to onvif.yaml config file', nargs: '?' });

const args = parser.parse_args();

if (!args) process.exit(1);

const logger = simpleLogger.createSimpleLogger();
if (args.debug) logger.setLevel('trace');

function createTcpProxyServer(localPort, remoteHost, remotePort, logger, debugEnabled) {
    const connections = new Set();

    const destroySocket = (socket) => {
        if (!socket || socket.destroyed) return;
        socket.destroy();
    };

    const server = net.createServer(clientSocket => {
        const client = clientSocket.remoteAddress ? `${clientSocket.remoteAddress}:${clientSocket.remotePort}` : 'client';
        const upstreamSocket = net.connect({ host: remoteHost, port: remotePort });

        connections.add(clientSocket);
        connections.add(upstreamSocket);

        clientSocket.setKeepAlive(true, 15000);
        clientSocket.setNoDelay(true);
        upstreamSocket.setKeepAlive(true, 15000);
        upstreamSocket.setNoDelay(true);

        if (debugEnabled) {
            logger.debug(`TCP proxy :${localPort} → ${remoteHost}:${remotePort} | Client connected: ${client}`);
        }

        upstreamSocket.on('connect', () => {
            clientSocket.pipe(upstreamSocket);
            upstreamSocket.pipe(clientSocket);
        });

        const closePair = () => {
            connections.delete(clientSocket);
            connections.delete(upstreamSocket);
            destroySocket(clientSocket);
            destroySocket(upstreamSocket);
        };

        clientSocket.on('error', err => {
            logger.error(`TCP proxy :${localPort} client error: ${err.message}`);
            closePair();
        });

        upstreamSocket.on('error', err => {
            logger.error(`TCP proxy :${localPort} upstream error (${remoteHost}:${remotePort}): ${err.message}`);
            closePair();
        });

        clientSocket.on('close', () => {
            if (debugEnabled) {
                logger.debug(`TCP proxy :${localPort} → ${remoteHost}:${remotePort} | Client disconnected: ${client}`);
            }
            closePair();
        });

        upstreamSocket.on('close', closePair);
    });

    server.on('error', err => {
        logger.error(`TCP proxy :${localPort} server error: ${err.message}`);
    });

    server.listen(localPort, () => {
        try {
            server.keepAliveTimeout = 0;
        } catch (_) {}
    });

    server.shutdown = () => {
        for (const socket of connections) destroySocket(socket);
        connections.clear();
        server.close();
    };

    return server;
}

function exitWithError(msg) {
    logger.error(msg);
    setTimeout(() => process.exit(1), 50);
}

// ─── --version ───────────────────────────────────────────────────────────────
if (args.version) {
    console.log(`onvif-server-samsung v${pkg.version}`);
    process.exit(0);
}

// ─── --create-config ─────────────────────────────────────────────────────────
if (args.create_config) {
    const mutableStdout = new stream.Writable({
        write(chunk, encoding, callback) {
            if (!this.muted || chunk.toString().includes('\n'))
                process.stdout.write(chunk, encoding);
            callback();
        }
    });

    const rl = readline.createInterface({
        input:    process.stdin,
        output:   mutableStdout,
        terminal: true
    });

    mutableStdout.muted = false;

    rl.question('ONVIF Camera hostname (or host:port): ', hostname => {
        rl.question('ONVIF Username: ', username => {
            mutableStdout.muted = true;
            process.stdout.write('ONVIF Password: ');
            rl.question('', password => {
                console.log('\nGenerating config...');
                configBuilder.createConfig(hostname, username, password).then(config => {
                    if (config) {
                        console.log('\n# ==================== CONFIG START ====================');
                        console.log(yaml.stringify(config));
                        console.log('# ===================== CONFIG END =====================');
                    } else {
                        console.log('Failed to create config!');
                    }
                });
                rl.close();
            });
        });
    });

// ─── Run with config file ─────────────────────────────────────────────────────
} else if (args.config) {
    let configData;
    try {
        configData = fs.readFileSync(args.config, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            return exitWithError(`File not found: ${args.config}`);
        }
        throw err;
    }

    let config;
    try {
        config = yaml.parse(configData);
    } catch (_) {
        return exitWithError('Failed to parse config: invalid YAML.');
    }

    if (!config || !Array.isArray(config.onvif) || config.onvif.length === 0) {
        return exitWithError('Invalid configuration: "onvif" section is missing or empty. Please check your config file or refer to onvif.yaml.example.');
    }

    // Track instances for graceful shutdown (PR #26)
    const servers      = [];
    const proxyServers = [];
    const proxies      = {};

    for (const onvifConfig of config.onvif) {
        const server = onvifServer.createServer(onvifConfig, logger);

        if (!server.getHostname()) {
            return exitWithError(`Cannot resolve hostname for '${onvifConfig.name}'. ` +
                'Set "hostname:" directly in config (MAC lookup failed or mac omitted).');
        }

        logger.info(`Starting ONVIF server for '${onvifConfig.name}' on ${server.getHostname()}:${onvifConfig.ports.server} ...`);
        server.startServer();
        server.startDiscovery();

        if (args.debug) server.enableDebugOutput();

        // PTZ passthrough (PR #28)
        if (onvifConfig.ptz) {
            server.startPtz()
                .then(token => logger.info(`  PTZ passthrough enabled (camera profile: ${token})`))
                .catch(err  => logger.error(`  PTZ setup failed for '${onvifConfig.name}': ${err.message || err}`));
        }

        servers.push(server);
        logger.info('  Started!');
        logger.info('');

        // Collect TCP proxy mappings
        if (!proxies[onvifConfig.target.hostname])
            proxies[onvifConfig.target.hostname] = {};

        if (onvifConfig.ports.rtsp && onvifConfig.target.ports && onvifConfig.target.ports.rtsp)
            proxies[onvifConfig.target.hostname][onvifConfig.ports.rtsp] = onvifConfig.target.ports.rtsp;

        if (onvifConfig.ports.snapshot && onvifConfig.target.ports && onvifConfig.target.ports.snapshot)
            proxies[onvifConfig.target.hostname][onvifConfig.ports.snapshot] = onvifConfig.target.ports.snapshot;
    }

    for (const dest in proxies) {
        for (const srcPort in proxies[dest]) {
            logger.info(`Starting TCP proxy :${srcPort} → ${dest}:${proxies[dest][srcPort]} ...`);
            const proxy = createTcpProxyServer(Number(srcPort), dest, proxies[dest][srcPort], logger, args.debug);
            proxyServers.push(proxy);
            logger.info('  Started!');
            logger.info('');
        }
    }

    // ─── Graceful shutdown (PR #26) ──────────────────────────────────────────
    const gracefulShutdown = async (signal) => {
        logger.info(`\nReceived ${signal}, shutting down...`);

        for (const proxy of proxyServers) {
            try { proxy.shutdown(); } catch (_) {}
        }

        await Promise.all(servers.map(s => s.shutdown()));
        logger.info('All servers stopped.');
        process.exit(0);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

} else {
    parser.print_help();
    exitWithError('Please specify a config file, or use --create-config.');
}
