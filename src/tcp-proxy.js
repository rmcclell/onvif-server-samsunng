'use strict';

const net = require('net');

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
        });

        upstreamSocket.on('close', () => {
            removeSocket(upstreamSocket);
        });
    });

    server.on('error', err => {
        logger.error(`TCP proxy ${localHost}:${localPort} server error: ${err.message}`);
    });

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

module.exports = { createTcpProxyServer };
