"use strict";

const { dataValueToItemResult, resolveNodeId } = require("../opcua-client-utils");

class OpcUaClientReadService {
    async execute(node, msg, session, itemsResolver) {
        const items = itemsResolver.ensureClientItems(node, msg, "OPC UA read");
        const nodeIds = items.map((item) => resolveNodeId(item));
        const values = await session.readVariableValue(nodeIds);
        return values.map((dataValue, index) => dataValueToItemResult(items[index], dataValue));
    }
}

module.exports = {
    OpcUaClientReadService
};
