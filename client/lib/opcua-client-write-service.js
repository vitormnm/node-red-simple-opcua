"use strict";

const { DataType, coerceNodeId } = require("node-opcua");
const {
    buildVariantFromItem,
    dataValueToItemResult,
    normalizeTypeName,
    resolveNodeId,
    statusCodeToString
} = require("../opcua-client-utils");

class OpcUaClientWriteService {
    async execute(node, msg, session, itemsResolver) {
        const items = itemsResolver.ensureWriteItems(node, msg);
        const results = [];

        for (const item of items) {
            const nodeId = resolveNodeId(item);

            try {
                const explicitType = normalizeTypeName(item.type);
                const builtInType = await session.getBuiltInDataType(coerceNodeId(nodeId));
                const typeName = explicitType || DataType[builtInType];
                const variant = buildVariantFromItem(item, typeName);
                const statusCode = await session.writeSingleNode(nodeId, variant);
                const dataValue = await session.readVariableValue(nodeId);
                const result = dataValueToItemResult(item, dataValue);

                if (statusCode && statusCode.name && statusCode.name !== "Good") {
                    result.status = statusCodeToString(statusCode);
                }

                results.push(result);
            } catch (itemError) {
                results.push({
                    name: item.name || nodeId,
                    nodeID: nodeId,
                    value: item.value,
                    type: normalizeTypeName(item.type) || null,
                    status: itemError.message,
                    sourceTimestamp: null,
                    serverTimestamp: null
                });
            }
        }

        return results;
    }
}

module.exports = {
    OpcUaClientWriteService
};
