'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const {createChatServer} = require('../app');

const JWT_SECRET = 'test-only-secret-with-at-least-thirty-two-bytes';
const silentLogger = {
    error() {},
    log() {},
    warn() {}
};

function createToken(userId, options = {}) {
    return jwt.sign(
        {userId},
        JWT_SECRET,
        {algorithm: 'HS256', expiresIn: '5m', ...options}
    );
}

async function withServer(overrides, callback) {
    const chatServer = createChatServer({
        jwtSecret: JWT_SECRET,
        port: 0,
        heartbeatIntervalMs: 60 * 1000,
        logger: silentLogger,
        ...overrides
    });
    const address = await chatServer.start();
    const url = `ws://127.0.0.1:${address.port}/`;

    try {
        await callback({chatServer, url, address});
    } finally {
        await chatServer.stop();
    }
}

function waitForOpen(ws) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.terminate();
            reject(new Error('WebSocket connection timed out'));
        }, 2000);

        ws.once('open', () => {
            clearTimeout(timer);
            ws.on('error', () => {});
            resolve(ws);
        });
        ws.once('unexpected-response', (request, response) => {
            clearTimeout(timer);
            response.resume();
            reject(new Error(`Unexpected HTTP ${response.statusCode}`));
        });
        ws.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

function openClient(url, token, options = {}) {
    return waitForOpen(new WebSocket(url, ['simplechat', `bearer.${token}`], options));
}

function openAuthorizationClient(url, token) {
    return waitForOpen(new WebSocket(url, {
        headers: {Authorization: `Bearer ${token}`}
    }));
}

function connectionStatus(url, token, options = {}) {
    return new Promise(resolve => {
        const ws = new WebSocket(url, ['simplechat', `bearer.${token}`], options);
        const timer = setTimeout(() => {
            ws.terminate();
            resolve({statusCode: 0});
        }, 2000);
        let settled = false;

        const finish = result => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };

        ws.on('open', () => finish({statusCode: 101, ws}));
        ws.on('unexpected-response', (request, response) => {
            response.resume();
            finish({statusCode: response.statusCode});
        });
        ws.on('error', error => finish({statusCode: 0, error}));
    });
}

function nextJson(ws) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('Timed out waiting for a WebSocket message'));
        }, 2000);

        ws.once('message', message => {
            clearTimeout(timer);
            try {
                resolve(JSON.parse(message.toString('utf8')));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function expectNoMessage(ws, durationMs = 75) {
    return new Promise((resolve, reject) => {
        const handleMessage = () => {
            clearTimeout(timer);
            reject(new Error('Received an unexpected WebSocket message'));
        };
        const timer = setTimeout(() => {
            ws.off('message', handleMessage);
            resolve();
        }, durationMs);

        ws.once('message', handleMessage);
    });
}

function nextClose(ws) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('Timed out waiting for WebSocket close'));
        }, 2000);

        ws.once('close', (code, reason) => {
            clearTimeout(timer);
            resolve({code, reason: reason.toString('utf8')});
        });
    });
}

function closeClient(ws) {
    const closed = nextClose(ws);
    ws.close(1000, 'Test complete');
    return closed;
}

function getJson(port, path) {
    return new Promise((resolve, reject) => {
        const request = http.get({
            host: '127.0.0.1',
            port,
            path,
            timeout: 2000
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                try {
                    resolve({
                        statusCode: response.statusCode,
                        headers: response.headers,
                        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
                    });
                } catch (error) {
                    reject(error);
                }
            });
        });

        request.on('timeout', () => {
            request.destroy(new Error('HTTP request timed out'));
        });
        request.on('error', reject);
    });
}

test('tracks lifecycle state and rejects duplicate starts', async () => {
    const chatServer = createChatServer({
        jwtSecret: JWT_SECRET,
        port: 0,
        heartbeatIntervalMs: 60 * 1000,
        logger: silentLogger
    });

    assert.equal(chatServer.getStatus(), 'idle');
    await chatServer.start();

    try {
        assert.equal(chatServer.getStatus(), 'running');
        await assert.rejects(chatServer.start(), /cannot start while running/u);
    } finally {
        await chatServer.stop();
    }

    assert.equal(chatServer.getStatus(), 'stopped');
});

