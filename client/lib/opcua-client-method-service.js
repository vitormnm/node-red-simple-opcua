"use strict";

const { dataValueToItemResult, ensureArrayPayload, resolveNodeId, resolveMethodObjectId, buildVariantFromItem, callResultToItemResult } = require("../opcua-client-utils");

class OpcUaClientMethodService {
    async execute(node, msg, session, itemsResolver) {

        // const items = ensureArrayPayload(msg, "OPC UA method call");
        const items = itemsResolver.ensureMethodItems(node, msg, "OPC UA method");
        const payload = [];



        for (const item of items) {
            const methodNodeId = this.resolveMethodId(item);

            try {
                const objectId = this.resolveMethodObjectIdFromItem(item) || await resolveMethodObjectId(
                    session,
                    methodNodeId,
                    node.connection.methodObjectIdCache
                );
                const argumentDefinition = await this.safeGetMethodArgumentDefinition(
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



    resolveMethodId(item) {
        const methodId = item && (item.methodID || item.methodId || item.nodeID || item.nodeId);
        if (!methodId || !String(methodId).trim()) {
            throw new Error("Each method item must contain methodId or nodeID");
        }

        return String(methodId).trim();
    }


    resolveMethodObjectIdFromItem(item) {
        const objectId = item && (item.objectID || item.objectId);
        if (!objectId || !String(objectId).trim()) {
            return "";
        }

        return String(objectId).trim();
    }

    async safeGetMethodArgumentDefinition(session, methodNodeId, cache) {
        try {
            return await getMethodArgumentDefinition(session, methodNodeId, cache);
        } catch (error) {
            return {
                inputArguments: [],
                outputArguments: []
            };
        }
    }

}

module.exports = {
    OpcUaClientMethodService
};
