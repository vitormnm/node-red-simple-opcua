"use strict";

const {
    AttributeIds,
    BrowseDirection,
    coerceNodeId,
    VariantArrayType,
    DataType,
    MessageSecurityMode,
    NodeClass,
    OPCUAClient,
    SecurityPolicy,
    TimestampsToReturn,
    Variant
} = require("node-opcua");

// Mapa DataType → TypedArray nativo para escrita eficiente no servidor OPC UA
const TYPED_ARRAY_MAP = {
    [DataType.SByte]: Int8Array,
    [DataType.Byte]: Uint8Array,
    [DataType.Int16]: Int16Array,
    [DataType.UInt16]: Uint16Array,
    [DataType.Int32]: Int32Array,
    [DataType.UInt32]: Uint32Array,
    [DataType.Float]: Float32Array,
    [DataType.Double]: Float64Array,
};

function resolveSecurityPolicy(name) {
    return SecurityPolicy[name] || SecurityPolicy.None;
}

function resolveSecurityMode(name) {
    return MessageSecurityMode[name] || MessageSecurityMode.None;
}

function normalizeTypeName(type) {
    const raw = String(type || "").trim();
    if (!raw) {
        return "";
    }

    const aliases = {
        Bool: "Boolean",
        Boolean: "Boolean",
        Byte: "Byte",
        SByte: "SByte",
        Int: "Int32",
        Int16: "Int16",
        Int32: "Int32",
        Int64: "Int64",
        UInt16: "UInt16",
        UInt32: "UInt32",
        UInt64: "UInt64",
        Float: "Float",
        Double: "Double",
        String: "String",
        DateTime: "DateTime"
    };

    return aliases[raw] || raw;
}

function inferTypeName(value) {
    if (typeof value === "boolean") {
        return "Boolean";
    }
    if (typeof value === "string") {
        return "String";
    }
    if (typeof value === "number") {
        return Number.isInteger(value) ? "Int32" : "Double";
    }
    if (value instanceof Date) {
        return "DateTime";
    }
    if (Buffer.isBuffer(value) || (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data))) {
        return "ByteString";
    }
    return "String";
}

function coerceValue(value, typeName) {

    if (Array.isArray(value)) {
        return value.map(element => coerceValue(element, typeName));
    }


    switch (typeName) {
        case "Boolean":
            if (typeof value === "string") {
                return value.trim().toLowerCase() === "true";
            }
            return Boolean(value);

        case "Byte":
        case "SByte":
        case "Int16":
        case "Int32":
        case "UInt16":
        case "UInt32":
            return Number.parseInt(value, 10);

        case "Int64":
        case "UInt64":
            return BigInt(value);

        case "Float":
        case "Double":
            return Number.parseFloat(value);

        case "ByteString":
            if (value && typeof value === "object" && value.type === "Buffer" && Array.isArray(value.data)) {
                return Buffer.from(value.data);
            }

            if (Buffer.isBuffer(value)) {
                return value;
            }

            if (value instanceof Uint8Array) {
                return Buffer.from(value);
            }

            if (Array.isArray(value)) {
                return Buffer.from(value);
            }

            if (typeof value === "string") {
                return Buffer.from(value, "base64");
            }

            return Buffer.alloc(0);

        case "DateTime":
            return value instanceof Date ? value : new Date(value);

        case "String":
            return value === undefined || value === null ? "" : String(value);

        default:
            return value;
    }
}

function buildVariantFromItem(item, fallbackTypeName) {
    const typeName = normalizeTypeName(item.type || fallbackTypeName || inferTypeName(item.value));
    const dataType = DataType[typeName];

    if (dataType === undefined) {
        throw new Error("Unsupported OPC UA data type: " + typeName);
    }

    const isArray = Array.isArray(item.value);

    if (isArray) {
        // Coerce cada elemento e converte para TypedArray se disponível
        const coercedArray = coerceValue(item.value, typeName); // retorna JS Array
        const TypedArrayCtor = TYPED_ARRAY_MAP[dataType];

        return new Variant({
            dataType,
            arrayType: VariantArrayType.Array,
            value: TypedArrayCtor
                ? TypedArrayCtor.from(coercedArray)  // Int32Array, Float32Array, etc.
                : coercedArray                        // String[], Boolean[], DateTime[]
        });
    }

    // Escalar — comportamento original preservado
    return new Variant({
        dataType,
        arrayType: VariantArrayType.Scalar,
        value: coerceValue(item.value, typeName)
    });
}

function ensureArrayPayload(msg, contextName) {
    const payload = msg ? msg.payload : undefined;

    if (!Array.isArray(payload) || payload.length === 0) {
        throw new Error(contextName + " expects msg.payload as a non-empty array");
    }

    return payload;
}

function resolveNodeId(item) {
    const nodeId = item && (item.nodeID || item.nodeId);
    if (!nodeId || !String(nodeId).trim()) {
        throw new Error("Each item must contain nodeID");
    }
    return String(nodeId).trim();
}

function resolveName(item, fallback) {
    return String(item && item.name ? item.name : fallback || "").trim();
}

function statusCodeToString(statusCode) {
    if (!statusCode) {
        return "Unknown";
    }
    return statusCode.name || statusCode.toString();
}

