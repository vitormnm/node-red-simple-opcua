"use strict";

const {
    AttributeIds,
    BrowseDirection,
    DataType,
    NodeClass,
    coerceNodeId,
    makeNodeId
} = require("node-opcua");

async function browseNode(session, root) {
    const nodeID = normalizeNodeId(root.nodeID || root.nodeId || ROOT_NODE_ID);
    const result = {
        name: root.name || await readBrowseName(session, nodeID, "RootFolder"),
        nodeID,
        browse: []
    };



    // const browseResult = await session.browse({
    //     nodeId: nodeID,
    //     browseDirection: BrowseDirection.Forward,
    //     includeSubtypes: true,
    //     resultMask: 63
    // });

    // const references = browseResult?.references ?? [];

    let browseResult = await session.browse({
        nodeId: nodeID,
        browseDirection: BrowseDirection.Forward,
        includeSubtypes: true,
        resultMask: 63
    });

    let references = [
        ...(browseResult.references || [])
    ];

    while (browseResult.continuationPoint) {

        browseResult = await session.browseNext(
            browseResult.continuationPoint,
            false
        );

        references.push(
            ...(browseResult.references || [])
        );
    }

    if (!references.length) {
        return result;
    }
    //end new browse tia portal


    if (!references.length) return result;

    // Monta lista de todos os atributos de todos os nós de uma vez
    const nodeIds = references.map(ref => normalizeNodeId(ref.nodeId));


    const attributesToRead = nodeIds.flatMap(nodeId => [
        { nodeId, attributeId: AttributeIds.Description },
        { nodeId, attributeId: AttributeIds.DataType },
        { nodeId, attributeId: AttributeIds.Value },
    ]);

    // UMA única chamada para todos os nós e atributos
    const dataValues = await session.read(attributesToRead);

    // Distribui os resultados por nó (3 atributos por nó)
    result.browse = await Promise.all(references.map(async (reference, i) => {
        const childNodeId = nodeIds[i];
        const nodeClass = resolveNodeClassName(reference.nodeClass);
        const browseName = extractBrowseName(reference.browseName, childNodeId);
        const displayName = extractDisplayName(reference.displayName, browseName);

        const descValue = dataValues[i * 3]?.value?.value;
        const description = typeof descValue === "string"
            ? descValue
            : (descValue?.text ?? "");

        const item = { nodeID: childNodeId, nodeClass, browseName, displayName, description };

        if (nodeClass === "Variable") {
            const dataTypeValue = dataValues[i * 3 + 1]?.value?.value;
            const rawValue = dataValues[i * 3 + 2]?.value?.value;

            item.dataType = dataTypeValue?.namespace === 0 && typeof dataTypeValue?.value === "number"
                ? (DataType[dataTypeValue.value] || dataTypeValue.toString())
                : (dataTypeValue?.toString() ?? "");

            item.value = rawValue ?? "";
        }

        if (nodeClass === "Method") {
            const definition = await readMethodArguments(session, childNodeId);
            item.inputArguments = definition.inputArguments;
            item.outputArguments = definition.outputArguments;
        }

        return item;
    }));

    return result;
}
function normalizeBrowseRoots(payload) {
    if (payload === undefined || payload === null) {
        return [{ name: "RootFolder", nodeID: ROOT_NODE_ID }];
    }

    if (!Array.isArray(payload)) {
        throw new Error("OPC UA browse expects msg.payload as an array");
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
            nodeID: normalizeNodeId(item.nodeID || item.nodeId)
        };
    });
}

async function mapReference(session, reference) {
    const childNodeId = normalizeNodeId(reference.nodeId);
    const nodeClass = resolveNodeClassName(reference.nodeClass);
    const browseName = extractBrowseName(reference.browseName, childNodeId);
    const item = {
        nodeID: childNodeId,
        nodeClass,
        browseName,
        displayName: extractDisplayName(reference.displayName, browseName),
        description: await readDescription(session, childNodeId)
    };

    const hasTypeDefinition = await readHasTypeDefinition(session, childNodeId);
    if (hasTypeDefinition) {
        item.hasTypeDefinition = hasTypeDefinition;
    }

    if (nodeClass === "Variable") {
        item.value = await readValue(session, childNodeId);
        item.dataType = await readDataType(session, childNodeId);
        return item;
    }

    if (nodeClass === "Method") {
        const definition = await readMethodArguments(session, childNodeId);
        item.inputArguments = definition.inputArguments;
        item.outputArguments = definition.outputArguments;
        return item;
    }

    return item;
}

