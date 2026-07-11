"use strict";

const {
    AttributeIds,
    BrowseDirection,
    DataType,
    NodeClass,
    coerceNodeId,
    makeNodeId,
    VariantArrayType
} = require("node-opcua");

const { enrichItemResultWithEnumeration, reshapeArray } = require("../opcua-client-utils");

async function browseNode(session, root, options = {}) {
    const nodeID = normalizeNodeId(root.nodeID || root.nodeId || ROOT_NODE_ID);
    const result = {
        name: root.name || await readBrowseName(session, nodeID, "RootFolder"),
        nodeID,
        status: "Good",
        children: []
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
        referenceTypeId: makeNodeId(33, 0), // HierarchicalReferences
        browseDirection: BrowseDirection.Forward,
        includeSubtypes: true,
        resultMask: 63
    });

    if (browseResult.statusCode && !browseResult.statusCode.isGood()) {
        throw new Error("Browse failed: " + browseResult.statusCode.toString());
    }

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
    const typeIds = references
        .map(ref => ref.typeDefinition ? normalizeNodeId(ref.typeDefinition) : null)
        .filter(Boolean);
    const uniqueTypeIds = [...new Set(typeIds)];

    const attrsPerItem = options.readValuesRecursive !== false ? 3 : 2;
    const attributesToRead = [
        ...nodeIds.flatMap(nodeId => {
            const list = [
                { nodeId, attributeId: AttributeIds.Description },
                { nodeId, attributeId: AttributeIds.DataType }
            ];
            if (options.readValuesRecursive !== false) {
                list.push({ nodeId, attributeId: AttributeIds.Value });
            }
            return list;
        }),
        ...uniqueTypeIds.map(nodeId => ({ nodeId, attributeId: AttributeIds.BrowseName }))
    ];

    // UMA única chamada para todos os nós e atributos, mas paginada/loteada para evitar BadTooManyOperations
    const BATCH_SIZE = 100;
    const readPromises = [];
    for (let i = 0; i < attributesToRead.length; i += BATCH_SIZE) {
        const batch = attributesToRead.slice(i, i + BATCH_SIZE);
        readPromises.push(session.read(batch));
    }
    const dataValuesChunks = await Promise.all(readPromises);
    const dataValues = [].concat(...dataValuesChunks);

    const typeNamesMap = new Map();
    const typeStartIdx = nodeIds.length * attrsPerItem;
    uniqueTypeIds.forEach((typeId, index) => {
        const browseNameVal = dataValues[typeStartIdx + index]?.value?.value;
        const name = browseNameVal?.name || typeId;
        typeNamesMap.set(typeId, name);
    });

    const cache = new Map();
    // Distribui os resultados por nó (attrsPerItem atributos por nó)
    result.children = await Promise.all(references.map(async (reference, i) => {
        const childNodeId = nodeIds[i];
        const nodeClass = resolveNodeClassName(reference.nodeClass);
        const browseName = extractBrowseName(reference.browseName, childNodeId);
        const displayName = extractDisplayName(reference.displayName, browseName);

        const descValue = dataValues[i * attrsPerItem]?.value?.value;
        const description = typeof descValue === "string"
            ? descValue
            : (descValue?.text ?? "");

        const item = { nodeID: childNodeId, nodeClass, browseName, displayName, description };

        const typeNodeId = reference.typeDefinition ? normalizeNodeId(reference.typeDefinition) : null;
        if (typeNodeId) {
            const typeName = typeNamesMap.get(typeNodeId) || typeNodeId;
            item.typeDefinition = typeNodeId;
            item.hasTypeDefinition = {
                nodeID: typeNodeId,
                browseName: typeName,
                displayName: typeName
            };
        }

        if (nodeClass === "Variable") {
            const dataTypeValue = dataValues[i * attrsPerItem + 1]?.value?.value;
            const rawValueVariant = options.readValuesRecursive !== false
                ? dataValues[i * attrsPerItem + 2]?.value
                : undefined;
            let rawValue = rawValueVariant?.value;

            if (rawValueVariant && rawValueVariant.arrayType === VariantArrayType.Matrix && rawValueVariant.dimensions && (Array.isArray(rawValue) || ArrayBuffer.isView(rawValue))) {
                if (ArrayBuffer.isView(rawValue)) {
                    rawValue = Array.from(rawValue);
                }
                rawValue = reshapeArray(rawValue, rawValueVariant.dimensions);
            }

            item.dataType = dataTypeValue?.namespace === 0 && typeof dataTypeValue?.value === "number"
                ? (DataType[dataTypeValue.value] || dataTypeValue.toString())
                : (dataTypeValue?.toString() ?? "");

            if (rawValueVariant && DataType.Enumeration !== undefined && rawValueVariant.dataType === DataType.Enumeration) {
                item.dataType = "Enumeration";
            }

            item.value = options.readValuesRecursive !== false ? (rawValue ?? "") : null;

            if (options.readValuesRecursive !== false) {
                await enrichItemResultWithEnumeration(item, session, cache, childNodeId);
            }
        }

        if (nodeClass === "Method") {
            const definition = await readMethodArguments(session, childNodeId);
            item.inputArguments = definition.inputArguments;
            item.outputArguments = definition.outputArguments;
        }

        return item;
    }));

    const customDataTypes = result.children
        .filter(item => item.nodeClass === "Variable" && item.dataType && (item.dataType.includes("i=") || item.dataType.includes("ns=")))
        .map(item => item.dataType);
    const uniqueCustomDataTypes = [...new Set(customDataTypes)];

    if (uniqueCustomDataTypes.length > 0) {
        try {
            const dataTypeNamesMap = new Map();
            const isEnumMap = new Map();

            const attributesToReadList = uniqueCustomDataTypes.map(nodeId => ({ nodeId, attributeId: AttributeIds.BrowseName }));
            const BATCH_SIZE = 100;
            const readPromisesList = [];
            for (let i = 0; i < attributesToReadList.length; i += BATCH_SIZE) {
                const batch = attributesToReadList.slice(i, i + BATCH_SIZE);
                readPromisesList.push(session.read(batch));
            }
            const dataValuesChunks = await Promise.all(readPromisesList);
            const dataValuesList = [].concat(...dataValuesChunks);
            uniqueCustomDataTypes.forEach((typeId, index) => {
                const browseNameVal = dataValuesList[index]?.value?.value;
                const name = browseNameVal?.name || typeId;
                dataTypeNamesMap.set(typeId, name);
            });

            await Promise.all(uniqueCustomDataTypes.map(async (typeId) => {
                try {
                    const browseResult = await session.browse({
                        nodeId: typeId,
                        referenceTypeId: "HasProperty",
                        browseDirection: BrowseDirection.Forward,
                        includeSubtypes: true,
                        resultMask: 63
                    });
                    const hasEnumProps = browseResult.references && browseResult.references.some(r => r.browseName.name === "EnumStrings" || r.browseName.name === "EnumValues");
                    if (hasEnumProps) {
                        isEnumMap.set(typeId, true);
                    }
                } catch (e) {
                    // Ignore browse error for this datatype
                }
            }));

            result.children.forEach(item => {
                if (item.nodeClass === "Variable" && dataTypeNamesMap.has(item.dataType)) {
                    if (isEnumMap.get(item.dataType)) {
                        item.dataType = "Enumeration";
                    } else {
                        item.dataType = dataTypeNamesMap.get(item.dataType);
                    }
                }
            });
        } catch (err) {
            // Ignore custom datatype resolution errors
        }
    }

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