function timestampToIso(value) {
    return value instanceof Date && !Number.isNaN(value.getTime())
        ? value.toISOString()
        : null;
}

function variantTypeToName(variant) {
    if (!variant || variant.dataType === undefined || variant.dataType === null) {
        return null;
    }
    return DataType[variant.dataType] || String(variant.dataType);
}

function dataValueToItemResult(item, dataValue) {
    const variant = dataValue && dataValue.value ? dataValue.value : null;
    return {
        name: resolveName(item, resolveNodeId(item)),
        nodeID: resolveNodeId(item),
        value: variant ? variant.value : null,
        type: variantTypeToName(variant),
        status: statusCodeToString(dataValue && dataValue.statusCode),
        sourceTimestamp: timestampToIso(dataValue && dataValue.sourceTimestamp),
        serverTimestamp: timestampToIso(dataValue && dataValue.serverTimestamp)
    };
}

async function dataValueToItemResultEvent(item, eventFields, session) {
    const variant = eventFields && eventFields.value ? eventFields.value : null;

    // lê BrowseName do tipo
    const dv = await session.read({
        nodeId: eventFields[1].value,
        attributeId: AttributeIds.BrowseName
    });

    const eventTypeName = dv.value.value.name;

    

    return {
        eventId: eventFields[0]?.value ?? null,
        eventType: eventFields[1]?.value ?? null,
        sourceNode: eventFields[2]?.value?.toString() ?? null,
        sourceName: eventFields[3]?.value ?? null,
        message: eventFields[4]?.value?.text ?? null,
        severity: eventFields[5]?.value ?? null,
        active: eventFields[6]?.value?.text ?? null, // Active / Inactive
        AckedState: eventFields[7]?.value?.text ?? null, // Active / Inactive
        ConfirmedState: eventFields[8]?.value?.text ?? null,  // Active / Inactive
        time: eventFields[9]?.value ?? null
    };
}

function callResultToItemResult(item, callResult, argumentDefinition) {
    const methodId = resolveMethodNodeId(item);
    const outputDefinitions = argumentDefinition && Array.isArray(argumentDefinition.outputArguments)
        ? argumentDefinition.outputArguments
        : [];
    const outputArguments = Array.isArray(callResult.outputArguments)
        ? callResult.outputArguments
        : [];

    return {
        name: resolveName(item, methodId),
        nodeID: methodId,
        status: statusCodeToString(callResult.statusCode),
        outputs: outputArguments.map((variant, index) => ({
            name: outputDefinitions[index] && outputDefinitions[index].name
                ? String(outputDefinitions[index].name)
                : "output" + (index + 1),
            type: variantTypeToName(variant),
            value: variant ? variant.value : null
        }))
    };
}

function resolveMethodNodeId(item) {
    const methodId = item && (item.methodID || item.methodId || item.nodeID || item.nodeId);
    if (!methodId || !String(methodId).trim()) {
        throw new Error("Each method item must contain methodId or nodeID");
    }

    return String(methodId).trim();
}

async function resolveMethodObjectId(session, methodNodeId, cache) {
    const cacheKey = String(methodNodeId);
    if (cache && cache.has(cacheKey)) {
        return cache.get(cacheKey);
    }

    const browseResult = await session.browse({
        nodeId: methodNodeId,
        browseDirection: BrowseDirection.Inverse,
        includeSubtypes: true,
        resultMask: 63
    });

    const references = browseResult && Array.isArray(browseResult.references)
        ? browseResult.references
        : [];

    const objectReferences = references.filter((reference) => {
        const nodeClassName = resolveNodeClassName(reference.nodeClass);
        return nodeClassName === "Object" || nodeClassName === "ObjectType";
    });

    const parentReference = objectReferences.find((reference) => isComponentReference(reference.referenceTypeId))
        || objectReferences[0]
        || references[0];

    if (!parentReference) {
        throw new Error("Unable to resolve parent object for method " + methodNodeId);
    }

    const objectId = parentReference.nodeId.toString();
    if (cache) {
        cache.set(cacheKey, objectId);
    }
    return objectId;
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

function isComponentReference(referenceTypeId) {
    const value = referenceTypeId && typeof referenceTypeId.toString === "function"
        ? referenceTypeId.toString()
        : String(referenceTypeId || "");

    return value === "i=47" || value === "i=49";
}

async function getMethodArgumentDefinition(session, methodNodeId, cache) {
    const cacheKey = String(methodNodeId);
    if (cache && cache.has(cacheKey)) {
        return cache.get(cacheKey);
    }

    const definition = await session.getArgumentDefinition(methodNodeId);
    if (cache) {
        cache.set(cacheKey, definition);
    }
    return definition;
}

module.exports = {
    AttributeIds,
    coerceNodeId,
    DataType,
    OPCUAClient,
    TimestampsToReturn,
    buildVariantFromItem,
    callResultToItemResult,
    dataValueToItemResult,
    dataValueToItemResultEvent,
    ensureArrayPayload,
    getMethodArgumentDefinition,
    inferTypeName,
    normalizeTypeName,
    resolveMethodObjectId,
    resolveName,
    resolveNodeId,
    resolveSecurityMode,
    resolveSecurityPolicy,
    statusCodeToString
};