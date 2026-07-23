'use strict';

const {randomUUID} = require('node:crypto');
const http = require('node:http');
const express = require('express');
const WebSocket = require('ws');

const {authenticate, clientIp, isAllowedOrigin} = require('./auth');
const {validateConfig} = require('./config');
const {createDeduplicationStore} = require('./deduplication');
const {
    parseMessage,
    sanitizeMessageContent,
    withRequestId
} = require('./protocol');
const {createFixedWindowLimiter} = require('./rate-limiter');

function writeUpgradeError(socket, statusCode, reason) {
    const body = `${reason}\n`;
    const response = [
        `HTTP/1.1 ${statusCode} ${reason}`,
        'Connection: close',
        'Content-Type: text/plain; charset=utf-8',
        `Content-Length: ${Buffer.byteLength(body)}`,
        '',
        body
    ].join('\r\n');

    if (socket.writable) {
        socket.end(response);
    } else {
        socket.destroy();
    }
}

function createChatServer(overrides = {}) {
    const config = validateConfig(overrides);
    const app = express();
    const server = http.createServer(app);
    const userConnections = new Map();
    const connectionLimiter = createFixedWindowLimiter(
        config.connectionRateLimit,
        config.connectionRateWindowMs
    );
    const messageLimiter = createFixedWindowLimiter(
        config.messageRateLimit,
        config.messageRateWindowMs
    );
    const deduplicationStore = createDeduplicationStore({
        ttlMs: config.messageDeduplicationTtlMs,
        maxEntriesPerUser: config.maxDeduplicationEntriesPerUser
    });
    const wss = new WebSocket.Server({
        noServer: true,
        maxPayload: config.maxPayloadBytes,
        perMessageDeflate: false,
        handleProtocols(protocols) {
            if (protocols.has('simplechat')) {
                return 'simplechat';
            }

            return protocols.values().next().value || false;
        }
    });

    let heartbeatTimer;
    let stopPromise;
    let lifecycleState = 'idle';

    app.disable('x-powered-by');
    app.get('/healthz', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.status(200).json({status: 'ok'});
    });
    app.get('/readyz', (req, res) => {
        const ready = lifecycleState === 'running';
        res.set('Cache-Control', 'no-store');
        res.status(ready ? 200 : 503).json({status: ready ? 'ready' : 'not_ready'});
    });
    app.use((req, res) => {
        res.status(404).json({error: 'Not found'});
    });
    app.use((error, req, res, next) => {
        config.logger.error('HTTP request failed', {error: error.message});
        if (res.headersSent) {
            next(error);
            return;
        }
        res.status(500).json({error: 'Internal server error'});
    });

    server.requestTimeout = 10 * 1000;
    server.headersTimeout = 15 * 1000;
    server.keepAliveTimeout = 5 * 1000;

    function sendJson(ws, payload) {
        if (ws.readyState !== WebSocket.OPEN) {
            return false;
        }

        if (ws.bufferedAmount > config.maxBufferedBytes) {
            ws.close(1013, 'Client is too slow');
            return false;
        }

        try {
            ws.send(JSON.stringify(payload), error => {
                if (error) {
                    config.logger.warn('WebSocket send failed', {error: error.message});
                }
            });
            return true;
        } catch (error) {
            config.logger.warn('WebSocket send failed', {error: error.message});
            return false;
        }
    }

    function processSendMessage(ws, userId, data) {
        const messageId = data.messageId || randomUUID();
        const fingerprint = JSON.stringify([
            data.recipientId,
            data.message.type,
            data.message.content
        ]);
        const previous = deduplicationStore.lookup(userId, messageId, fingerprint);

        if (previous.status === 'conflict') {
            sendJson(ws, withRequestId({
                command: 'sendMessage',
                status: 'error',
                code: 'MESSAGE_ID_CONFLICT',
                error: 'messageId was already used with a different payload',
                messageId,
                recipientId: data.recipientId
            }, data.requestId));
            return;
        }

        if (previous.status === 'hit') {
            sendJson(ws, withRequestId({
                ...previous.acknowledgement,
                duplicate: true
            }, data.requestId));
            return;
        }

        const recipientConnections = userConnections.get(data.recipientId);
        const timestamp = new Date().toISOString();
        let delivered = false;

        if (recipientConnections) {
            const content = sanitizeMessageContent(data.message.content);
            for (const connection of recipientConnections) {
                delivered = sendJson(connection, {
                    command: 'message',
                    messageId,
                    from: userId,
                    timestamp,
                    message: {content, type: data.message.type}
                }) || delivered;
            }
        }

        const acknowledgement = delivered
            ? {
                command: 'sendMessage',
                status: 'success',
                messageId,
                recipientId: data.recipientId,
                timestamp
            }
            : {
                command: 'sendMessage',
                status: 'error',
                code: 'USER_NOT_ONLINE',
                error: 'User not online',
                messageId,
                recipientId: data.recipientId,
                timestamp
            };

        deduplicationStore.remember(userId, messageId, fingerprint, acknowledgement);
        sendJson(ws, withRequestId(acknowledgement, data.requestId));
    }

    server.on('upgrade', (req, socket, head) => {
        socket.on('error', () => {});

        if (lifecycleState !== 'running') {
            writeUpgradeError(socket, 503, 'Service Unavailable');
            return;
        }

        let path;
        try {
            path = new URL(req.url, 'http://localhost').pathname;
        } catch {
            writeUpgradeError(socket, 400, 'Bad Request');
            return;
        }

        if (path !== config.wsPath) {
            writeUpgradeError(socket, 404, 'Not Found');
            return;
        }

        const ip = clientIp(req);
        if (!connectionLimiter.consume(ip)) {
            writeUpgradeError(socket, 429, 'Too Many Requests');
            return;
        }

        if (!isAllowedOrigin(req, config)) {
            writeUpgradeError(socket, 403, 'Forbidden');
            return;
        }

        const user = authenticate(req, config);
        if (!user) {
            writeUpgradeError(socket, 401, 'Unauthorized');
            return;
        }

        const existingConnections = userConnections.get(user.userId);
        if (existingConnections && existingConnections.size >= config.maxConnectionsPerUser) {
            writeUpgradeError(socket, 429, 'Too Many Requests');
            return;
        }

        req.authenticatedUser = user;
        wss.handleUpgrade(req, socket, head, ws => {
            wss.emit('connection', ws, req);
        });
    });

    wss.on('connection', (ws, req) => {
        const {userId} = req.authenticatedUser;
        let connections = userConnections.get(userId);
        if (!connections) {
            connections = new Set();
            userConnections.set(userId, connections);
        }
        connections.add(ws);

        ws.isAlive = true;
        ws.on('pong', () => {
            ws.isAlive = true;
        });

        ws.on('message', (message, isBinary) => {
            let requestId;

            try {
                if (!messageLimiter.consume(userId)) {
                    sendJson(ws, {
                        command: 'error',
                        code: 'RATE_LIMITED',
                        message: 'Too many messages'
                    });
                    return;
                }

                const parsed = parseMessage(message, isBinary, config);
                if (parsed.error) {
                    sendJson(ws, {command: 'error', ...parsed.error});
                    return;
                }

                const {data} = parsed;
                requestId = data.requestId;

                switch (data.command) {
                    case 'sendMessage':
                        processSendMessage(ws, userId, data);
                        break;

                    case 'isOnline':
                        sendJson(ws, withRequestId({
                            command: 'isOnline',
                            status: userConnections.has(data.userIdToCheck)
                        }, requestId));
                        break;

                    default:
                        sendJson(ws, withRequestId({
                            command: 'error',
                            code: 'UNKNOWN_COMMAND',
                            message: 'Unknown command'
                        }, requestId));
                        break;
                }
            } catch (error) {
                config.logger.error('WebSocket message processing failed', {
                    userId,
                    error: error.message
                });
                sendJson(ws, withRequestId({
                    command: 'error',
                    code: 'INTERNAL_ERROR',
                    message: 'Message processing failed'
                }, requestId));
            }
        });

        ws.on('error', error => {
            config.logger.warn('WebSocket connection error', {userId, error: error.message});
        });

        ws.on('close', () => {
            const currentConnections = userConnections.get(userId);
            if (!currentConnections) {
                return;
            }

            currentConnections.delete(ws);
            if (currentConnections.size === 0) {
                userConnections.delete(userId);
            }
        });
    });

    wss.on('error', error => {
        config.logger.error('WebSocket server error', {error: error.message});
    });

    server.on('error', error => {
        config.logger.error('HTTP server error', {error: error.message});
    });

    server.on('clientError', (error, socket) => {
        if (!socket.writableEnded) {
            writeUpgradeError(socket, 400, 'Bad Request');
        }
    });

    function startHeartbeat() {
        heartbeatTimer = setInterval(() => {
            for (const ws of wss.clients) {
                if (ws.isAlive === false) {
                    ws.terminate();
                    continue;
                }

                ws.isAlive = false;
                ws.ping();
            }
        }, config.heartbeatIntervalMs);
        heartbeatTimer.unref();
    }

    function start() {
        if (lifecycleState !== 'idle') {
            return Promise.reject(new Error(`Server cannot start while ${lifecycleState}`));
        }
        lifecycleState = 'starting';

        return new Promise((resolve, reject) => {
            const handleStartupError = error => {
                server.off('listening', handleListening);
                lifecycleState = 'idle';
                reject(error);
            };
            const handleListening = () => {
                server.off('error', handleStartupError);
                lifecycleState = 'running';
                startHeartbeat();
                resolve(server.address());
            };

            server.once('error', handleStartupError);
            server.once('listening', handleListening);
            server.listen(config.port, config.host);
        });
    }

    function closeWebSocketsGracefully() {
        for (const ws of wss.clients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close(1001, 'Server shutting down');
            } else {
                ws.terminate();
            }
        }

        const closed = new Promise(resolve => {
            wss.close(() => resolve());
        });
        let forceTimer;
        const forced = new Promise(resolve => {
            forceTimer = setTimeout(() => {
                for (const ws of wss.clients) {
                    ws.terminate();
                }
                resolve();
            }, config.shutdownGraceMs);
            forceTimer.unref();
        });

        return Promise.race([closed, forced])
            .then(() => closed)
            .finally(() => clearTimeout(forceTimer));
    }

    function stop() {
        if (stopPromise) {
            return stopPromise;
        }

        stopPromise = (async () => {
            lifecycleState = 'stopping';
            clearInterval(heartbeatTimer);
            connectionLimiter.clear();
            messageLimiter.clear();
            deduplicationStore.clear();

            const serverClosed = server.listening
                ? new Promise((resolve, reject) => {
                    server.close(error => {
                        if (error) {
                            reject(error);
                            return;
                        }
                        resolve();
                    });
                    server.closeIdleConnections?.();
                })
                : Promise.resolve();

            try {
                await Promise.all([serverClosed, closeWebSocketsGracefully()]);
            } finally {
                lifecycleState = 'stopped';
            }
        })();

        return stopPromise;
    }

    return {
        app,
        server,
        wss,
        userConnections,
        config,
        start,
        stop,
        getStatus: () => lifecycleState
    };
}

module.exports = {createChatServer};
