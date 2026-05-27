"use strict";

function resolveRegisteredServer(node, msg, registry) {
    const msgReference = msg && msg.opcua && msg.opcua.server ? msg.opcua.server : "";
    const server = registry.resolveServer(msgReference || node.serverRef);

    if (!server) {
        throw new Error("No OPC UA server matched the configured reference");
    }

    return server;
}

module.exports = {
    resolveRegisteredServer
};
