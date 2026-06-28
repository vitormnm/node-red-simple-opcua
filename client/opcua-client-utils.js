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

        case "Int64": {
            const minVal = -9223372036854775808n;
            const maxVal = 9223372036854775807n;
            let bigintVal;
            if (Array.isArray(value) && value.length === 2) {
                const h = BigInt(value[0]);
                const l = BigInt(value[1]);
                const signMask = 1n << 31n;
                const shiftHigh = 1n << 32n;
                if ((h & signMask) === signMask) {
                    bigintVal = (h & ~signMask) * shiftHigh + l - 0x8000000000000000n;
                } else {
                    bigintVal = h * shiftHigh + l;
                }
            } else {
                try {
                    bigintVal = BigInt(value);
                } catch (e) {
                    const parsed = Number(value);
                    if (Number.isFinite(parsed)) {
                        bigintVal = BigInt(Math.trunc(parsed));
                    } else {
                        bigintVal = 0n;
                    }
                }
            }
            if (bigintVal < minVal) bigintVal = minVal;
            else if (bigintVal > maxVal) bigintVal = maxVal;

            const mask = 0xFFFFFFFFFFFFFFFFn;
            const unsignedVal = bigintVal & mask;
            const high = Number(unsignedVal >> 32n);
            const low = Number(unsignedVal & 0xFFFFFFFFn);
            return [high, low];
        }
        case "UInt64": {
            const minVal = 0n;
            const maxVal = 18446744073709551615n;
            let bigintVal;
            if (Array.isArray(value) && value.length === 2) {
                const h = BigInt(value[0]);
                const l = BigInt(value[1]);
                const shiftHigh = 1n << 32n;
                bigintVal = h * shiftHigh + l;
            } else {
                try {
                    bigintVal = BigInt(value);
                } catch (e) {
                    const parsed = Number(value);
                    if (Number.isFinite(parsed)) {
                        bigintVal = BigInt(Math.trunc(parsed));
                    } else {
                        bigintVal = 0n;
                    }
                }
            }
            if (bigintVal < minVal) bigintVal = minVal;
            else if (bigintVal > maxVal) bigintVal = maxVal;

            const high = Number(bigintVal >> 32n);
            const low = Number(bigintVal & 0xFFFFFFFFn);
            return [high, low];
        }

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

function getArrayDimensions(value, typeName) {
    if (!Array.isArray(value)) {
        return null;
    }
    // Check if it is a 64-bit scalar represented as [high, low]
    if ((typeName === "Int64" || typeName === "UInt64") && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number") {
        return null;
    }

    const hasNestedArray = value.some(item => {
        if (Array.isArray(item)) {
            if ((typeName === "Int64" || typeName === "UInt64") && item.length === 2 && typeof item[0] === "number" && typeof item[1] === "number") {
                return false;
            }
            return true;
        }
        return false;
    });

    if (!hasNestedArray) {
        return null;
    }

    const dimensions = [];
    let current = value;
    while (Array.isArray(current)) {
        if ((typeName === "Int64" || typeName === "UInt64") && current.length === 2 && typeof current[0] === "number" && typeof current[1] === "number") {
            break;
        }
        dimensions.push(current.length);
        if (current.length === 0) {
            break;
        }
        current = current[0];
    }
    return dimensions;
}

function flattenMatrix(value, typeName) {
    if (!Array.isArray(value)) {
        return value;
    }
    if ((typeName === "Int64" || typeName === "UInt64") && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number") {
        return [value];
    }

    const flat = [];
    const recurse = (a) => {
        for (const item of a) {
            if (Array.isArray(item)) {
                if ((typeName === "Int64" || typeName === "UInt64") && item.length === 2 && typeof item[0] === "number" && typeof item[1] === "number") {
                    flat.push(item);
                } else {
                    recurse(item);
                }
            } else {
                flat.push(item);
            }
        }
    };
    recurse(value);
    return flat;
}

