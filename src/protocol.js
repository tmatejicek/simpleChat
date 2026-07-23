'use strict';

const sanitizeHtml = require('sanitize-html');

const PLAIN_TEXT_SANITIZE_OPTIONS = Object.freeze({
    allowedTags: [],
    allowedAttributes: {}
});

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsControlCharacter(value) {
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint <= 0x1f || codePoint === 0x7f) {
            return true;
        }
    }

    return false;
}

function isValidUserId(value, maxLength) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maxLength
        && !containsControlCharacter(value);
}

function isValidCorrelationId(value, maxLength) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maxLength
        && /^[a-zA-Z0-9._:-]+$/u.test(value);
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

    const requestId = data.requestId;
    if (requestId !== undefined
        && !isValidCorrelationId(requestId, config.maxCorrelationIdLength)) {
        return {error: {code: 'INVALID_PAYLOAD', message: 'Invalid requestId'}};
    }

    if (data.command === 'sendMessage') {
        const validMessageId = data.messageId === undefined
            || isValidCorrelationId(data.messageId, config.maxCorrelationIdLength);
        const validPayload = validMessageId
            && isValidUserId(data.recipientId, config.maxUserIdLength)
            && isPlainObject(data.message)
            && typeof data.message.content === 'string'
            && data.message.content.length <= config.maxMessageContentLength
            && typeof data.message.type === 'string'
            && data.message.type.length > 0
            && data.message.type.length <= config.maxMessageTypeLength
            && /^[a-zA-Z0-9._-]+$/u.test(data.message.type);

        if (!validPayload) {
            return {
                error: {
                    code: 'INVALID_PAYLOAD',
                    message: 'Invalid sendMessage payload',
                    ...(requestId ? {requestId} : {})
                }
            };
        }
    } else if (data.command === 'isOnline'
        && !isValidUserId(data.userIdToCheck, config.maxUserIdLength)) {
        return {
            error: {
                code: 'INVALID_PAYLOAD',
                message: 'Invalid isOnline payload',
                ...(requestId ? {requestId} : {})
            }
        };
    }

    return {data};
}

function sanitizeMessageContent(content) {
    return sanitizeHtml(content, PLAIN_TEXT_SANITIZE_OPTIONS);
}

function withRequestId(payload, requestId) {
    return requestId ? {...payload, requestId} : payload;
}

module.exports = {
    isPlainObject,
    isValidUserId,
    parseMessage,
    sanitizeMessageContent,
    withRequestId
};