async function browseRecursiveNode(session, root, options = {}) {
    const startNodeId = normalizeNodeId(root.nodeID || root.nodeId || ROOT_NODE_ID);
    const rootName = root.name || await readBrowseName(session, startNodeId, "RootFolder");

    const visited = new Set();
    visited.add(startNodeId);

    const allItems = [];

    async function traverse(nodeID) {
        let browseResult;
        try {
            browseResult = await session.browse({
                nodeId: nodeID,
                referenceTypeId: makeNodeId(33, 0), // HierarchicalReferences
                browseDirection: BrowseDirection.Forward,
                includeSubtypes: true,
                resultMask: 63
            });
        } catch (err) {
            if (nodeID === startNodeId) {
                throw err;
            }
            return [];
        }

        if (browseResult.statusCode && !browseResult.statusCode.isGood()) {
            if (nodeID === startNodeId) {
                throw new Error("Browse failed: " + browseResult.statusCode.toString());
            }
            return [];
        }

        let references = [...(browseResult.references || [])];

        while (browseResult.continuationPoint) {
            try {
                browseResult = await session.browseNext(
                    browseResult.continuationPoint,
                    false
                );
                references.push(...(browseResult.references || []));
            } catch (err) {
                break;
            }
        }

        if (!references.length) {
            return [];
        }

        const items = [];
        for (const ref of references) {
            const childNodeId = normalizeNodeId(ref.nodeId);
            const nodeClass = resolveNodeClassName(ref.nodeClass);
            const browseName = extractBrowseName(ref.browseName, childNodeId);
            const displayName = extractDisplayName(ref.displayName, browseName);
            const typeNodeId = ref.typeDefinition ? normalizeNodeId(ref.typeDefinition) : null;

            const item = {
                nodeID: childNodeId,
                nodeClass,
                browseName,
                displayName
            };
            if (typeNodeId) {
                item.typeDefinition = typeNodeId;
            }

            items.push(item);
            allItems.push(item);

            const expandable = nodeClass === "Object" || nodeClass === "Folder" || nodeClass === "View" || nodeClass === "ObjectType";
            if (expandable && !visited.has(childNodeId)) {
                visited.add(childNodeId);
                item.children = await traverse(childNodeId);
            }
        }

        return items;
    }

    const browseResult = await traverse(startNodeId);

    if (allItems.length > 0) {
        const cache = new Map();
        const typeIds = allItems
            .map(item => item.typeDefinition)
            .filter(Boolean);
        const uniqueTypeIds = [...new Set(typeIds)];

        const typeNamesMap = new Map();
        if (uniqueTypeIds.length > 0) {
            try {
                const typeAttributes = uniqueTypeIds.map(nodeId => ({ nodeId, attributeId: AttributeIds.BrowseName }));
                const BATCH_SIZE = 100;
                const readPromises = [];
                for (let i = 0; i < typeAttributes.length; i += BATCH_SIZE) {
                    const batch = typeAttributes.slice(i, i + BATCH_SIZE);
                    readPromises.push(session.read(batch));
                }
                const typeDataValuesChunks = await Promise.all(readPromises);
                const typeDataValues = [].concat(...typeDataValuesChunks);
                uniqueTypeIds.forEach((typeId, index) => {
                    const browseNameVal = typeDataValues[index]?.value?.value;
                    const name = browseNameVal?.name || typeId;
                    typeNamesMap.set(typeId, name);
                });
            } catch (err) {
                // Ignore type names read error, we'll fallback to NodeId below
            }
        }

        const BATCH_SIZE = 100;
        const attrsPerItem = options.readValuesRecursive !== false ? 3 : 2;
        for (let i = 0; i < allItems.length; i += BATCH_SIZE) {
            const chunk = allItems.slice(i, i + BATCH_SIZE);
            const attributesToRead = chunk.flatMap(item => {
                const list = [
                    { nodeId: item.nodeID, attributeId: AttributeIds.Description },
                    { nodeId: item.nodeID, attributeId: AttributeIds.DataType }
                ];
                if (options.readValuesRecursive !== false) {
                    list.push({ nodeId: item.nodeID, attributeId: AttributeIds.Value });
                }
                return list;
            });

            try {
                const dataValues = await session.read(attributesToRead);
                await Promise.all(chunk.map(async (item, index) => {
                    const descValue = dataValues[index * attrsPerItem]?.value?.value;
                    item.description = typeof descValue === "string"
                        ? descValue
                        : (descValue?.text ?? "");

                    if (item.nodeClass === "Variable") {
                        const dataTypeValue = dataValues[index * attrsPerItem + 1]?.value?.value;
                        const rawValueVariant = options.readValuesRecursive !== false
                            ? dataValues[index * attrsPerItem + 2]?.value
                            : undefined;
                        let rawValue = rawValueVariant?.value;

                        if (rawValueVariant && rawValueVariant.arrayType === VariantArrayType.Matrix && rawValueVariant.dimensions && (Array.isArray(rawValue) || ArrayBuffer.isView(rawValue))) {
                            if (ArrayBuffer.isView(rawValue)) {
                                rawValue = Array.from(rawValue);
                            }
                            rawValue = reshapeArray(rawValue, rawValueVariant.dimensions);
                        }

                        item.dataType = dataTypeValue?.namespace === 0 && typeof dataTypeValue?.value === "number"
                            ? (DataType[dataTypeValue.value] || dataTypeValue.toString())
                            : (dataTypeValue?.toString() ?? "");

                        if (rawValueVariant && DataType.Enumeration !== undefined && rawValueVariant.dataType === DataType.Enumeration) {
                            item.dataType = "Enumeration";
                        }

                        item.value = options.readValuesRecursive !== false ? (rawValue ?? "") : null;

                        if (options.readValuesRecursive !== false) {
                            await enrichItemResultWithEnumeration(item, session, cache, item.nodeID);
                        }
                    }

                    if (item.typeDefinition) {
                        const typeName = typeNamesMap.get(item.typeDefinition) || item.typeDefinition;
                        item.hasTypeDefinition = {
                            nodeID: item.typeDefinition,
                            browseName: typeName,
                            displayName: typeName
                        };
                    }
                }));
            } catch (readError) {
                chunk.forEach(item => {
                    item.description = "";
                    if (item.nodeClass === "Variable") {
                        item.dataType = "";
                        item.value = options.readValuesRecursive !== false ? "" : null;
                    }
                    if (item.typeDefinition) {
                        const typeName = typeNamesMap.get(item.typeDefinition) || item.typeDefinition;
                        item.hasTypeDefinition = {
                            nodeID: item.typeDefinition,
                            browseName: typeName,
                            displayName: typeName
                        };
                    }
                });
            }
        }

        const customDataTypes = allItems
            .filter(item => item.nodeClass === "Variable" && item.dataType && (item.dataType.includes("i=") || item.dataType.includes("ns=")))
            .map(item => item.dataType);
        const uniqueCustomDataTypes = [...new Set(customDataTypes)];

        if (uniqueCustomDataTypes.length > 0) {
            try {
                const dataTypeNamesMap = new Map();
                const isEnumMap = new Map();

                const attributesToRead = uniqueCustomDataTypes.map(nodeId => ({ nodeId, attributeId: AttributeIds.BrowseName }));
                const BATCH_SIZE = 100;
                const readPromises = [];
                for (let i = 0; i < attributesToRead.length; i += BATCH_SIZE) {
                    const batch = attributesToRead.slice(i, i + BATCH_SIZE);
                    readPromises.push(session.read(batch));
                }
                const dataValuesChunks = await Promise.all(readPromises);
                const dataValues = [].concat(...dataValuesChunks);
                uniqueCustomDataTypes.forEach((typeId, index) => {
                    const browseNameVal = dataValues[index]?.value?.value;
                    const name = browseNameVal?.name || typeId;
                    dataTypeNamesMap.set(typeId, name);
                });

                await Promise.all(uniqueCustomDataTypes.map(async (typeId) => {
                    try {
                        const browseResult = await session.browse({
                            nodeId: typeId,
                            referenceTypeId: "HasProperty",
                            browseDirection: BrowseDirection.Forward,
                            includeSubtypes: true,
                            resultMask: 63
                        });
                        const hasEnumProps = browseResult.references && browseResult.references.some(r => r.browseName.name === "EnumStrings" || r.browseName.name === "EnumValues");
                        if (hasEnumProps) {
                            isEnumMap.set(typeId, true);
                        }
                    } catch (e) {
                        // Ignore browse error for this datatype
                    }
                }));

                allItems.forEach(item => {
                    if (item.nodeClass === "Variable" && dataTypeNamesMap.has(item.dataType)) {
                        if (isEnumMap.get(item.dataType)) {
                            item.dataType = "Enumeration";
                        } else {
                            item.dataType = dataTypeNamesMap.get(item.dataType);
                        }
                    }
                });
            } catch (err) {
                // Ignore custom datatype resolution errors
            }
        }

        const methods = allItems.filter(item => item.nodeClass === "Method");
        await Promise.all(methods.map(async (method) => {
            const definition = await readMethodArguments(session, method.nodeID);
            method.inputArguments = definition.inputArguments;
            method.outputArguments = definition.outputArguments;
        }));
    }

    return {
        name: rootName,
        nodeID: startNodeId,
        status: "Good",
        children: browseResult
    };
}

const ROOT_NODE_ID = "i=84";

module.exports = {
    browseNode,
    browseRecursiveNode,
    normalizeBrowseRoots,
    normalizeNodeId,
    ROOT_NODE_ID
};

