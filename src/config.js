'use strict';

const DEFAULT_CONFIG = Object.freeze({
    nodeEnv: 'development',
    host: '127.0.0.1',
    port: 8080,
    wsPath: '/',
    maxPayloadBytes: 16 * 1024,
    maxMessageContentLength: 4096,
    maxUserIdLength: 128,
    maxMessageTypeLength: 32,
    maxCorrelationIdLength: 128,
    maxConnectionsPerUser: 5,
    maxBufferedBytes: 1024 * 1024,
    connectionRateLimit: 30,
    connectionRateWindowMs: 60 * 1000,
    messageRateLimit: 100,
    messageRateWindowMs: 60 * 1000,
    messageDeduplicationTtlMs: 5 * 60 * 1000,
    maxDeduplicationEntriesPerUser: 1000,
    heartbeatIntervalMs: 30 * 1000,
    shutdownGraceMs: 5 * 1000,
    jwtIssuer: undefined,
    jwtAudience: undefined,
    allowedOrigins: [],
    logger: console
});

const POSITIVE_INTEGER_SETTINGS = Object.freeze([
    'maxPayloadBytes',
    'maxMessageContentLength',
    'maxUserIdLength',
    'maxMessageTypeLength',
    'maxCorrelationIdLength',
    'maxConnectionsPerUser',
    'maxBufferedBytes',
    'connectionRateLimit',
    'connectionRateWindowMs',
    'messageRateLimit',
    'messageRateWindowMs',
    'messageDeduplicationTtlMs',
    'maxDeduplicationEntriesPerUser',
    'heartbeatIntervalMs',
    'shutdownGraceMs'
]);

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
        nodeEnv: env.NODE_ENV || DEFAULT_CONFIG.nodeEnv,
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
        maxCorrelationIdLength: parsePositiveInteger(
            'MAX_CORRELATION_ID_LENGTH',
            env.MAX_CORRELATION_ID_LENGTH,
            DEFAULT_CONFIG.maxCorrelationIdLength
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
        messageDeduplicationTtlMs: parsePositiveInteger(
            'MESSAGE_DEDUPLICATION_TTL_MS',
            env.MESSAGE_DEDUPLICATION_TTL_MS,
            DEFAULT_CONFIG.messageDeduplicationTtlMs
        ),
        maxDeduplicationEntriesPerUser: parsePositiveInteger(
            'MAX_DEDUPLICATION_ENTRIES_PER_USER',
            env.MAX_DEDUPLICATION_ENTRIES_PER_USER,
            DEFAULT_CONFIG.maxDeduplicationEntriesPerUser
        ),
        heartbeatIntervalMs: parsePositiveInteger(
            'HEARTBEAT_INTERVAL_MS',
            env.HEARTBEAT_INTERVAL_MS,
            DEFAULT_CONFIG.heartbeatIntervalMs
        ),
        shutdownGraceMs: parsePositiveInteger(
            'SHUTDOWN_GRACE_MS',
            env.SHUTDOWN_GRACE_MS,
            DEFAULT_CONFIG.shutdownGraceMs
        ),
        jwtSecret: env.JWT_SECRET,
        jwtIssuer: env.JWT_ISSUER || undefined,
        jwtAudience: env.JWT_AUDIENCE || undefined,
        allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS)
    };
}

function isValidOrigin(origin) {
    try {
        const parsed = new URL(origin);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
            && parsed.origin === origin;
    } catch {
        return false;
    }
}

function validateConfig(overrides) {
    const config = {...DEFAULT_CONFIG, ...overrides};

    if (typeof config.jwtSecret !== 'string' || Buffer.byteLength(config.jwtSecret, 'utf8') < 32) {
        throw new Error('JWT_SECRET must contain at least 32 bytes');
    }

    if (!Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65535) {
        throw new Error('PORT must be an integer between 0 and 65535');
    }

    for (const setting of POSITIVE_INTEGER_SETTINGS) {
        if (!Number.isSafeInteger(config[setting]) || config[setting] <= 0) {
            throw new Error(`${setting} must be a positive integer`);
        }
    }

    if (typeof config.nodeEnv !== 'string' || config.nodeEnv.length === 0) {
        throw new Error('NODE_ENV must not be empty');
    }

    if (typeof config.host !== 'string' || config.host.length === 0) {
        throw new Error('HOST must not be empty');
    }

    if (typeof config.wsPath !== 'string' || !config.wsPath.startsWith('/')) {
        throw new Error('WS_PATH must start with /');
    }

    if (!Array.isArray(config.allowedOrigins)
        || !config.allowedOrigins.every(isValidOrigin)) {
        throw new Error('ALLOWED_ORIGINS must contain valid HTTP(S) origins without paths');
    }

    if (config.nodeEnv === 'production' && config.allowedOrigins.length === 0) {
        throw new Error('ALLOWED_ORIGINS must not be empty in production');
    }

    return Object.freeze(config);
}

module.exports = {
    DEFAULT_CONFIG,
    readConfig,
    validateConfig
};
