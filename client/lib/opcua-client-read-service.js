"use strict";

const { AttributeIds } = require("node-opcua");
const { dataValueToItemResult, resolveNodeId, enrichItemResultWithEnumeration } = require("../opcua-client-utils");

const READ_BATCH_SIZE = 100;

class OpcUaClientReadService {
    async execute(node, msg, session, itemsResolver) {
        const items = itemsResolver.ensureClientItems(node, msg, "OPC UA read");
        const nodeIds = items.map((item) => resolveNodeId(item));

        const nodesToRead = nodeIds.map((nodeId) => ({
            nodeId,
            attributeId: AttributeIds.Value
        }));

        let values = [];
        if (nodesToRead.length <= READ_BATCH_SIZE) {
            const res = await session.read(nodesToRead);
            values = Array.isArray(res) ? res : [res];
        } else {
            for (let i = 0; i < nodesToRead.length; i += READ_BATCH_SIZE) {
                const batch = nodesToRead.slice(i, i + READ_BATCH_SIZE);
                const res = await session.read(batch);
                values = values.concat(Array.isArray(res) ? res : [res]);
            }
        }
        
        const cache = new Map();
        const results = [];
        
        for (let index = 0; index < values.length; index++) {
            const dataValue = values[index];
            const item = items[index];
            let result = dataValueToItemResult(item, dataValue);
            result = await enrichItemResultWithEnumeration(result, session, cache, nodeIds[index]);
            results.push(result);
        }
        
        return results;
    }
}

module.exports = {
    OpcUaClientReadService
};