test('exposes minimal liveness and readiness endpoints', async () => {
    await withServer({}, async ({chatServer, address}) => {
        const health = await getJson(address.port, '/healthz');
        const readiness = await getJson(address.port, '/readyz');

        assert.equal(chatServer.getStatus(), 'running');
        assert.equal(health.statusCode, 200);
        assert.deepEqual(health.body, {status: 'ok'});
        assert.equal(health.headers['cache-control'], 'no-store');
        assert.equal(health.headers['x-powered-by'], undefined);
        assert.equal(readiness.statusCode, 200);
        assert.deepEqual(readiness.body, {status: 'ready'});
    });
});

test('requires an Origin allowlist in production configuration', () => {
    assert.throws(() => createChatServer({
        jwtSecret: JWT_SECRET,
        nodeEnv: 'production'
    }), /ALLOWED_ORIGINS must not be empty/u);

    const chatServer = createChatServer({
        jwtSecret: JWT_SECRET,
        nodeEnv: 'production',
        allowedOrigins: ['https://chat.example.com']
    });
    assert.deepEqual(chatServer.config.allowedOrigins, ['https://chat.example.com']);
});

test('rejects JWTs without an expiration claim', async () => {
    await withServer({}, async ({url}) => {
        const token = jwt.sign({userId: 'alice'}, JWT_SECRET, {algorithm: 'HS256'});
        const result = await connectionStatus(url, token);

        assert.equal(result.statusCode, 401);
    });
});

test('accepts bearer authentication for non-browser clients', async () => {
    await withServer({}, async ({url}) => {
        const alice = await openAuthorizationClient(url, createToken('alice'));
        const reply = nextJson(alice);

        alice.send(JSON.stringify({command: 'isOnline', userIdToCheck: 'alice'}));
        assert.deepEqual(await reply, {command: 'isOnline', status: true});
    });
});

test('enforces configured JWT issuer and audience claims', async () => {
    await withServer({
        jwtIssuer: 'https://auth.example.com',
        jwtAudience: 'simple-chat'
    }, async ({url}) => {
        const missingClaims = await connectionStatus(url, createToken('alice'));
        assert.equal(missingClaims.statusCode, 401);

        const validToken = createToken('alice', {
            issuer: 'https://auth.example.com',
            audience: 'simple-chat'
        });
        const alice = await openClient(url, validToken);
        assert.equal(alice.readyState, WebSocket.OPEN);
    });
});

test('handles malformed JSON without dropping the connection', async () => {
    await withServer({}, async ({url}) => {
        const alice = await openClient(url, createToken('alice'));

        const invalidReply = nextJson(alice);
        alice.send('{broken');
        assert.deepEqual(await invalidReply, {
            command: 'error',
            code: 'INVALID_JSON',
            message: 'Invalid JSON'
        });

        const onlineReply = nextJson(alice);
        alice.send(JSON.stringify({command: 'isOnline', userIdToCheck: 'alice'}));
        assert.deepEqual(await onlineReply, {
            command: 'isOnline',
            status: true
        });
    });
});

test('rejects binary messages without dropping the connection', async () => {
    await withServer({}, async ({url}) => {
        const alice = await openClient(url, createToken('alice'));
        const binaryReply = nextJson(alice);
        alice.send(Buffer.from('binary'));

        assert.deepEqual(await binaryReply, {
            command: 'error',
            code: 'BINARY_NOT_SUPPORTED',
            message: 'Binary messages are not supported'
        });

        const onlineReply = nextJson(alice);
        alice.send(JSON.stringify({command: 'isOnline', userIdToCheck: 'alice'}));
        assert.equal((await onlineReply).status, true);
    });
});

