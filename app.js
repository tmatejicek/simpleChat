'use strict';

require('dotenv').config();

const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const sanitizeHtml = require('sanitize-html');
const WebSocket = require('ws');

const DEFAULT_CONFIG = Object.freeze({
    host: '127.0.0.1',
    port: 8080,
    wsPath: '/',
    maxPayloadBytes: 16 * 1024,
    maxMessageContentLength: 4096,
    maxUserIdLength: 128,
    maxMessageTypeLength: 32,
    maxConnectionsPerUser: 5,
    maxBufferedBytes: 1024 * 1024,
    connectionRateLimit: 30,
    connectionRateWindowMs: 60 * 1000,
    messageRateLimit: 100,
    messageRateWindowMs: 60 * 1000,
    heartbeatIntervalMs: 30 * 1000,
    jwtIssuer: undefined,
    jwtAudience: undefined,
    allowedOrigins: [],
    logger: console
});

const PLAIN_TEXT_SANITIZE_OPTIONS = Object.freeze({
    allowedTags: [],
    allowedAttributes: {}
});

function parsePositiveInteger(name, value, fallback) {
    if (value === undefined || value === '') {
        return fallback;
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }

    return parsed;
}

function parseAllowedOrigins(value) {
    if (!value) {
        return [];
    }

    return value
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean);
}

function readConfig(env = process.env) {
    return {
        host: env.HOST || DEFAULT_CONFIG.host,
        port: parsePositiveInteger('PORT', env.PORT, DEFAULT_CONFIG.port),
        wsPath: env.WS_PATH || DEFAULT_CONFIG.wsPath,
        maxPayloadBytes: parsePositiveInteger(
            'MAX_PAYLOAD_BYTES',
            env.MAX_PAYLOAD_BYTES,
            DEFAULT_CONFIG.maxPayloadBytes
        ),
        maxMessageContentLength: parsePositiveInteger(
            'MAX_MESSAGE_CONTENT_LENGTH',
            env.MAX_MESSAGE_CONTENT_LENGTH,
            DEFAULT_CONFIG.maxMessageContentLength
        ),
        maxUserIdLength: parsePositiveInteger(
            'MAX_USER_ID_LENGTH',
            env.MAX_USER_ID_LENGTH,
            DEFAULT_CONFIG.maxUserIdLength
        ),
        maxMessageTypeLength: parsePositiveInteger(
            'MAX_MESSAGE_TYPE_LENGTH',
            env.MAX_MESSAGE_TYPE_LENGTH,
            DEFAULT_CONFIG.maxMessageTypeLength
        ),
        maxConnectionsPerUser: parsePositiveInteger(
            'MAX_CONNECTIONS_PER_USER',
            env.MAX_CONNECTIONS_PER_USER,
            DEFAULT_CONFIG.maxConnectionsPerUser
        ),
        maxBufferedBytes: parsePositiveInteger(
            'MAX_BUFFERED_BYTES',
            env.MAX_BUFFERED_BYTES,
            DEFAULT_CONFIG.maxBufferedBytes
        ),
        connectionRateLimit: parsePositiveInteger(
            'CONNECTION_RATE_LIMIT',
            env.CONNECTION_RATE_LIMIT,
            DEFAULT_CONFIG.connectionRateLimit
        ),
        connectionRateWindowMs: parsePositiveInteger(
            'CONNECTION_RATE_WINDOW_MS',
            env.CONNECTION_RATE_WINDOW_MS,
            DEFAULT_CONFIG.connectionRateWindowMs
        ),
        messageRateLimit: parsePositiveInteger(
            'MESSAGE_RATE_LIMIT',
            env.MESSAGE_RATE_LIMIT,
            DEFAULT_CONFIG.messageRateLimit
        ),
        messageRateWindowMs: parsePositiveInteger(
            'MESSAGE_RATE_WINDOW_MS',
            env.MESSAGE_RATE_WINDOW_MS,
            DEFAULT_CONFIG.messageRateWindowMs
        ),
        heartbeatIntervalMs: parsePositiveInteger(
            'HEARTBEAT_INTERVAL_MS',
            env.HEARTBEAT_INTERVAL_MS,
            DEFAULT_CONFIG.heartbeatIntervalMs
        ),
        jwtSecret: env.JWT_SECRET,
        jwtIssuer: env.JWT_ISSUER || undefined,
        jwtAudience: env.JWT_AUDIENCE || undefined,
        allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS)
    };
}