function buildVariantFromItem(item, fallbackTypeName) {
    const typeName = normalizeTypeName(item.type || fallbackTypeName || inferTypeName(item.value));
    const dataType = DataType[typeName];

    if (dataType === undefined) {
        throw new Error("Unsupported OPC UA data type: " + typeName);
    }

    const dimensions = getArrayDimensions(item.value, typeName);
    if (dimensions) {
        // Multi-dimensional array (Matrix)
        const flatVal = flattenMatrix(item.value, typeName);
        const coercedArray = coerceValue(flatVal, typeName);
        const TypedArrayCtor = TYPED_ARRAY_MAP[dataType];

        return new Variant({
            dataType,
            arrayType: VariantArrayType.Matrix,
            dimensions,
            value: TypedArrayCtor
                ? TypedArrayCtor.from(coercedArray)
                : coercedArray
        });
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

function decode64BitValue(value, isUnsigned) {
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number") {
        const h = BigInt(value[0]);
        const l = BigInt(value[1]);
        const shiftHigh = 1n << 32n;
        let bigintVal;
        if (!isUnsigned) {
            const signMask = 1n << 31n;
            if ((h & signMask) === signMask) {
                bigintVal = (h & ~signMask) * shiftHigh + l - 0x8000000000000000n;
            } else {
                bigintVal = h * shiftHigh + l;
            }
        } else {
            bigintVal = h * shiftHigh + l;
        }

        const num = Number(bigintVal);
        return num;
    }
    return value;
}

function resolve64BitValue(value, isUnsigned) {
    if (Array.isArray(value)) {
        if (value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number") {
            return decode64BitValue(value, isUnsigned);
        }
        return value.map((val) => resolve64BitValue(val, isUnsigned));
    }
    return value;
}

function reshapeArray(flatArray, dimensions) {
    if (!dimensions || dimensions.length <= 1) {
        return flatArray;
    }

    const reshape = (arr, dims, offset) => {
        const size = dims[0];
        if (dims.length === 1) {
            return {
                result: arr.slice(offset, offset + size),
                nextOffset: offset + size
            };
        }

        const result = [];
        let currentOffset = offset;
        for (let i = 0; i < size; i++) {
            const step = reshape(arr, dims.slice(1), currentOffset);
            result.push(step.result);
            currentOffset = step.nextOffset;
        }
        return {
            result: result,
            nextOffset: currentOffset
        };
    };

    return reshape(flatArray, dimensions, 0).result;
}

function dataValueToItemResult(item, dataValue) {
    const variant = dataValue && dataValue.value ? dataValue.value : null;
    let val = variant ? variant.value : null;
    if (variant && (variant.dataType === DataType.Int64 || variant.dataType === DataType.UInt64)) {
        val = resolve64BitValue(val, variant.dataType === DataType.UInt64);
    }
    if (variant && variant.arrayType === VariantArrayType.Matrix && variant.dimensions && (Array.isArray(val) || ArrayBuffer.isView(val))) {
        if (ArrayBuffer.isView(val)) {
            val = Array.from(val);
        }
        val = reshapeArray(val, variant.dimensions);
    }
    return {
        name: resolveName(item, resolveNodeId(item)),
        nodeID: resolveNodeId(item),
        value: val,
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
        time: eventFields[9]?.value ?? null,
        conditionId: eventFields[10]?.value?.toString() ?? null
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
        outputs: outputArguments.map((variant, index) => {
            let val = variant ? variant.value : null;
            if (variant && (variant.dataType === DataType.Int64 || variant.dataType === DataType.UInt64)) {
                val = resolve64BitValue(val, variant.dataType === DataType.UInt64);
            }
            if (variant && variant.arrayType === VariantArrayType.Matrix && variant.dimensions && (Array.isArray(val) || ArrayBuffer.isView(val))) {
                if (ArrayBuffer.isView(val)) {
                    val = Array.from(val);
                }
                val = reshapeArray(val, variant.dimensions);
            }
            return {
                name: outputDefinitions[index] && outputDefinitions[index].name
                    ? String(outputDefinitions[index].name)
                    : "output" + (index + 1),
                type: variantTypeToName(variant),
                value: val
            };
        })
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

const PRIMITIVE_TYPES = new Set([
    "Null", "Boolean", "SByte", "Byte", "Int16", "UInt16", "Int32", "UInt32", "Int64", "UInt64",
    "Float", "Double", "String", "DateTime", "Guid", "ByteString", "XmlElement",
    "NodeId", "ExpandedNodeId", "StatusCode", "QualifiedName", "LocalizedText"
]);

async function enrichItemResultWithEnumeration(result, session, cache, nodeId) {
    const type = result.type || result.dataType;
    if (!type) {
        return result;
    }

    if (result.dataType && PRIMITIVE_TYPES.has(result.dataType)) {
        return result;
    }

    const isStandardEnum = type === "Int32" || type === "Enumeration";
    const isCustomNodeId = typeof type === "string" && (type.includes("i=") || type.includes("ns="));

    if (!isStandardEnum && !isCustomNodeId) {
        return result;
    }
    
    if (typeof result.value !== "number" || !Number.isInteger(result.value)) {
        return result;
    }

    try {
        const cacheKeyType = "dt:" + nodeId;
        let dtNodeIdPromise = cache ? cache.get(cacheKeyType) : undefined;
        
        if (dtNodeIdPromise === undefined) {
            dtNodeIdPromise = (async () => {
                const isNodeIdLike = result.dataType && (
                    typeof result.dataType !== "string" || 
                    result.dataType.includes("i=") || 
                    result.dataType.includes("ns=")
                );
                if (isNodeIdLike) {
                    try {
                        return coerceNodeId(result.dataType);
                    } catch (e) {
                        return null;
                    }
                }
                const dv = await session.read({
                    nodeId: nodeId,
                    attributeId: AttributeIds.DataType
                });
                return dv.statusCode.isGood() ? dv.value.value : null;
            })();
            if (cache) cache.set(cacheKeyType, dtNodeIdPromise);
        }
        
        const dtNodeId = await dtNodeIdPromise;
        if (!dtNodeId) return result;
        
        const cacheKeyStrings = "enumStrings:" + dtNodeId.toString();
        let enumStringsPromise = cache ? cache.get(cacheKeyStrings) : undefined;
        
        if (enumStringsPromise === undefined) {
            enumStringsPromise = (async () => {
                const browseResult = await session.browse({
                    nodeId: dtNodeId,
                    referenceTypeId: "HasProperty",
                    browseDirection: BrowseDirection.Forward,
                    includeSubtypes: true,
                    resultMask: 63
                });
                
                const enumStringsRef = browseResult.references ? browseResult.references.find(r => r.browseName.name === "EnumStrings") : null;
                const enumValuesRef = browseResult.references ? browseResult.references.find(r => r.browseName.name === "EnumValues") : null;

                if (enumStringsRef) {
                    const dataValue = await session.read({
                        nodeId: enumStringsRef.nodeId,
                        attributeId: AttributeIds.Value
                    });
                    if (dataValue.statusCode.isGood() && dataValue.value.value) {
                        return dataValue.value.value.map(lt => lt.text);
                    }
                } else if (enumValuesRef) {
                    const dataValue = await session.read({
                        nodeId: enumValuesRef.nodeId,
                        attributeId: AttributeIds.Value
                    });
                    if (dataValue.statusCode.isGood() && dataValue.value.value) {
                        const map = {};
                        dataValue.value.value.forEach(ev => {
                            let val;
                            if (Array.isArray(ev.value) && ev.value.length === 2) {
                                val = ev.value[1]; // low part of Int64
                            } else {
                                val = Number(ev.value);
                            }
                            map[val] = ev.displayName.text;
                        });
                        return map;
                    }
                }
                return null;
            })();
            if (cache) cache.set(cacheKeyStrings, enumStringsPromise);
        }
        
        const enumStrings = await enumStringsPromise;
        if (enumStrings && enumStrings[result.value] !== undefined) {
            result.valueEnumeration = enumStrings[result.value];
            if (result.type) result.type = "Enumeration";
            if (result.dataType) result.dataType = "Enumeration";
        }
    } catch (e) {
        console.error("Error in enrichItemResultWithEnumeration:", e);
    }
    
    return result;
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
    enrichItemResultWithEnumeration,
    ensureArrayPayload,
    getMethodArgumentDefinition,
    inferTypeName,
    normalizeTypeName,
    resolveMethodObjectId,
    resolveName,
    resolveNodeId,
    resolveSecurityMode,
    resolveSecurityPolicy,
    reshapeArray,
    statusCodeToString
};