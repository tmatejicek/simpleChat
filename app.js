require('dotenv').config(); // Načte proměnné prostředí z .env souboru

const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const sanitizeHtml = require('sanitize-html');

// Konfigurace
const PORT = 8080;
const JWT_SECRET = process.env.JWT_SECRET; // Získání tajné hodnoty z prostředí
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minut
const RATE_LIMIT_MAX = 100; // 100 požadavků

// Vytvoření aplikace a serveru
const app = express();

// Nastavte ip-adresu důvěryhodného reverzního proxy serveru, například
// haproxy nebo Apache mod proxy nebo nginx nakonfigurovaný jako proxy nebo jiné.
// Proxy server by měl vložit ip adresu vzdáleného klienta
// prostřednictvím hlavičky požadavku 'X-Forwarded-For' jako
// 'X-Forwarded-For: some.client.ip.address'
// Vložení hlavičky forward je volitelnou možností většiny proxy softwaru.
app.set('trust proxy', '127.0.0.1');

const server = http.createServer(app);
const wss = new WebSocket.Server({server});

// Rate Limiting Middleware
const limiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX, message: 'Too many requests, please try again later.'
});

app.use(limiter);

// Autentizace a autorizace
function authenticate(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return null;
    }
}

// Mapa pro uložení připojených klientů podle jejich unikátního řetězce (ID)
const clients = new Map();

wss.on('connection', (ws, req) => {
    const token = req.headers['sec-websocket-protocol'];

    const user = authenticate(token);
    if (!user) {
        ws.close(4000, 'Invalid Token');
        return;
    }

    const userId = user.userId;

    clients.set(userId, ws);

    ws.on('message', (message) => {
        const data = JSON.parse(message);

        // Zpracování příkazů
        switch (data.command) {
            case 'sendMessage':
                // Odesílání zprávy jinému uživateli
                const recipient = clients.get(sanitizeHtml(data.recipientId));
                if (recipient) {
                    recipient.send(JSON.stringify({
                        command: 'message', from: userId, message: {
                            content: sanitizeHtml(data.message.content), type: sanitizeHtml(data.message.type)
                        }
                    }));
                    ws.send(JSON.stringify({command: 'sendMessage', status: 'success'}));
                } else {
                    ws.send(JSON.stringify({command: 'sendMessage', status: 'error', error: 'User not online'}));
                }
                break;

            case 'isOnline':
                // Ověření, zda je daný uživatel online
                const isOnline = clients.has(sanitizeHtml(data.userIdToCheck));
                ws.send(JSON.stringify({command: 'isOnline', status: isOnline}));
                break;

            default:
                ws.send(JSON.stringify({command: 'error', message: 'Unknown command'}));
                break;
        }
    });

    ws.on('close', () => {
        if (userId) {
            clients.delete(userId);
        }
    });
});

// Spuštění serveru
server.listen(PORT, () => {
    console.log(`Server is listening on ws://localhost:${PORT}`);
});
