'use strict';

const jwt = require('jsonwebtoken');
const {isPlainObject, isValidUserId} = require('./protocol');

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

module.exports = {
    authenticate,
    clientIp,
    isAllowedOrigin
};
