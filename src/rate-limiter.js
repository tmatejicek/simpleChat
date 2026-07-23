'use strict';

function createFixedWindowLimiter(limit, windowMs) {
    const entries = new Map();
    let operations = 0;

    return {
        consume(key, now = Date.now()) {
            let entry = entries.get(key);
            if (!entry || entry.resetAt <= now) {
                entry = {count: 0, resetAt: now + windowMs};
                entries.set(key, entry);
            }

            entry.count += 1;
            operations += 1;

            if (operations % 100 === 0) {
                for (const [storedKey, storedEntry] of entries) {
                    if (storedEntry.resetAt <= now) {
                        entries.delete(storedKey);
                    }
                }
            }

            return entry.count <= limit;
        },

        clear() {
            entries.clear();
        }
    };
}

module.exports = {createFixedWindowLimiter};
