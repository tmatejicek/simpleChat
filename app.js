'use strict';

require('dotenv').config();

const {readConfig} = require('./src/config');
const {parseMessage} = require('./src/protocol');
const {createChatServer} = require('./src/server');

async function main() {
    let chatServer;
    try {
        chatServer = createChatServer(readConfig());
        const address = await chatServer.start();
        console.log(`Server is listening on ws://${address.address}:${address.port}`);
    } catch (error) {
        console.error(`Server failed to start: ${error.message}`);
        process.exitCode = 1;
        return;
    }

    let shuttingDown = false;
    const shutdown = async signal => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        console.log(`Received ${signal}, shutting down`);

        try {
            await chatServer.stop();
        } catch (error) {
            console.error(`Shutdown failed: ${error.message}`);
            process.exitCode = 1;
        }
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
    main();
}

module.exports = {
    createChatServer,
    parseMessage,
    readConfig
};