async function readHasTypeDefinition(session, nodeId) {
    try {
        const browseResult = await session.browse({
            nodeId,
            browseDirection: BrowseDirection.Forward,
            referenceTypeId: makeNodeId(40, 0), // HasTypeDefinition
            includeSubtypes: false,
            resultMask: 63
        });
        const references = browseResult && Array.isArray(browseResult.references)
            ? browseResult.references
            : [];
        if (!references.length) {
            return null;
        }

        const reference = references[0];
        const typeNodeId = normalizeNodeId(reference.nodeId);
        return {
            nodeID: typeNodeId,
            browseName: extractBrowseName(reference.browseName, typeNodeId),
            displayName: extractDisplayName(reference.displayName, typeNodeId)
        };
    } catch (error) {
        return null;
    }
}

async function readBrowseName(session, nodeId, fallback) {
    try {
        const dataValue = await session.read({
            nodeId,
            attributeId: AttributeIds.BrowseName
        });
        const value = dataValue && dataValue.value ? dataValue.value.value : null;
        if (value && value.name) {
            return String(value.name);
        }
    } catch (error) {
        // Use fallback below.
    }

    return String(fallback || nodeId);
}

async function readDescription(session, nodeId) {
    try {
        const dataValue = await session.read({
            nodeId,
            attributeId: AttributeIds.Description
        });
        const value = dataValue && dataValue.value ? dataValue.value.value : null;

        if (typeof value === "string") {
            return value;
        }

        if (value && typeof value.text === "string") {
            return value.text;
        }
    } catch (error) {
        // Return empty description when unavailable.
    }

    return "";
}

async function readValue(session, nodeId) {
    try {
        const dataValue = await session.read({
            nodeId,
            attributeId: AttributeIds.Value
        });

        if (!dataValue || !dataValue.value) {
            return "";
        }

        const value = dataValue.value.value;
        return value === undefined || value === null ? "" : value;
    } catch (error) {
        return "";
    }
}

async function readDataType(session, nodeId) {
    try {
        const dataValue = await session.read({
            nodeId,
            attributeId: AttributeIds.DataType
        });

        const value = dataValue && dataValue.value ? dataValue.value.value : null;
        if (!value) {
            return "";
        }

        if (value.namespace === 0 && typeof value.value === "number") {
            return DataType[value.value] || value.toString();
        }

        return value.toString();
    } catch (error) {
        return "";
    }
}

async function readMethodArguments(session, nodeId) {
    try {
        const definition = await session.getArgumentDefinition(nodeId);
        return {
            inputArguments: normalizeMethodArguments(definition && definition.inputArguments),
            outputArguments: normalizeMethodArguments(definition && definition.outputArguments)
        };
    } catch (error) {
        return {
            inputArguments: [],
            outputArguments: []
        };
    }
}

function normalizeNodeId(nodeId) {


    return coerceNodeId(nodeId).toString();
}



function resolveNodeClassName(nodeClass) {
    if (!nodeClass && nodeClass !== 0) {
        return "";
    }

    if (typeof nodeClass === "object" && typeof nodeClass.key === "string") {
        return nodeClass.key;
    }

    if (typeof nodeClass === "string") {
        return nodeClass;
    }

    return NodeClass[nodeClass] || String(nodeClass);
}

function extractBrowseName(browseName, fallback) {
    if (browseName && typeof browseName.name === "string" && browseName.name) {
        return browseName.name;
    }

    return String(fallback || "");
}

function extractDisplayName(displayName, fallback) {
    if (displayName && typeof displayName.text === "string" && displayName.text) {
        return displayName.text;
    }

    if (typeof displayName === "string" && displayName) {
        return displayName;
    }

    return String(fallback || "");
}

function normalizeMethodArguments(argumentsList) {
    if (!Array.isArray(argumentsList)) {
        return [];
    }

    return argumentsList.map((argument, index) => ({
        name: argument && argument.name ? String(argument.name) : "arg" + (index + 1),
        dataType: resolveArgumentDataType(argument && argument.dataType),
        description: argument && argument.description && typeof argument.description.text === "string"
            ? argument.description.text
            : ""
    }));
}

function resolveArgumentDataType(dataType) {
    if (!dataType) {
        return "";
    }

    if (dataType.namespace === 0 && typeof dataType.value === "number") {
        return DataType[dataType.value] || dataType.toString();
    }

    return dataType.toString();
}

const ROOT_NODE_ID = "i=84";

module.exports = {
    browseNode,
    normalizeBrowseRoots,
    normalizeNodeId,
    ROOT_NODE_ID
};
