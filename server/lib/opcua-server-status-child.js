"use strict";


const registry = require("../opcua-server-registry");
const { resolveRegisteredServer } = require("./server-node-utils");

function OpcUaServerStatusNode(node, msg, nodeId) {

    try {
        const serverNode = resolveRegisteredServer(node, msg, registry);
        const snapshot = buildServerSnapshot(serverNode);

        msg.payload = snapshot;
        msg.opcua = msg.opcua || {};
        msg.opcua.server = snapshot.identity.serverRef;
        msg.opcua.endpointUrl = snapshot.endpointUrl;



        process.send({
            type: "status",
            data: {
                fill: "green",
                shape: "dot",
                text: "sessions " + snapshot.counters.currentSessionCount
            },
            nodeId: nodeId
        });

        process.send({
            type: "send",
            data: msg,
            nodeId: nodeId
        });


    } catch (error) {
        //console.error("function OpcUaServerStatusNode" + error);
        //console.error({ fill: "red", shape: "ring", text: "status failed" });

         process.send({
            type: "status",
            data: {
                fill: "red",
                shape: "ring",
                text: "Status: " + error
            },
            nodeId: nodeId
        });
        // done(error);
    }

}

function buildServerSnapshot(serverNode) {

    const server = serverNode.server;
    const primaryEndpoint = Array.isArray(server.endpoints) && server.endpoints.length
        ? server.endpoints[0]
        : null;

    return {
        identity: {
            id: serverNode.id || "",
            name: serverNode.name || "",
            serverName: serverNode.serverName || "",
            serverRef: serverNode.name || serverNode.serverName || serverNode.id || ""
        },
        state: safeCall(server, "getServerState", ""),
        endpointUrl: resolveEndpointUrl(serverNode),
        counters: {
            currentChannelCount: safeNumber(server.currentChannelCount, 0),
            currentSessionCount: safeNumber(server.currentSessionCount, 0),
            currentSubscriptionCount: safeNumber(server.currentSubscriptionCount, 0),
            bytesRead: safeNumber(server.bytesRead, 0),
            bytesWritten: safeNumber(server.bytesWritten, 0),
            transactionsCount: safeNumber(server.transactionsCount, 0),
            rejectedRequestsCount: safeNumber(server.rejectedRequestsCount, 0),
            rejectedSessionCount: safeNumber(server.rejectedSessionCount, 0),
            sessionAbortCount: safeNumber(server.sessionAbortCount, 0),
            publishingIntervalCount: safeNumber(server.publishingIntervalCount, 0),
            securityTokenCount: primaryEndpoint ? safeNumber(primaryEndpoint.securityTokenCount, 0) : 0,
            activeChannelCount: primaryEndpoint ? safeNumber(primaryEndpoint.activeChannelCount, 0) : 0
        },
        capabilities: {
            maxAllowedSessionNumber: safeNumber(server.maxAllowedSessionNumber, 0),
            initialized: Boolean(server.initialized),
            auditing: Boolean(server.isAuditing)
        },
        buildInfo: {
            productName: extractText(server.buildInfo && server.buildInfo.productName),
            buildNumber: extractText(server.buildInfo && server.buildInfo.buildNumber),
            buildDate: extractDate(server.buildInfo && server.buildInfo.buildDate)
        },
        serverInfo: {
            applicationUri: extractText(server.serverInfo && server.serverInfo.applicationUri),
            productUri: extractText(server.serverInfo && server.serverInfo.productUri),
            applicationName: extractLocalizedText(server.serverInfo && server.serverInfo.applicationName)
        },
        endpoints: Array.isArray(server.endpoints)
            ? server.endpoints.map((endpoint) => buildEndpointSnapshot(endpoint))
            : []
    };
}

function buildEndpointSnapshot(endpoint) {
    const descriptions = typeof endpoint.endpointDescriptions === "function"
        ? endpoint.endpointDescriptions()
        : [];

    return {
        port: safeNumber(endpoint.port, 0),
        currentChannelCount: safeNumber(endpoint.currentChannelCount, 0),
        activeChannelCount: safeNumber(endpoint.activeChannelCount, 0),
        bytesRead: safeNumber(endpoint.bytesRead, 0),
        bytesWritten: safeNumber(endpoint.bytesWritten, 0),
        transactionsCount: safeNumber(endpoint.transactionsCount, 0),
        securityTokenCount: safeNumber(endpoint.securityTokenCount, 0),
        endpointUrls: Array.isArray(descriptions)
            ? descriptions.map((description) => extractText(description && description.endpointUrl)).filter(Boolean)
            : []
    };
}

function resolveEndpointUrl(serverNode) {
    if (serverNode.runtime && typeof serverNode.runtime.getEndpointUrl === "function") {
        return serverNode.runtime.getEndpointUrl();
    }

    const server = serverNode.server;
    if (!server || !Array.isArray(server.endpoints)) {
        return "";
    }

    for (let index = 0; index < server.endpoints.length; index += 1) {
        const endpoint = server.endpoints[index];
        if (!endpoint || typeof endpoint.endpointDescriptions !== "function") {
            continue;
        }

        const descriptions = endpoint.endpointDescriptions();
        if (Array.isArray(descriptions) && descriptions.length && descriptions[0].endpointUrl) {
            return descriptions[0].endpointUrl;
        }
    }

    return "";
}

function safeCall(target, methodName, fallback) {
    try {
        if (target && typeof target[methodName] === "function") {
            return target[methodName]();
        }
    } catch (error) {
        // Ignore and use fallback.
    }

    return fallback;
}

function safeNumber(value, fallback) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function extractText(value) {
    return value === undefined || value === null ? "" : String(value);
}

function extractLocalizedText(value) {
    if (value && typeof value.text === "string") {
        return value.text;
    }

    return extractText(value);
}

function extractDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString();
    }

    return "";
}

module.exports = {
    "OpcUaServerStatusNode": OpcUaServerStatusNode
}