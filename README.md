# simpleChat

Small authenticated WebSocket relay for direct, online-only chat messages.

The service verifies short-lived HS256 JWTs, keeps active connections in memory
and forwards messages to every active connection of the recipient. It does not
store message bodies and is intentionally designed for a single server process.
Short-lived message identifiers are retained in memory to make client retries
idempotent.

## Requirements

- Node.js 20 or newer
- npm
- A JWT issuer using the same secret and the claims described below
- Caddy and systemd for the included production deployment

## Local development

```sh
npm ci
cp .env.example .env
```

Set a base64url-safe `JWT_SECRET` containing at least 32 characters, then run:

```sh
npm start
```

The default WebSocket URL is `ws://127.0.0.1:8080/`. Liveness and readiness
endpoints are available at `/healthz` and `/readyz`.

## Authentication

JWTs must:

- use `HS256`;
- contain a non-empty string `userId`;
- contain a valid future `exp` claim;
- match `JWT_ISSUER` and `JWT_AUDIENCE` when those settings are configured.

Browser clients can pass the token using two WebSocket subprotocol values:

```js
const socket = new WebSocket(
  'wss://chat.example.com/',
  ['simplechat', `bearer.${token}`]
);
```

Non-browser clients may instead use `Authorization: Bearer <token>`. A raw JWT
as the sole WebSocket subprotocol remains supported for compatibility, but the
two-value form above avoids echoing the token as the selected subprotocol.

Set `ALLOWED_ORIGINS` to a comma-separated list of exact HTTP(S) origins, for
example `https://chat.example.com`. The service refuses to start with an empty
allowlist when `NODE_ENV=production`. Requests without an `Origin` header remain
supported for non-browser clients.

## Protocol

Every client request may contain a `requestId`. The corresponding response
echoes it so clients can correlate concurrent commands. A new message should
also have a stable `messageId`, which the client reuses when retrying:

```json
{
  "command": "sendMessage",
  "requestId": "request-42",
  "messageId": "message-42",
  "recipientId": "bob",
  "message": {
    "content": "Hello",
    "type": "text"
  }
}
```

The recipient receives:

```json
{
  "command": "message",
  "messageId": "message-42",
  "from": "alice",
  "timestamp": "2026-07-23T12:00:00.000Z",
  "message": {
    "content": "Hello",
    "type": "text"
  }
}
```

Only the sender connection that issued the command receives its acknowledgement:

```json
{
  "command": "sendMessage",
  "status": "success",
  "requestId": "request-42",
  "messageId": "message-42",
  "recipientId": "bob",
  "timestamp": "2026-07-23T12:00:00.000Z"
}
```

Retrying the same payload with the same `messageId` does not redeliver it and
returns the stored acknowledgement with `"duplicate": true`. Reusing an
identifier with a different payload returns `MESSAGE_ID_CONFLICT`. This
deduplication is bounded, in memory and valid for five minutes by default.
Legacy requests without `requestId` or `messageId` remain accepted; the server
generates the message identifier.

Check online presence:

```json
{"command":"isOnline","requestId":"presence-42","userIdToCheck":"bob"}
```

Message content is converted to plain text. Clients must still render it as
text, never by assigning it to `innerHTML`.

## Security and limits

Defaults include:

- 16 KiB maximum WebSocket payload;
- 4096-character message content;
- 5 simultaneous connections per user;
- 30 connection attempts per IP per minute;
- 100 messages per user per minute;
- five-minute, 1000-entry-per-user message deduplication;
- disabled WebSocket compression;
- heartbeat cleanup and output backpressure protection;
- graceful shutdown with close code `1001` and a five-second deadline;
- loopback-only application listener.

See [.env.example](.env.example) for configurable values. Rate-limit state,
presence and message deduplication are in memory, so horizontal scaling requires
a shared store/pub-sub layer.

## Tests

```sh
npm run check
npm run lint
npm run coverage
npm run audit
```

The integration tests cover health/readiness, JWT authentication and claims,
malformed payloads, routing, sanitization, rate limiting, connection limits,
presence cleanup, Origin filtering, payload limits, correlated
acknowledgements, retry deduplication and graceful shutdown. Coverage thresholds
are 80% for lines and functions and 70% for branches.

GitHub Actions runs syntax checks, ESLint, coverage-gated integration tests and
the production dependency audit on Node.js 20, 22 and 24 for every push and
pull request.

The executable entrypoint is intentionally small. Application code is split
under `src/` into configuration, authentication, protocol validation,
rate-limiting, deduplication and server lifecycle modules.

## Debian/Ubuntu deployment

Run `setup.sh` as root on a clean host. It installs dependencies, creates an
unprivileged `simplechat` user, configures systemd and prepares Caddy. Each
release is an immutable Git worktree under `/app/releases`; `/app/current` is
switched atomically only after dependency installation, syntax checks,
integration tests, production configuration validation and Caddy validation
succeed. Shared secrets live in `/app/shared/.env`. Enter a real hostname such
as `chat.example.com` to enable Caddy's automatic HTTPS. Use `http://localhost`
only for local testing.

Future updates can be applied with `update.sh`. The updater:

- prepares and verifies a new detached release before activation;
- switches `/app/current` atomically;
- installs exactly the locked production dependencies;
- validates Caddy before replacing its configuration;
- waits for `/readyz` after restart;
- automatically restores the previous release and system configuration when
  activation or readiness fails.

Old releases are intentionally retained for inspection or manual rollback.
Hosts using the former single-checkout `/app` layout must be backed up and
reinstalled once with the current `setup.sh`.
