"use strict";


const registry = require("../opcua-server-registry");
const { resolveRegisteredServer } = require("./server-node-utils");




function eventsServer(node, rootNode, nodeId) {



    // 🔥 ALTERADO: usar Map para garantir unicidade por nodeID
    node.queue = {
        read: new Map(),
        write: new Map(),
        alarm: new Map()
    };

    if (node.flushTimer) {
        clearInterval(node.flushTimer);
        node.flushTimer = null;
    }


    node.flushTimer = setInterval(() => {
        flushQueue(node, nodeId);

    }, rootNode.intervalMs);

    ///rootNode.intervalMs
    node.enqueueAccessEvent = function (event) {
        if (!matchesServer(node.serverRef, event)) {

        }

        if (event.operation === "read") {
            upsertEvent(node.queue.read, event);

        }

        if (event.operation === "write") {
            upsertEvent(node.queue.write, event);
        }

        if (event.operation === "alarm") {
            upsertEvent(node.queue.alarm, event);
        }
    };

    registry.registerAccessListener(node.id, node);
}





function flushQueue(node, nodeId) {



    // ALTERADO: usar size (Map)
    if (!node.queue.read.size && !node.queue.write.size) {

    }


    const payload = {
        serverRef: node.serverRef || "",
        intervalMs: node.intervalMs,
        timestamp: new Date().toISOString(),

        // 🔥 ALTERADO: converter Map -> Array
        read: Array.from(node.queue.read.values()),
        write: Array.from(node.queue.write.values()),
        alarm: Array.from(node.queue.alarm.values())
    };

    // ALTERADO: limpar Maps
    node.queue.read.clear();
    node.queue.write.clear();
    node.queue.alarm.clear();

    process.send({
        type: "send",
        data: {
            payload,
            opcua: {
                server: payload.serverRef
            }
        },
        nodeId: nodeId
    });

    process.send({
        type: "status",
        data: {
            fill: "green",
            shape: "dot",
            text: "read " + payload.read.length + " write " + payload.write.length
        },
        nodeId: nodeId
    });




}


function upsertEvent(map, event) {
    const key = String(event.nodeID || "").trim();
    if (!key) return;

    map.set(key, event); // sobrescreve automaticamente
}

function matchesServer(serverRef, event) {
    if (!serverRef) {
        return true;
    }

    const normalizedRef = String(serverRef).trim();
    return normalizedRef === String(event.serverId || "").trim()
        || normalizedRef === String(event.serverNodeName || "").trim()
        || normalizedRef === String(event.serverName || "").trim();
}

function normalizeInterval(value) {
    const interval = Number(value);
    if (!Number.isFinite(interval) || interval <= 0) {
        return 500;
    }

    return Math.trunc(interval);
}
module.exports = {
    "eventsServer": eventsServer
}