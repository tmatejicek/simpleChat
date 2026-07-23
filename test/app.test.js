'use strict';

const assert = require('node:assert/strict');
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

function openClient(url, token, options = {}) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, ['simplechat', `bearer.${token}`], options);
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

test('rejects JWTs without an expiration claim', async () => {
    await withServer({}, async ({url}) => {
        const token = jwt.sign({userId: 'alice'}, JWT_SECRET, {algorithm: 'HS256'});
        const result = await connectionStatus(url, token);

        assert.equal(result.statusCode, 401);
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
            recipientId: 'bob',
            message: {
                content: '<b>Hello</b><script>alert(1)</script>',
                type: 'text'
            }
        }));

        const delivered = await bobMessage;
        assert.equal(delivered.command, 'message');
        assert.equal(delivered.from, 'alice');
        assert.equal(delivered.message.type, 'text');
        assert.match(delivered.message.content, /Hello/u);
        assert.doesNotMatch(delivered.message.content, /[<>]/u);
        assert.deepEqual(await aliceAcknowledgement, {
            command: 'sendMessage',
            status: 'success'
        });
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
