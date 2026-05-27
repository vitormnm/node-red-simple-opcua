"use strict";

const { coerceNodeId } = require("node-opcua");

const {
    buildVariantFromItem,
    callResultToItemResult,
    ensureArrayPayload,
    getMethodArgumentDefinition,
    normalizeTypeName,
    resolveName,
    resolveMethodObjectId,
    resolveNodeId
} = require("./opcua-client-utils");

const {
    browseNode: browseNodeWithSession,
    ROOT_NODE_ID
} = require("./lib/opcua-client-browser");

const { OpcUaClientReadService } = require("./lib/opcua-client-read-service");
const { OpcUaClientWriteService } = require("./lib/opcua-client-write-service");
const { OpcUaClientSubscriptionService } = require("./lib/opcua-client-subscription-service");
const { OpcUaClientSubscriptionIdService } = require("./lib/opcua-client-subscription-id-service");

module.exports = function (RED) {
    function OpcUaClientNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.name = (config.name || "").trim();
        node.connection = RED.nodes.getNode(config.connection);
        node.mode = config.mode || "read";
        node.selectedItems = parseConfiguredItems(config.selectedItems);
        node.valueProperty = (config.valueProperty || "payload").trim();
        node.valuePropertyType = config.valuePropertyType || "msg";
        node.samplingInterval = Math.max(Number(config.samplingInterval) || 250, 50);
        node.publishingInterval = Math.max(Number(config.publishingInterval) || 250, 50);
        node.subscription = null;
        node.monitoredItems = [];

        const itemsResolver = createItemsResolver(RED);
        const readService = new OpcUaClientReadService();
        const writeService = new OpcUaClientWriteService();
        const subscriptionService = new OpcUaClientSubscriptionService();
        const subscriptionIdService = new OpcUaClientSubscriptionIdService();

        node.on("input", async function (msg, send, done) {
            send = send || function () {
                node.send.apply(node, arguments);
            };

            try {
                if (!node.connection) {
                    throw new Error("No OPC UA client configuration selected");
                }

                if (node.mode === "subscription") {
                    const subscriptionItems = await subscriptionService.startDataSubscription(node, msg, itemsResolver);
                    node.status({ fill: "green", shape: "dot", text: "subscribed " + subscriptionItems.length + " nodes" });
                    done();
                    return;
                }

                if (node.mode === "events") {
                    const eventsItems = await subscriptionService.startEventSubscription(node, msg, itemsResolver);
                    node.status({ fill: "green", shape: "dot", text: "events " + eventsItems.length + " nodes" });
                    done();
                    return;
                }

                const session = await node.connection.getSession();
                let payload;

                if (node.mode === "read") {
                    payload = await readService.execute(node, msg, session, itemsResolver);
                    node.status({ fill: "green", shape: "dot", text: "read " + payload.length + " nodes" });
                } else if (node.mode === "write") {
                    payload = await writeService.execute(node, msg, session, itemsResolver);
                    node.status({ fill: "green", shape: "dot", text: "write " + payload.length + " nodes" });
                } else if (node.mode === "browse") {
                    payload = await executeBrowse(node, msg, session);
                    node.status({ fill: "green", shape: "dot", text: "browsed " + payload.length + " nodes" });
                } else if (node.mode === "method") {
                    payload = await executeMethod(node, msg, session);
                    node.status({ fill: "green", shape: "dot", text: "called " + payload.length + " methods" });
                } else if (node.mode === "getSubscriptionId") {
                    payload = await subscriptionIdService.execute(node);
                    node.status({ fill: "green", shape: "dot", text: "called getSubscriptionId" });
                } else {
                    throw new Error("Unsupported OPC UA client mode: " + node.mode);
                }

                msg.payload = payload;
                send(msg);
                done();
            } catch (error) {
                node.status({ fill: "red", shape: "ring", text: node.mode + " failed" });
                done(error);
            }
        });

        node.on("close", async function (done) {
            try {
                await subscriptionService.stop(node);
                done();
            } catch (error) {
                done(error);
            }
        });
    }

    async function executeBrowse(node, msg, session) {
        const roots = normalizeBrowseRoots(node, msg ? msg.payload : undefined);
        const payload = [];

        for (const root of roots) {
            payload.push(await browseNodeWithSession(session, root));
        }

        return payload;
    }

    async function executeMethod(node, msg, session) {
        const items = ensureArrayPayload(msg, "OPC UA method call");
        const payload = [];

        for (const item of items) {
            const methodNodeId = resolveMethodId(item);

            try {
                const objectId = resolveMethodObjectIdFromItem(item) || await resolveMethodObjectId(
                    session,
                    methodNodeId,
                    node.connection.methodObjectIdCache
                );
                const argumentDefinition = await safeGetMethodArgumentDefinition(
                    session,
                    methodNodeId,
                    node.connection.methodDefinitionCache
                );
                const callRequest = {
                    objectId,
                    methodId: methodNodeId
                };

                if (Array.isArray(item.inputs) && item.inputs.length > 0) {
                    callRequest.inputArguments = item.inputs.map((input) => buildVariantFromItem(input, input.type));
                }

                const callResult = await session.call(callRequest);
                payload.push(callResultToItemResult(item, callResult, argumentDefinition));
            } catch (itemError) {
                payload.push({
                    name: item.name || methodNodeId,
                    nodeID: methodNodeId,
                    status: itemError.message,
                    outputs: []
                });
            }
        }

        return payload;
    }

    async function safeGetMethodArgumentDefinition(session, methodNodeId, cache) {
        try {
            return await getMethodArgumentDefinition(session, methodNodeId, cache);
        } catch (error) {
            return {
                inputArguments: [],
                outputArguments: []
            };
        }
    }

    function createItemsResolver(REDRuntime) {
        return {
            ensureClientItems,
            ensureWriteItems
        };

        function ensureClientItems(node, msg, contextName) {
            const payload = msg ? msg.payload : undefined;

            if (Array.isArray(payload) && payload.length > 0) {
                return payload;
            }

            if (node.selectedItems.length > 0) {
                return node.selectedItems;
            }

            return ensureArrayPayload(msg, contextName);
        }

        function ensureWriteItems(node, msg) {
            const payload = msg ? msg.payload : undefined;

            if (Array.isArray(payload) && payload.length > 0) {
                return payload;
            }

            if (node.selectedItems.length > 0) {
                const configuredValue = resolveConfiguredWriteValue(node, msg, REDRuntime);
                return node.selectedItems.map((item, index) => ({
                    name: item.name,
                    nodeID: item.nodeID,
                    type: item.type,
                    value: resolveWriteValueForItem(node, msg, item, index, configuredValue, REDRuntime)
                }));
            }

            return ensureArrayPayload(msg, "OPC UA write");
        }
    }

    function normalizeBrowseRoots(node, payload) {
        if (payload === undefined || payload === null) {
            if (node.selectedItems.length > 0) {
                return node.selectedItems.map((item) => ({
                    name: item.name,
                    nodeID: normalizeBrowseNodeId(item.nodeID)
                }));
            }
            return [{ name: "RootFolder", nodeID: ROOT_NODE_ID }];
        }

        if (!Array.isArray(payload)) {
            return node.selectedItems;
        }

        if (!payload.length) {
            return [{ name: "RootFolder", nodeID: ROOT_NODE_ID }];
        }

        return payload.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                throw new Error("Each browse item must be an object");
            }

            return {
                name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "",
                nodeID: normalizeBrowseNodeId(item.nodeID || item.nodeId)
            };
        });
    }

    function normalizeBrowseNodeId(nodeId) {
        return coerceNodeId(nodeId).toString();
    }

    function resolveMethodObjectIdFromItem(item) {
        const objectId = item && (item.objectID || item.objectId);
        if (!objectId || !String(objectId).trim()) {
            return "";
        }

        return String(objectId).trim();
    }

    function resolveMethodId(item) {
        const methodId = item && (item.methodID || item.methodId || item.nodeID || item.nodeId);
        if (!methodId || !String(methodId).trim()) {
            throw new Error("Each method item must contain methodId or nodeID");
        }

        return String(methodId).trim();
    }

    function parseConfiguredItems(rawValue) {
        if (!rawValue || typeof rawValue !== "string") {
            return [];
        }

        try {
            const parsed = JSON.parse(rawValue);
            if (!Array.isArray(parsed)) {
                return [];
            }

            return parsed
                .filter((item) => item && typeof item === "object" && !Array.isArray(item))
                .map((item) => ({
                    name: typeof item.name === "string" && item.name.trim()
                        ? item.name.trim()
                        : resolveName(item, item.nodeID || item.nodeId || ""),
                    nodeID: resolveNodeId(item),
                    type: normalizeTypeName(item.type) || normalizeTypeName(item.dataType) || undefined,
                    valueProperty: typeof item.valueProperty === "string" && item.valueProperty.trim()
                        ? item.valueProperty.trim()
                        : "payload",
                    valuePropertyType: item.valuePropertyType === "flow" || item.valuePropertyType === "global"
                        ? item.valuePropertyType
                        : "msg"
                }));
        } catch (error) {
            return [];
        }
    }

    function resolveWriteValueForItem(node, msg, item, index, fallbackConfiguredValue, REDRuntime) {
        const property = item && typeof item.valueProperty === "string" && item.valueProperty.trim()
            ? item.valueProperty.trim()
            : (node.valueProperty || "payload");
        const type = item && (item.valuePropertyType === "msg" || item.valuePropertyType === "flow" || item.valuePropertyType === "global")
            ? item.valuePropertyType
            : (node.valuePropertyType || "msg");

        let value;
        if (type === "msg") {
            value = REDRuntime.util.getMessageProperty(msg, property);
        } else if (type === "flow") {
            value = node.context().flow.get(property);
        } else if (type === "global") {
            value = node.context().global.get(property);
        } else {
            value = REDRuntime.util.getMessageProperty(msg, property);
        }

        if (typeof value !== "undefined") {
            return value;
        }

        return selectWriteValueForItem(fallbackConfiguredValue, item, index);
    }

    function resolveConfiguredWriteValue(node, msg, REDRuntime) {
        const property = node.valueProperty || "payload";
        const type = node.valuePropertyType || "msg";

        if (type === "msg") {
            return REDRuntime.util.getMessageProperty(msg, property);
        }

        if (type === "flow") {
            return node.context().flow.get(property);
        }

        if (type === "global") {
            return node.context().global.get(property);
        }

        return REDRuntime.util.getMessageProperty(msg, property);
    }

    function selectWriteValueForItem(configuredValue, item, index) {
        if (Array.isArray(configuredValue)) {
            const byName = item && item.name ? configuredValue.find((entry) => entry && entry.name === item.name) : undefined;
            if (byName && Object.prototype.hasOwnProperty.call(byName, "value")) {
                return byName.value;
            }

            const byNodeId = item && item.nodeID ? configuredValue.find((entry) => entry && (entry.nodeID === item.nodeID || entry.nodeId === item.nodeID)) : undefined;
            if (byNodeId && Object.prototype.hasOwnProperty.call(byNodeId, "value")) {
                return byNodeId.value;
            }

            return configuredValue[index];
        }

        if (configuredValue && typeof configuredValue === "object") {
            if (Object.prototype.hasOwnProperty.call(configuredValue, "value")) {
                return configuredValue.value;
            }

            if (item && item.nodeID && Object.prototype.hasOwnProperty.call(configuredValue, item.nodeID)) {
                return configuredValue[item.nodeID];
            }

            if (item && item.name && Object.prototype.hasOwnProperty.call(configuredValue, item.name)) {
                return configuredValue[item.name];
            }
        }

        return configuredValue;
    }

    RED.nodes.registerType("opcua-client", OpcUaClientNode);
};