test('rejects malformed command payloads', async () => {
    await withServer({}, async ({url}) => {
        const alice = await openClient(url, createToken('alice'));
        const reply = nextJson(alice);

        alice.send(JSON.stringify({
            command: 'sendMessage',
            recipientId: 'bob',
            message: {type: 'text'}
        }));

        assert.deepEqual(await reply, {
            command: 'error',
            code: 'INVALID_PAYLOAD',
            message: 'Invalid sendMessage payload'
        });
    });
});

test('routes plain-text messages and acknowledges the sender', async () => {
    await withServer({}, async ({url}) => {
        const alice = await openClient(url, createToken('alice'));
        const bob = await openClient(url, createToken('bob'));
        const bobMessage = nextJson(bob);
        const aliceAcknowledgement = nextJson(alice);

        alice.send(JSON.stringify({
            command: 'sendMessage',
            requestId: 'request-123',
            messageId: 'message-123',
            recipientId: 'bob',
            message: {
                content: '<b>Hello</b><script>alert(1)</script>',
                type: 'text'
            }
        }));

        const delivered = await bobMessage;
        assert.equal(delivered.command, 'message');
        assert.equal(delivered.messageId, 'message-123');
        assert.equal(delivered.from, 'alice');
        assert.equal(delivered.message.type, 'text');
        assert.match(delivered.timestamp, /^\d{4}-\d{2}-\d{2}T/u);
        assert.match(delivered.message.content, /Hello/u);
        assert.doesNotMatch(delivered.message.content, /[<>]/u);
        const acknowledgement = await aliceAcknowledgement;
        assert.equal(acknowledgement.command, 'sendMessage');
        assert.equal(acknowledgement.status, 'success');
        assert.equal(acknowledgement.requestId, 'request-123');
        assert.equal(acknowledgement.messageId, 'message-123');
        assert.equal(acknowledgement.recipientId, 'bob');
        assert.equal(acknowledgement.timestamp, delivered.timestamp);
    });
});

test('sends acknowledgements only to the originating sender connection', async () => {
    await withServer({}, async ({url}) => {
        const aliceOrigin = await openClient(url, createToken('alice'));
        const aliceOtherDevice = await openClient(url, createToken('alice'));
        const bob = await openClient(url, createToken('bob'));
        const bobMessage = nextJson(bob);
        const acknowledgement = nextJson(aliceOrigin);
        const noOtherAcknowledgement = expectNoMessage(aliceOtherDevice);

        aliceOrigin.send(JSON.stringify({
            command: 'sendMessage',
            requestId: 'origin-request',
            messageId: 'origin-message',
            recipientId: 'bob',
            message: {content: 'Hello', type: 'text'}
        }));

        await bobMessage;
        assert.equal((await acknowledgement).requestId, 'origin-request');
        await noOtherAcknowledgement;
    });
});

test('deduplicates retries by messageId and detects conflicting reuse', async () => {
    await withServer({}, async ({url}) => {
        const alice = await openClient(url, createToken('alice'));
        const bob = await openClient(url, createToken('bob'));
        const payload = {
            command: 'sendMessage',
            requestId: 'first-attempt',
            messageId: 'stable-message-id',
            recipientId: 'bob',
            message: {content: 'Hello once', type: 'text'}
        };

        const firstDelivery = nextJson(bob);
        const firstAcknowledgement = nextJson(alice);
        alice.send(JSON.stringify(payload));
        await firstDelivery;
        assert.equal((await firstAcknowledgement).duplicate, undefined);

        const retryAcknowledgement = nextJson(alice);
        const noDuplicateDelivery = expectNoMessage(bob);
        alice.send(JSON.stringify({...payload, requestId: 'retry-attempt'}));
        const retry = await retryAcknowledgement;
        assert.equal(retry.status, 'success');
        assert.equal(retry.requestId, 'retry-attempt');
        assert.equal(retry.messageId, 'stable-message-id');
        assert.equal(retry.duplicate, true);
        await noDuplicateDelivery;

        const conflictReply = nextJson(alice);
        alice.send(JSON.stringify({
            ...payload,
            requestId: 'conflicting-attempt',
            message: {content: 'Different content', type: 'text'}
        }));
        const conflict = await conflictReply;
        assert.equal(conflict.status, 'error');
        assert.equal(conflict.code, 'MESSAGE_ID_CONFLICT');
        assert.equal(conflict.requestId, 'conflicting-attempt');
    });
});

