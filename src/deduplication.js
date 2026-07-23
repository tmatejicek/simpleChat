'use strict';

function createDeduplicationStore({ttlMs, maxEntriesPerUser, now = Date.now}) {
    const entriesByUser = new Map();

    function activeEntries(userId) {
        const currentTime = now();
        let entries = entriesByUser.get(userId);
        if (!entries) {
            entries = new Map();
            entriesByUser.set(userId, entries);
            return entries;
        }

        for (const [messageId, entry] of entries) {
            if (entry.expiresAt <= currentTime) {
                entries.delete(messageId);
            }
        }

        return entries;
    }

    return {
        lookup(userId, messageId, fingerprint) {
            const entry = activeEntries(userId).get(messageId);
            if (!entry) {
                return {status: 'miss'};
            }

            if (entry.fingerprint !== fingerprint) {
                return {status: 'conflict'};
            }

            return {status: 'hit', acknowledgement: entry.acknowledgement};
        },

        remember(userId, messageId, fingerprint, acknowledgement) {
            const entries = activeEntries(userId);
            if (entries.size >= maxEntriesPerUser) {
                const oldestMessageId = entries.keys().next().value;
                entries.delete(oldestMessageId);
            }

            entries.set(messageId, {
                fingerprint,
                acknowledgement,
                expiresAt: now() + ttlMs
            });
        },

        clear() {
            entriesByUser.clear();
        }
    };
}

module.exports = {createDeduplicationStore};
