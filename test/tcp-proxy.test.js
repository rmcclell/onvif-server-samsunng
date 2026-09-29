'use strict';

const net = require('net');
const { createTcpProxyServer } = require('../src/tcp-proxy');

const logger = {
    debug: jest.fn(),
    error: jest.fn()
};

function listen(server, port, host) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.removeListener('error', reject);
            resolve(server.address().port);
        });
    });
}

function connect(host, port, message) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host, port }, () => socket.write(message));
        socket.once('data', data => {
            resolve(data.toString());
            socket.destroy();
        });
        socket.once('error', reject);
    });
}

describe('TCP proxy address binding', () => {
    const servers = [];

    afterEach(async () => {
        await Promise.all(servers.splice(0).map(server => new Promise(resolve => {
            if (!server.listening) return resolve();
            server.close(resolve);
        })));
    });

    it('supports the same local port on different virtual camera addresses', async () => {
        const upstream = net.createServer(socket => socket.pipe(socket));
        servers.push(upstream);
        const upstreamPort = await listen(upstream, 0, '127.0.0.1');

        const first = createTcpProxyServer('127.0.0.1', 0, '127.0.0.1', upstreamPort, logger, false);
        await new Promise((resolve, reject) => {
            first.once('listening', resolve);
            first.once('error', reject);
        });
        servers.push(first);
        const proxyPort = first.address().port;

        const second = createTcpProxyServer('127.0.0.2', proxyPort, '127.0.0.1', upstreamPort, logger, false);
        await new Promise((resolve, reject) => {
            second.once('listening', resolve);
            second.once('error', reject);
        });
        servers.push(second);

        await expect(connect('127.0.0.1', proxyPort, 'first')).resolves.toBe('first');
        await expect(connect('127.0.0.2', proxyPort, 'second')).resolves.toBe('second');
    });
});
