'use strict';

const pkg          = require('./package.json');
for (const name of Object.keys(pkg.dependencies)) {
    try {
        require.resolve(name);
    } catch (err) {
        if (err.code !== 'MODULE_NOT_FOUND') throw err;
        console.error(`Required npm package "${name}" is missing. Run "npm ci" in the project directory and try again.`);
        process.exit(1);
    }
}

let onvifServer, configBuilder, createTcpProxyServer, argparse, yaml, simpleLogger;
try {
    onvifServer = require('./src/onvif-server');
    configBuilder = require('./src/config-builder');
    ({ createTcpProxyServer } = require('./src/tcp-proxy'));
    argparse = require('argparse');
    yaml = require('yaml');
    simpleLogger = require('simple-node-logger-se');
} catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND' && err.code !== 'ERR_DLOPEN_FAILED') throw err;
    console.error(`Failed to load a required dependency: ${err.message}\nRun "npm ci" in the project directory and try again.`);
    process.exit(1);
}
const readline     = require('readline');
const stream       = require('stream');
const fs           = require('fs');

const parser = new argparse.ArgumentParser({
    description: 'Virtual ONVIF Server for Samsung cameras with Dahua DVR'
});

parser.add_argument('-v', '--version',       { action: 'store_true', help: 'Show version' });
parser.add_argument('-cc', '--create-config',{ action: 'store_true', help: 'Interactively generate a config from a real ONVIF camera' });
parser.add_argument('-d', '--debug',         { action: 'store_true', help: 'Enable verbose ONVIF, HTTP, RTSP, snapshot, PTZ, and discovery diagnostics' });
parser.add_argument('config', { help: 'Path to onvif.yaml config file', nargs: '?' });

const args = parser.parse_args();

if (!args) process.exit(1);

const logger = simpleLogger.createSimpleLogger();
if (args.debug) logger.setLevel('trace');

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
    runWithConfig(args.config).catch(err => exitWithError(`Startup failed: ${err.message || err}`));

} else {
    parser.print_help();
    exitWithError('Please specify a config file, or use --create-config.');
}

// ─── Startup with a config file ──────────────────────────────────────────────
function describeListenError(err, address) {
    switch (err.code) {
        case 'EADDRINUSE':
            return `${address} is already in use. Another instance of this server (or another ` +
                'program) is already listening there. Stop it first (for example with ' +
                "'systemctl stop onvif-server', 'pkill -f \"node main.js\"', or check the owner " +
                "with 'ss -lptn') or change the port in the config.";
        case 'EADDRNOTAVAIL':
            return `${address} is not available on this host. Make sure the configured address ` +
                'exists on one of this machine\'s interfaces.';
        case 'EACCES':
            return `${address} cannot be bound: permission denied. Ports below 1024 require ` +
                'elevated privileges (or CAP_NET_BIND_SERVICE).';
        default:
            return `${address}: ${err.message}`;
    }
}

async function runWithConfig(configPath) {
    let configData;
    try {
        configData = fs.readFileSync(configPath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            return exitWithError(`File not found: ${configPath}`);
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
    const proxies      = new Map();

    const stopAll = async () => {
        for (const proxy of proxyServers) {
            try { proxy.shutdown(); } catch (_) {}
        }
        await Promise.all(servers.map(s => s.shutdown().catch(() => {})));
    };

    const failStartup = async (msg) => {
        await stopAll();
        exitWithError(msg);
    };

    for (const onvifConfig of config.onvif) {
        const server = onvifServer.createServer(onvifConfig, logger);

        if (!server.getHostname()) {
            return failStartup(`Cannot resolve hostname for '${onvifConfig.name}'. ` +
                'Set "hostname:" directly in config (MAC lookup failed or mac omitted).');
        }

        logger.info(`Starting ONVIF server for '${onvifConfig.name}' on ${server.getHostname()}:${onvifConfig.ports.server} ...`);
        if (!server.checkHostnameIsLocal()) {
            logger.warn(`  hostname ${server.getHostname()} is not assigned to any network interface on this host ` +
                '(it may have changed via DHCP). ONVIF clients will not reach this server. Set "hostname:" to one ' +
                'of this host\'s addresses (see "ip -4 addr") or give the host/container a static IP.');
        }
        servers.push(server);

        try {
            await server.startServer();
        } catch (err) {
            return failStartup(`Failed to start ONVIF server for '${onvifConfig.name}': ` +
                describeListenError(err, `${server.getHostname()}:${onvifConfig.ports.server}`));
        }

        server.startDiscovery();

        if (args.debug) server.enableDebugOutput();

        // PTZ passthrough (PR #28)
        if (onvifConfig.ptz) {
            server.startPtz()
                .then(token => logger.info(`  PTZ passthrough enabled (camera profile: ${token})`))
                .catch(err  => logger.error(`  PTZ setup failed for '${onvifConfig.name}': ${err.message || err}`));
        }

        logger.info('  Started!');
        logger.info('');

        // Collect TCP proxy mappings
        if (onvifConfig.ports.rtsp && onvifConfig.target.ports && onvifConfig.target.ports.rtsp)
            proxies.set(`${onvifConfig.hostname}:${onvifConfig.ports.rtsp}`, {
                localHost: onvifConfig.hostname,
                localPort: onvifConfig.ports.rtsp,
                remoteHost: onvifConfig.target.hostname,
                remotePort: onvifConfig.target.ports.rtsp
            });

        if (onvifConfig.ports.snapshot && onvifConfig.target.ports && onvifConfig.target.ports.snapshot)
            proxies.set(`${onvifConfig.hostname}:${onvifConfig.ports.snapshot}`, {
                localHost: onvifConfig.hostname,
                localPort: onvifConfig.ports.snapshot,
                remoteHost: onvifConfig.target.hostname,
                remotePort: onvifConfig.target.ports.snapshot
            });
    }

    for (const proxyConfig of proxies.values()) {
        logger.info(`Starting TCP proxy ${proxyConfig.localHost}:${proxyConfig.localPort} → ${proxyConfig.remoteHost}:${proxyConfig.remotePort} ...`);
        const proxy = createTcpProxyServer(
            proxyConfig.localHost,
            Number(proxyConfig.localPort),
            proxyConfig.remoteHost,
            proxyConfig.remotePort,
            logger,
            args.debug
        );
        proxyServers.push(proxy);

        try {
            await proxy.whenListening;
        } catch (err) {
            return failStartup('Failed to start TCP proxy: ' +
                describeListenError(err, `${proxyConfig.localHost}:${proxyConfig.localPort}`));
        }

        logger.info('  Started!');
        logger.info('');
    }

    // ─── Graceful shutdown (PR #26) ──────────────────────────────────────────
    const gracefulShutdown = async (signal) => {
        logger.info(`\nReceived ${signal}, shutting down...`);
        await stopAll();
        logger.info('All servers stopped.');
        process.exit(0);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
}
