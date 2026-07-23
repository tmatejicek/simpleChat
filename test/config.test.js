'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    DEFAULT_CONFIG,
    readConfig,
    validateConfig
} = require('../src/config');

const JWT_SECRET = 'test-only-secret-with-at-least-thirty-two-bytes';

test('reads every supported environment setting', () => {
    const config = readConfig({
        NODE_ENV: 'test',
        HOST: '0.0.0.0',
        PORT: '9000',
        WS_PATH: '/chat',
        MAX_PAYLOAD_BYTES: '1000',
        MAX_MESSAGE_CONTENT_LENGTH: '101',
        MAX_USER_ID_LENGTH: '102',
        MAX_MESSAGE_TYPE_LENGTH: '103',
        MAX_CORRELATION_ID_LENGTH: '104',
        MAX_CONNECTIONS_PER_USER: '5',
        MAX_BUFFERED_BYTES: '1005',
        CONNECTION_RATE_LIMIT: '6',
        CONNECTION_RATE_WINDOW_MS: '1006',
        MESSAGE_RATE_LIMIT: '7',
        MESSAGE_RATE_WINDOW_MS: '1007',
        MESSAGE_DEDUPLICATION_TTL_MS: '1008',
        MAX_DEDUPLICATION_ENTRIES_PER_USER: '8',
        HEARTBEAT_INTERVAL_MS: '1009',
        SHUTDOWN_GRACE_MS: '1010',
        JWT_SECRET,
        JWT_ISSUER: 'https://auth.example.com',
        JWT_AUDIENCE: 'simple-chat',
        ALLOWED_ORIGINS: 'https://chat.example.com, http://localhost:3000 '
    });

    assert.deepEqual(config, {
        nodeEnv: 'test',
        host: '0.0.0.0',
        port: 9000,
        wsPath: '/chat',
        maxPayloadBytes: 1000,
        maxMessageContentLength: 101,
        maxUserIdLength: 102,
        maxMessageTypeLength: 103,
        maxCorrelationIdLength: 104,
        maxConnectionsPerUser: 5,
        maxBufferedBytes: 1005,
        connectionRateLimit: 6,
        connectionRateWindowMs: 1006,
        messageRateLimit: 7,
        messageRateWindowMs: 1007,
        messageDeduplicationTtlMs: 1008,
        maxDeduplicationEntriesPerUser: 8,
        heartbeatIntervalMs: 1009,
        shutdownGraceMs: 1010,
        jwtSecret: JWT_SECRET,
        jwtIssuer: 'https://auth.example.com',
        jwtAudience: 'simple-chat',
        allowedOrigins: ['https://chat.example.com', 'http://localhost:3000']
    });
});

test('uses defaults for optional environment settings', () => {
    const config = readConfig({JWT_SECRET});

    assert.equal(config.nodeEnv, DEFAULT_CONFIG.nodeEnv);
    assert.equal(config.host, DEFAULT_CONFIG.host);
    assert.equal(config.port, DEFAULT_CONFIG.port);
    assert.equal(config.maxPayloadBytes, DEFAULT_CONFIG.maxPayloadBytes);
    assert.equal(config.jwtIssuer, undefined);
    assert.equal(config.jwtAudience, undefined);
    assert.deepEqual(config.allowedOrigins, []);
});

test('rejects invalid numeric environment settings', () => {
    for (const invalid of ['0', '-1', '1.5', 'not-a-number']) {
        assert.throws(
            () => readConfig({PORT: invalid}),
            /PORT must be a positive integer/u
        );
    }
});

test('validates required and bounded server configuration', () => {
    assert.throws(
        () => validateConfig({}),
        /JWT_SECRET must contain at least 32 bytes/u
    );
    assert.throws(
        () => validateConfig({jwtSecret: 'too-short'}),
        /JWT_SECRET must contain at least 32 bytes/u
    );
    assert.throws(
        () => validateConfig({jwtSecret: JWT_SECRET, port: 65536}),
        /PORT must be an integer between 0 and 65535/u
    );
    assert.throws(
        () => validateConfig({jwtSecret: JWT_SECRET, maxPayloadBytes: 0}),
        /maxPayloadBytes must be a positive integer/u
    );
    assert.throws(
        () => validateConfig({jwtSecret: JWT_SECRET, nodeEnv: ''}),
        /NODE_ENV must not be empty/u
    );
    assert.throws(
        () => validateConfig({jwtSecret: JWT_SECRET, host: ''}),
        /HOST must not be empty/u
    );
    assert.throws(
        () => validateConfig({jwtSecret: JWT_SECRET, wsPath: 'chat'}),
        /WS_PATH must start with/u
    );
});

test('accepts only exact HTTP origins and requires them in production', () => {
    assert.throws(
        () => validateConfig({
            jwtSecret: JWT_SECRET,
            allowedOrigins: 'https://chat.example.com'
        }),
        /ALLOWED_ORIGINS must contain valid/u
    );
    assert.throws(
        () => validateConfig({
            jwtSecret: JWT_SECRET,
            allowedOrigins: ['not-an-origin']
        }),
        /ALLOWED_ORIGINS must contain valid/u
    );
    assert.throws(
        () => validateConfig({
            jwtSecret: JWT_SECRET,
            allowedOrigins: ['https://chat.example.com/path']
        }),
        /ALLOWED_ORIGINS must contain valid/u
    );
    assert.throws(
        () => validateConfig({
            jwtSecret: JWT_SECRET,
            nodeEnv: 'production'
        }),
        /ALLOWED_ORIGINS must not be empty in production/u
    );

    const config = validateConfig({
        jwtSecret: JWT_SECRET,
        nodeEnv: 'production',
        port: 0,
        allowedOrigins: ['https://chat.example.com']
    });
    assert.equal(Object.isFrozen(config), true);
});
