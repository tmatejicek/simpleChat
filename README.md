# simpleChat

Small authenticated WebSocket relay for direct, online-only chat messages.

The service verifies short-lived HS256 JWTs, keeps active connections in memory
and forwards messages to every active connection of the recipient. It does not
store messages and is intentionally designed for a single server process.

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

The default WebSocket URL is `ws://127.0.0.1:8080/`. The health endpoint is
available at `http://127.0.0.1:8080/healthz`.

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

Set `ALLOWED_ORIGINS` to a comma-separated allowlist for browser clients in
production, for example `https://chat.example.com`.

## Protocol

Send a message:

```json
{
  "command": "sendMessage",
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
  "from": "alice",
  "message": {
    "content": "Hello",
    "type": "text"
  }
}
```

Check online presence:

```json
{"command":"isOnline","userIdToCheck":"bob"}
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
- disabled WebSocket compression;
- heartbeat cleanup and output backpressure protection;
- loopback-only application listener.

See [.env.example](.env.example) for configurable values. Rate-limit state and
presence are in memory, so horizontal scaling requires a shared store/pub-sub
layer.

## Tests

```sh
npm run check
npm test
npm run audit
```

The integration tests cover JWT rejection, malformed payloads, routing,
sanitization, rate limiting, connection limits, Origin filtering and payload
limits.

## Debian/Ubuntu deployment

Run `setup.sh` as root on a clean host. It installs dependencies, creates an
unprivileged `simplechat` user, configures systemd and prepares Caddy. Enter a
real hostname such as `chat.example.com` to enable Caddy's automatic HTTPS.
Use `http://localhost` only for local testing.

Future updates can be applied with `update.sh`. The updater:

- refuses to overwrite local Git changes;
- accepts only fast-forward updates;
- installs exactly the locked production dependencies;
- validates Caddy configuration before replacing it;
- restarts only the SimpleChat service.
