'use strict';

const net = require('net');

function createRtspAuthMonitor(logger, description) {
    const authenticatedRequests = new Set();
    const pendingRequests = new Map();
    let clientBuffer = '';
    let upstreamBuffer = '';

    const readHeaders = (buffer, chunk, callback) => {
        buffer += chunk.toString('latin1');
        if (buffer.length > 65536) buffer = '';

        let boundary;
        while ((boundary = buffer.indexOf('\r\n\r\n')) !== -1) {
            callback(buffer.substring(0, boundary));
            buffer = buffer.substring(boundary + 4);
            if (buffer.charCodeAt(0) === 0x24) {
                buffer = '';
                break;
            }
        }
        return buffer;
    };

    return {
        inspectClient(chunk) {
            clientBuffer = readHeaders(clientBuffer, chunk, headers => {
                const requestLine = headers.match(/^([A-Z_]+)\s+(\S+)/i);
                if (!requestLine) return;
                const method = requestLine[1];
                let resource = requestLine[2].split('?')[0];
                if (/^rtsp:\/\//i.test(resource)) {
                    try { resource = new URL(resource).pathname; } catch (_) { resource = '/[invalid-URI]'; }
                }
                const cseq = (headers.match(/^CSeq:\s*(\d+)/mi) || [])[1];
                logger.debug(`${description} | RTSP request ${method} ${resource}${cseq ? ` (CSeq ${cseq})` : ''}`);
                if (cseq) pendingRequests.set(cseq, `${method} ${resource}`);
                if (cseq && /^Authorization:\s*\S+/mi.test(headers)) {
                    authenticatedRequests.add(cseq);
                }
            });
        },
        inspectUpstream(chunk) {
            upstreamBuffer = readHeaders(upstreamBuffer, chunk, headers => {
                const status = (headers.match(/^RTSP\/\d\.\d\s+(\d{3})/i) || [])[1];
                const cseq = (headers.match(/^CSeq:\s*(\d+)/mi) || [])[1];
                if (!status) return;
                const request = cseq && pendingRequests.get(cseq);
                logger.debug(`${description} | RTSP response ${status}${cseq ? ` (CSeq ${cseq})` : ''}` +
                    `${request ? ` for ${request}` : ''}`);
                if (cseq) pendingRequests.delete(cseq);

                if (status === '401') {
                    logger.debug(`${description} | RTSP authentication failed (401${cseq ? `, CSeq ${cseq}` : ''})`);
                    if (cseq) authenticatedRequests.delete(cseq);
                } else if (cseq && authenticatedRequests.has(cseq) && /^2\d\d$/.test(status)) {
                    logger.debug(`${description} | RTSP authentication successful (${status}, CSeq ${cseq})`);
                    authenticatedRequests.delete(cseq);
                }
            });
        }
    };
}

function createTcpProxyServer(localHost, localPort, remoteHost, remotePort, logger, debugEnabled) {
    const connections = new Set();

    const destroySocket = (socket) => {
        if (!socket || socket.destroyed) return;
        socket.destroy();
    };

    const server = net.createServer({ allowHalfOpen: true }, clientSocket => {
        const client = clientSocket.remoteAddress ? `${clientSocket.remoteAddress}:${clientSocket.remotePort}` : 'client';
        const upstreamSocket = net.connect({ host: remoteHost, port: remotePort });

        connections.add(clientSocket);
        connections.add(upstreamSocket);

        clientSocket.setKeepAlive(true, 15000);
        clientSocket.setNoDelay(true);
        upstreamSocket.setKeepAlive(true, 15000);
        upstreamSocket.setNoDelay(true);

        if (debugEnabled) {
            logger.debug(`TCP proxy ${localHost}:${localPort} → ${remoteHost}:${remotePort} | Client connected: ${client}`);
        }

        upstreamSocket.on('connect', () => {
            if (debugEnabled) {
                logger.debug(`TCP proxy ${localHost}:${localPort} → ${remoteHost}:${remotePort} | Upstream connected for ${client}`);
                const monitor = createRtspAuthMonitor(
                    logger,
                    `TCP proxy ${localHost}:${localPort} → ${remoteHost}:${remotePort} | Client ${client}`
                );
                clientSocket.on('data', chunk => monitor.inspectClient(chunk));
                upstreamSocket.on('data', chunk => monitor.inspectUpstream(chunk));
            }
            clientSocket.pipe(upstreamSocket);
            upstreamSocket.pipe(clientSocket);
        });

        const removeSocket = (socket) => {
            connections.delete(socket);
        };

        const closePair = () => {
            connections.delete(clientSocket);
            connections.delete(upstreamSocket);
            destroySocket(clientSocket);
            destroySocket(upstreamSocket);
        };

        clientSocket.on('error', err => {
            logger.error(`TCP proxy ${localHost}:${localPort} client error: ${err.message}`);
            closePair();
        });

        upstreamSocket.on('error', err => {
            logger.error(`TCP proxy ${localHost}:${localPort} upstream error (${remoteHost}:${remotePort}): ${err.message}`);
            closePair();
        });

        clientSocket.on('close', () => {
            if (debugEnabled) {
                logger.debug(`TCP proxy ${localHost}:${localPort} → ${remoteHost}:${remotePort} | Client disconnected: ${client}`);
            }
            removeSocket(clientSocket);
            destroySocket(upstreamSocket);
        });

        upstreamSocket.on('close', () => {
            removeSocket(upstreamSocket);
            if (clientSocket.destroyed) return;
            if (clientSocket.writableFinished) return destroySocket(clientSocket);
            if (!clientSocket.writableEnded) clientSocket.end();
            clientSocket.once('finish', () => destroySocket(clientSocket));
        });
    });

    let listenSettled = false;
    const listening = new Promise((resolve, reject) => {
        server.once('listening', () => {
            listenSettled = true;
            resolve();
        });
        server.on('error', err => {
            if (!listenSettled) {
                listenSettled = true;
                return reject(err);
            }
            logger.error(`TCP proxy ${localHost}:${localPort} server error: ${err.message}`);
        });
    });
    // Always keep a handler attached so callers that ignore the promise do not
    // trigger an unhandled rejection.
    listening.catch(() => {});
    server.whenListening = listening;

    server.listen(localPort, localHost, () => {
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

module.exports = { createRtspAuthMonitor, createTcpProxyServer };