function validateConfig(overrides) {
    const config = {...DEFAULT_CONFIG, ...overrides};
    const positiveIntegerSettings = [
        'maxPayloadBytes',
        'maxMessageContentLength',
        'maxUserIdLength',
        'maxMessageTypeLength',
        'maxConnectionsPerUser',
        'maxBufferedBytes',
        'connectionRateLimit',
        'connectionRateWindowMs',
        'messageRateLimit',
        'messageRateWindowMs',
        'heartbeatIntervalMs'
    ];

    if (typeof config.jwtSecret !== 'string' || Buffer.byteLength(config.jwtSecret, 'utf8') < 32) {
        throw new Error('JWT_SECRET must contain at least 32 bytes');
    }

    if (!Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65535) {
        throw new Error('PORT must be an integer between 0 and 65535');
    }

    for (const setting of positiveIntegerSettings) {
        if (!Number.isSafeInteger(config[setting]) || config[setting] <= 0) {
            throw new Error(`${setting} must be a positive integer`);
        }
    }

    if (typeof config.host !== 'string' || config.host.length === 0) {
        throw new Error('HOST must not be empty');
    }

    if (typeof config.wsPath !== 'string' || !config.wsPath.startsWith('/')) {
        throw new Error('WS_PATH must start with /');
    }

    if (!Array.isArray(config.allowedOrigins)
        || !config.allowedOrigins.every(origin => typeof origin === 'string' && origin.length > 0)) {
        throw new Error('allowedOrigins must be an array of non-empty strings');
    }

    return Object.freeze(config);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidUserId(value, maxLength) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maxLength
        && !/[\u0000-\u001f\u007f]/u.test(value);
}

function parseMessage(message, isBinary, config) {
    if (isBinary) {
        return {error: {code: 'BINARY_NOT_SUPPORTED', message: 'Binary messages are not supported'}};
    }

    let data;
    try {
        data = JSON.parse(message.toString('utf8'));
    } catch {
        return {error: {code: 'INVALID_JSON', message: 'Invalid JSON'}};
    }

    if (!isPlainObject(data) || typeof data.command !== 'string') {
        return {error: {code: 'INVALID_MESSAGE', message: 'Invalid message format'}};
    }

    if (data.command === 'sendMessage') {
        const validPayload = isValidUserId(data.recipientId, config.maxUserIdLength)
            && isPlainObject(data.message)
            && typeof data.message.content === 'string'
            && data.message.content.length <= config.maxMessageContentLength
            && typeof data.message.type === 'string'
            && data.message.type.length > 0
            && data.message.type.length <= config.maxMessageTypeLength
            && /^[a-zA-Z0-9._-]+$/u.test(data.message.type);

        if (!validPayload) {
            return {error: {code: 'INVALID_PAYLOAD', message: 'Invalid sendMessage payload'}};
        }
    } else if (data.command === 'isOnline'
        && !isValidUserId(data.userIdToCheck, config.maxUserIdLength)) {
        return {error: {code: 'INVALID_PAYLOAD', message: 'Invalid isOnline payload'}};
    }

    return {data};
}

function createFixedWindowLimiter(limit, windowMs) {
    const entries = new Map();
    let operations = 0;

    return {
        consume(key, now = Date.now()) {
            let entry = entries.get(key);
            if (!entry || entry.resetAt <= now) {
                entry = {count: 0, resetAt: now + windowMs};
                entries.set(key, entry);
            }

            entry.count += 1;
            operations += 1;

            if (operations % 100 === 0) {
                for (const [storedKey, storedEntry] of entries) {
                    if (storedEntry.resetAt <= now) {
                        entries.delete(storedKey);
                    }
                }
            }

            return entry.count <= limit;
        },
        clear() {
            entries.clear();
        }
    };
}

function requestProtocols(req) {
    const header = req.headers['sec-websocket-protocol'];
    if (typeof header !== 'string') {
        return [];
    }

    return header
        .split(',')
        .map(protocol => protocol.trim())
        .filter(Boolean);
}

function extractToken(req) {
    const authorization = req.headers.authorization;
    if (typeof authorization === 'string') {
        const match = /^Bearer ([^\s]+)$/u.exec(authorization);
        if (match) {
            return match[1];
        }
    }

    const protocols = requestProtocols(req);
    const bearerProtocol = protocols.find(protocol => protocol.startsWith('bearer.'));
    if (bearerProtocol) {
        return bearerProtocol.slice('bearer.'.length);
    }

    return protocols.find(protocol => protocol.split('.').length === 3);
}

function authenticate(req, config) {
    const token = extractToken(req);
    if (typeof token !== 'string' || token.length === 0 || token.length > 8192) {
        return null;
    }

    const verifyOptions = {algorithms: ['HS256']};
    if (config.jwtIssuer) {
        verifyOptions.issuer = config.jwtIssuer;
    }
    if (config.jwtAudience) {
        verifyOptions.audience = config.jwtAudience;
    }

    try {
        const claims = jwt.verify(token, config.jwtSecret, verifyOptions);
        if (!isPlainObject(claims)
            || !Number.isSafeInteger(claims.exp)
            || !isValidUserId(claims.userId, config.maxUserIdLength)) {
            return null;
        }

        return {userId: claims.userId};
    } catch {
        return null;
    }
}

