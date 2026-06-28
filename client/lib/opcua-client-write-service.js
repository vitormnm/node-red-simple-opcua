"use strict";

const { AttributeIds, DataType, coerceNodeId, VariantArrayType } = require("node-opcua");
const {
    buildVariantFromItem,
    normalizeTypeName,
    resolveNodeId,
    statusCodeToString,
    reshapeArray
} = require("../opcua-client-utils");

// Máximo de tags por chamada session.write (ajuste conforme limite do servidor)
const WRITE_BATCH_SIZE = 100;

// Batches em paralelo simultâneos
const CONCURRENCY = 5;

// Cede o event loop a cada N itens para não travar o Node-RED
const YIELD_EVERY = 50;

class OpcUaClientWriteService {
    async execute(node, msg, session, itemsResolver) {
        const items = itemsResolver.ensureWriteItems(node, msg);
    
        // 1. Resolve variantes (tipo + valor) — consulta servidor só para quem não tem tipo explícito
        const variants = await resolveVariants(session, items);

        // 2. Escreve todos os nós em batches paralelos
        const statusCodes = await writeBatches(session, items, variants);

        // 3. Monta resultados — statusCode Good já confirma a escrita, sem round-trip extra
        return buildResults(items, variants, statusCodes);
    }
}

// ─── Resolução de tipos ──────────────────────────────────────────────────────

async function resolveVariants(session, items) {
    // Separa quais itens precisam consultar o tipo no servidor
    const needsLookup = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => !normalizeTypeName(item.type));

    // Busca tipos desconhecidos em paralelo
    const resolvedTypes = new Map();

    await mapConcurrent(needsLookup, CONCURRENCY * 2, async ({ item, index }) => {
        try {
            const builtInType = await session.getBuiltInDataType(coerceNodeId(resolveNodeId(item)));
            resolvedTypes.set(index, DataType[builtInType]);
        } catch {
            resolvedTypes.set(index, "String");
        }
    });

    return items.map((item, index) => {
        const typeName = normalizeTypeName(item.type) || resolvedTypes.get(index) || "String";
        return buildVariantFromItem(item, typeName);
    });
}

// ─── Escrita em batches paralelos ────────────────────────────────────────────

async function writeBatches(session, items, variants) {
    const allStatusCodes = new Array(items.length);

    // Divide em batches de WRITE_BATCH_SIZE
    const batches = [];
    for (let i = 0; i < items.length; i += WRITE_BATCH_SIZE) {
        batches.push({ start: i, end: Math.min(i + WRITE_BATCH_SIZE, items.length) });
    }

    let processed = 0;

    await mapConcurrent(batches, CONCURRENCY, async ({ start, end }) => {
        const nodesToWrite = items.slice(start, end).map((item, i) => ({
            nodeId: coerceNodeId(resolveNodeId(item)),
            attributeId: AttributeIds.Value,
            value: { value: variants[start + i] }
        }));

        try {
            const statusCodes = await session.write(nodesToWrite);
            statusCodes.forEach((sc, i) => {
                allStatusCodes[start + i] = sc;
            });
        } catch (batchError) {
            
            for (let i = start; i < end; i++) {
                allStatusCodes[i] = { name: batchError.message, value: -1 };
            }
        }

        // Cede o event loop a cada YIELD_EVERY itens para não travar o Node-RED
        processed += end - start;
        if (processed % YIELD_EVERY === 0) {
            await yieldEventLoop();
        }
    });

    return allStatusCodes;
}

// ─── Montagem dos resultados ─────────────────────────────────────────────────

function buildResults(items, variants, statusCodes) {
    return items.map((item, index) => {
        const nodeId = resolveNodeId(item);
        const sc = statusCodes[index];
        const scName = sc && sc.name ? sc.name : "Good";
        const typeName = DataType[variants[index].dataType] || null;

        let val = variants[index].value;
        const variant = variants[index];
        if (variant && variant.arrayType === VariantArrayType.Matrix && variant.dimensions && (Array.isArray(val) || ArrayBuffer.isView(val))) {
            if (ArrayBuffer.isView(val)) {
                val = Array.from(val);
            }
            val = reshapeArray(val, variant.dimensions);
        }

        return {
            name: item.name || nodeId,
            nodeID: nodeId,
            value: val,
            type: typeName,
            status: scName,
            sourceTimestamp: null,
            serverTimestamp: null
        };
    });
}

// ─── Utilitários ─────────────────────────────────────────────────────────────

async function mapConcurrent(items, concurrency, fn) {
    let index = 0;

    async function worker() {
        while (index < items.length) {
            const i = index++;
            await fn(items[i], i);
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, worker)
    );
}

function yieldEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

module.exports = {
    OpcUaClientWriteService
};