"use strict";

const { dataValueToItemResult, resolveNodeId, enrichItemResultWithEnumeration } = require("../opcua-client-utils");

class OpcUaClientReadService {
    async execute(node, msg, session, itemsResolver) {
        const items = itemsResolver.ensureClientItems(node, msg, "OPC UA read");
        const nodeIds = items.map((item) => resolveNodeId(item));
        const values = await session.readVariableValue(nodeIds);
        
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