test('generates a messageId for legacy sendMessage payloads', async () => {
    await withServer({}, async ({url}) => {
        const alice = await openClient(url, createToken('alice'));
        const bob = await openClient(url, createToken('bob'));
        const delivery = nextJson(bob);
        const acknowledgement = nextJson(alice);

        alice.send(JSON.stringify({
            command: 'sendMessage',
            recipientId: 'bob',
            message: {content: 'Legacy message', type: 'text'}
        }));

        const delivered = await delivery;
        const acknowledged = await acknowledgement;
        assert.match(delivered.messageId, /^[0-9a-f-]{36}$/u);
        assert.equal(acknowledged.messageId, delivered.messageId);
    });
});

test('enforces a message rate limit across a user connection', async () => {
    await withServer({messageRateLimit: 2}, async ({url}) => {
        const alice = await openClient(url, createToken('alice'));

        for (let index = 0; index < 2; index += 1) {
            const reply = nextJson(alice);
            alice.send(JSON.stringify({command: 'isOnline', userIdToCheck: 'alice'}));
            assert.equal((await reply).command, 'isOnline');
        }

        const limitedReply = nextJson(alice);
        alice.send(JSON.stringify({command: 'isOnline', userIdToCheck: 'alice'}));
        assert.deepEqual(await limitedReply, {
            command: 'error',
            code: 'RATE_LIMITED',
            message: 'Too many messages'
        });
    });
});

test('enforces the per-user connection limit before the WebSocket handshake', async () => {
    await withServer({maxConnectionsPerUser: 1}, async ({url}) => {
        await openClient(url, createToken('alice'));
        const secondConnection = await connectionStatus(url, createToken('alice'));

        assert.equal(secondConnection.statusCode, 429);
    });
});

test('removes presence after the final user connection closes', async () => {
    await withServer({}, async ({url}) => {
        const alice = await openClient(url, createToken('alice'));
        const bob = await openClient(url, createToken('bob'));

        await closeClient(bob);
        await new Promise(resolve => setImmediate(resolve));

        const reply = nextJson(alice);
        alice.send(JSON.stringify({command: 'isOnline', userIdToCheck: 'bob'}));
        assert.deepEqual(await reply, {command: 'isOnline', status: false});
    });
});

test('closes connections that exceed the payload limit', async () => {
    await withServer({maxPayloadBytes: 128}, async ({url}) => {
        const alice = await openClient(url, createToken('alice'));
        const close = nextClose(alice);

        alice.send(JSON.stringify({
            command: 'sendMessage',
            recipientId: 'bob',
            message: {content: 'x'.repeat(512), type: 'text'}
        }));

        assert.equal((await close).code, 1009);
    });
});

test('enforces the configured browser Origin allowlist', async () => {
    await withServer({allowedOrigins: ['https://chat.example.com']}, async ({url}) => {
        const result = await connectionStatus(
            url,
            createToken('alice'),
            {origin: 'https://evil.example'}
        );

        assert.equal(result.statusCode, 403);
    });
});

test('closes active clients gracefully during shutdown', async () => {
    const chatServer = createChatServer({
        jwtSecret: JWT_SECRET,
        port: 0,
        heartbeatIntervalMs: 60 * 1000,
        shutdownGraceMs: 1000,
        logger: silentLogger
    });
    const address = await chatServer.start();
    const alice = await openClient(
        `ws://127.0.0.1:${address.port}/`,
        createToken('alice')
    );
    const closed = nextClose(alice);

    const stopping = chatServer.stop();
    const closeEvent = await closed;
    await stopping;

    assert.equal(closeEvent.code, 1001);
    assert.equal(closeEvent.reason, 'Server shutting down');
    assert.equal(chatServer.getStatus(), 'stopped');
});
