"use strict";

const { TimestampsToReturn } = require("node-opcua");
const {
    dataValueToItemResult,
    resolveNodeId,
    resolveName,
    statusCodeToString,
    enrichItemResultWithEnumeration
} = require("../opcua-client-utils");

class OpcUaClientHistoryService {
    constructor(RED) {
        this.RED = RED;
    }

    async execute(node, msg, session) {
        // Resolve nodes to read history from msg.payload
        let items = [];
        const payload = msg ? msg.payload : undefined;

        if (Array.isArray(payload) && payload.length > 0) {
            items = payload;
        } else if (payload && typeof payload === "object") {
            if (Array.isArray(payload.items) && payload.items.length > 0) {
                items = payload.items;
            } else if (payload.nodeID || payload.nodeId) {
                items = [payload];
            }
        }

        // Fall back to configured selectedItems
        if (items.length === 0 && node.selectedItems && node.selectedItems.length > 0) {
            items = node.selectedItems;
        }

        if (items.length === 0) {
            throw new Error("OPC UA read history expects msg.payload or configured items to specify nodes to read");
        }

        // Parse time limits and query options
        const nodeStartTime = this.RED.util.evaluateNodeProperty(node.historyStartTime, node.historyStartTimeType, node, msg);
        const fallbackStartTime = (nodeStartTime !== undefined && nodeStartTime !== null)
            ? new Date(nodeStartTime)
            : (msg.startTime ? new Date(msg.startTime) : (payload && payload.startTime ? new Date(payload.startTime) : new Date(Date.now() - 60 * 60 * 1000)));

        const nodeEndTime = this.RED.util.evaluateNodeProperty(node.historyEndTime, node.historyEndTimeType, node, msg);
        const fallbackEndTime = (nodeEndTime !== undefined && nodeEndTime !== null)
            ? new Date(nodeEndTime)
            : (msg.endTime ? new Date(msg.endTime) : (payload && payload.endTime ? new Date(payload.endTime) : new Date()));

        let numValuesPerNode = msg.numValuesPerNode !== undefined ? Number(msg.numValuesPerNode) : (payload && payload.numValuesPerNode !== undefined ? Number(payload.numValuesPerNode) : undefined);
        let returnBounds = msg.returnBounds !== undefined ? Boolean(msg.returnBounds) : (payload && payload.returnBounds !== undefined ? Boolean(payload.returnBounds) : undefined);
        let isReadModified = msg.isReadModified !== undefined ? Boolean(msg.isReadModified) : (payload && payload.isReadModified !== undefined ? Boolean(payload.isReadModified) : undefined);

        const options = {
            timestampsToReturn: TimestampsToReturn.Both
        };
        if (numValuesPerNode !== undefined) options.numValuesPerNode = numValuesPerNode;
        if (returnBounds !== undefined) options.returnBounds = returnBounds;
        if (isReadModified !== undefined) options.isReadModified = isReadModified;

        // Group items by unique resolved startTime and endTime
        const groups = new Map();

        items.forEach((item, index) => {
            let itemStart = item.startTime ? new Date(item.startTime) : fallbackStartTime;
            let itemEnd = item.endTime ? new Date(item.endTime) : fallbackEndTime;

            // Fallback to defaults on invalid date parsing
            if (Number.isNaN(itemStart.getTime())) itemStart = fallbackStartTime;
            if (Number.isNaN(itemEnd.getTime())) itemEnd = fallbackEndTime;

            const key = itemStart.getTime() + "_" + itemEnd.getTime();
            if (!groups.has(key)) {
                groups.set(key, {
                    startTime: itemStart,
                    endTime: itemEnd,
                    members: [] // Array of { item, originalIndex }
                });
            }
            groups.get(key).members.push({ item, originalIndex: index });
        });

        // Execute batch queries for each group
        const results = new Array(items.length);
        const cache = new Map();

        for (const [key, group] of groups.entries()) {
            const nodesToRead = group.members.map(member => {
                const readOptions = {
                    nodeId: resolveNodeId(member.item)
                };
                const continuationPointStr = member.item.continuationPoint || (payload && payload.continuationPoint);
                if (continuationPointStr && typeof continuationPointStr === "string") {
                    readOptions.continuationPoint = Buffer.from(continuationPointStr, "base64");
                }
                return readOptions;
            });

            // Request history values from server for the group
            const resultsArray = await session.readHistoryValue(nodesToRead, group.startTime, group.endTime, options);

            for (let i = 0; i < resultsArray.length; i++) {
                const historyReadResult = resultsArray[i];
                const member = group.members[i];
                const item = member.item;
                const nodeId = resolveNodeId(item);

                const status = statusCodeToString(historyReadResult.statusCode);
                const historyValues = [];

                if (historyReadResult.statusCode.isGood() && historyReadResult.historyData && historyReadResult.historyData.dataValues) {
                    const dataValues = historyReadResult.historyData.dataValues;
                    for (const dv of dataValues) {
                        let mapped = dataValueToItemResult(item, dv);
                        mapped = await enrichItemResultWithEnumeration(mapped, session, cache, nodeId);

                        historyValues.push({
                            value: mapped.value,
                            valueEnumeration: mapped.valueEnumeration,
                            type: mapped.type,
                            status: mapped.status,
                            sourceTimestamp: mapped.sourceTimestamp,
                            serverTimestamp: mapped.serverTimestamp
                        });
                    }
                }

                // Restore original order in final output payload
                results[member.originalIndex] = {
                    name: resolveName(item, nodeId),
                    nodeID: nodeId,
                    status: status,
                    continuationPoint: historyReadResult.continuationPoint ? historyReadResult.continuationPoint.toString("base64") : null,
                    history: historyValues
                };
            }
        }

        return results;
    }
}

module.exports = {
    OpcUaClientHistoryService
};
