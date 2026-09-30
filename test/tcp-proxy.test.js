'use strict';

const net = require('net');
const { createRtspAuthMonitor, createTcpProxyServer } = require('../src/tcp-proxy');

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

    describe('RTSP authentication debug logging', () => {
        beforeEach(() => {
            logger.debug.mockClear();
        });

        it('logs failed authentication without logging credentials', () => {
            const monitor = createRtspAuthMonitor(logger, 'proxy connection');
            const rtspTarget = `rtsp:${'//'}admin:secret@camera/stream?token=private`;
            monitor.inspectClient(Buffer.from(
                `DESCRIBE ${rtspTarget} RTSP/1.0\r\n` +
                'CSeq: 2\r\nAuthorization: Basic secret-value\r\n\r\n'
            ));
            monitor.inspectUpstream(Buffer.from('RTSP/1.0 401 Unauthorized\r\nCSeq: 2\r\n\r\n'));

            expect(logger.debug).toHaveBeenCalledWith(
                'proxy connection | RTSP request DESCRIBE /stream (CSeq 2)'
            );
            expect(logger.debug).toHaveBeenCalledWith(
                'proxy connection | RTSP response 401 (CSeq 2) for DESCRIBE /stream'
            );
            expect(logger.debug).toHaveBeenCalledWith(
                'proxy connection | RTSP authentication failed (401, CSeq 2)'
            );
            expect(logger.debug.mock.calls.flat().join(' ')).not.toContain('secret-value');
            expect(logger.debug.mock.calls.flat().join(' ')).not.toContain('secret');
            expect(logger.debug.mock.calls.flat().join(' ')).not.toContain('private');
        });

        it('logs successful authentication when an authorized request succeeds', () => {
            const monitor = createRtspAuthMonitor(logger, 'proxy connection');
            monitor.inspectClient(Buffer.from(
                'DESCRIBE rtsp://camera/stream RTSP/1.0\r\nCSeq: 3\r\n' +
                'Authorization: Digest username="viewer", response="secret"\r\n\r\n'
            ));
            monitor.inspectUpstream(Buffer.from('RTSP/1.0 200 OK\r\nCSeq: 3\r\n\r\n'));
            monitor.inspectClient(Buffer.from(
                'SETUP rtsp://camera/stream/trackID=1 RTSP/1.0\r\nCSeq: 4\r\n\r\n'
            ));
            monitor.inspectUpstream(Buffer.from('RTSP/1.0 200 OK\r\nCSeq: 4\r\n\r\n'));

            expect(logger.debug).toHaveBeenCalledWith(
                'proxy connection | RTSP authentication successful (200, CSeq 3)'
            );
            expect(logger.debug).toHaveBeenCalledWith(
                'proxy connection | RTSP request SETUP /stream/trackID=1 (CSeq 4)'
            );
            expect(logger.debug).toHaveBeenCalledWith(
                'proxy connection | RTSP response 200 (CSeq 4) for SETUP /stream/trackID=1'
            );
            expect(logger.debug.mock.calls.flat().join(' ')).not.toContain('viewer');
            expect(logger.debug.mock.calls.flat().join(' ')).not.toContain('secret');
        });

        it('handles RTSP headers split across TCP packets', () => {
            const monitor = createRtspAuthMonitor(logger, 'proxy connection');
            monitor.inspectClient(Buffer.from('DESCRIBE rtsp://camera/stream RTSP/1.0\r\nCSeq: 4\r\nAuthor'));
            monitor.inspectClient(Buffer.from('ization: Basic hidden\r\n\r\n'));
            monitor.inspectUpstream(Buffer.from('RTSP/1.0 20'));
            monitor.inspectUpstream(Buffer.from('0 OK\r\nCSeq: 4\r\n\r\n'));

            expect(logger.debug).toHaveBeenCalledWith(
                'proxy connection | RTSP authentication successful (200, CSeq 4)'
            );
        });
    });

    it('supports the same local port on different virtual camera addresses', async () => {
        const upstream = net.createServer(socket => {
            socket.once('data', data => socket.end(data));
        });
        servers.push(upstream);
        const upstreamPort = await listen(upstream, 0, '127.0.0.1');

        const first = createTcpProxyServer('127.0.0.1', 0, '127.0.0.1', upstreamPort, logger, false);
        await new Promise((resolve, reject) => {
            first.once('listening', resolve);
            first.once('error', reject);
        });
        servers.push(first);
        const proxyPort = first.address().port;

        const second = createTcpProxyServer('::1', proxyPort, '127.0.0.1', upstreamPort, logger, false);
        await new Promise((resolve, reject) => {
            second.once('listening', resolve);
            second.once('error', reject);
        });
        servers.push(second);

        await expect(connect('127.0.0.1', proxyPort, 'first')).resolves.toBe('first');
        await expect(connect('::1', proxyPort, 'second')).resolves.toBe('second');
    });
});