function isLoopbackAddress(address) {
    return address === '127.0.0.1'
        || address === '::1'
        || address === '::ffff:127.0.0.1';
}

function clientIp(req) {
    const remoteAddress = req.socket.remoteAddress || 'unknown';
    const forwardedFor = req.headers['x-forwarded-for'];

    if (isLoopbackAddress(remoteAddress) && typeof forwardedFor === 'string') {
        const firstAddress = forwardedFor.split(',')[0].trim();
        if (firstAddress) {
            return firstAddress;
        }
    }

    return remoteAddress;
}

function isAllowedOrigin(req, config) {
    const origin = req.headers.origin;
    return typeof origin !== 'string'
        || config.allowedOrigins.length === 0
        || config.allowedOrigins.includes(origin);
}

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
    let isStopping = false;

    app.disable('x-powered-by');
    app.get('/healthz', (req, res) => {
        res.status(200).json({status: 'ok'});
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

    server.on('upgrade', (req, socket, head) => {
        socket.on('error', () => {});

        if (isStopping) {
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
                switch (data.command) {
                    case 'sendMessage': {
                        const recipientConnections = userConnections.get(data.recipientId);
                        let delivered = false;

                        if (recipientConnections) {
                            const content = sanitizeHtml(
                                data.message.content,
                                PLAIN_TEXT_SANITIZE_OPTIONS
                            );
                            for (const connection of recipientConnections) {
                                delivered = sendJson(connection, {
                                    command: 'message',
                                    from: userId,
                                    message: {content, type: data.message.type}
                                }) || delivered;
                            }
                        }

                        if (delivered) {
                            for (const connection of userConnections.get(userId) || []) {
                                sendJson(connection, {command: 'sendMessage', status: 'success'});
                            }
                        } else {
                            sendJson(ws, {
                                command: 'sendMessage',
                                status: 'error',
                                error: 'User not online'
                            });
                        }
                        break;
                    }

                    case 'isOnline':
                        sendJson(ws, {
                            command: 'isOnline',
                            status: userConnections.has(data.userIdToCheck)
                        });
                        break;

                    default:
                        sendJson(ws, {
                            command: 'error',
                            code: 'UNKNOWN_COMMAND',
                            message: 'Unknown command'
                        });
                        break;
                }
            } catch (error) {
                config.logger.error('WebSocket message processing failed', {
                    userId,
                    error: error.message
                });
                if (ws.readyState === WebSocket.OPEN) {
                    sendJson(ws, {
                        command: 'error',
                        code: 'INTERNAL_ERROR',
                        message: 'Message processing failed'
                    });
                }
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
        return new Promise((resolve, reject) => {
            const handleStartupError = error => {
                server.off('listening', handleListening);
                reject(error);
            };
            const handleListening = () => {
                server.off('error', handleStartupError);
                startHeartbeat();
                resolve(server.address());
            };

            server.once('error', handleStartupError);
            server.once('listening', handleListening);
            server.listen(config.port, config.host);
        });
    }

    function stop() {
        if (stopPromise) {
            return stopPromise;
        }

        stopPromise = (async () => {
            isStopping = true;
            clearInterval(heartbeatTimer);
            connectionLimiter.clear();
            messageLimiter.clear();

            const serverClosed = server.listening
                ? new Promise((resolve, reject) => {
                    server.close(error => {
                        if (error) {
                            reject(error);
                            return;
                        }
                        resolve();
                    });
                })
                : Promise.resolve();

            for (const ws of wss.clients) {
                ws.terminate();
            }

            const webSocketServerClosed = new Promise(resolve => {
                wss.close(() => resolve());
            });

            await Promise.all([serverClosed, webSocketServerClosed]);
        })();

        return stopPromise;
    }

    return {app, server, wss, userConnections, config, start, stop};
}

async function main() {
    let chatServer;
    try {
        chatServer = createChatServer(readConfig());
        const address = await chatServer.start();
        console.log(`Server is listening on ws://${address.address}:${address.port}`);
    } catch (error) {
        console.error(`Server failed to start: ${error.message}`);
        process.exitCode = 1;
        return;
    }

    let shuttingDown = false;
    const shutdown = async signal => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        console.log(`Received ${signal}, shutting down`);

        try {
            await chatServer.stop();
        } catch (error) {
            console.error(`Shutdown failed: ${error.message}`);
            process.exitCode = 1;
        }
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
    main();
}

module.exports = {
    createChatServer,
    parseMessage,
    readConfig
};
