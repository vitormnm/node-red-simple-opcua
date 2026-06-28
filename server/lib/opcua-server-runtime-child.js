"use strict";



const {
    OPCUAServer,
    UserTokenType,
    buildApplicationUri
} = require("./opcua-constants");

const { OpcUaAddressSpaceBuilder } = require("./opcua-address-space-builder");
const { OpcUaServerRuntime } = require("./opcua-server-runtime");
const { OpcUaServerConfigParser } = require("./opcua-config");
const { resolveRegisteredServer } = require("./server-node-utils");
const { OpcUaServerStatusNode } = require("./opcua-server-status-child")
const { eventsServer } = require("./opcua-server-events-child")
const registry = require("../opcua-server-registry");

/**
 * Classe responsável por gerenciar TODO o ciclo de vida do servidor OPC UA
 */
class OpcUaServerProcess {
    constructor() {
        this.node = {};
        this.runtime = null;
        this.parser = new OpcUaServerConfigParser(this.node);
        this.lifecyclePromise = null;
        this.isRunning = false;
    }

    /**
     * Cria e inicia o servidor
     */
    async create(settings, nodeId) {
        if (this.isRunning) {
            throw new Error("Server already running");
        }

        this.node.id = nodeId;
        this.node.name = settings.name;
        this.node.serverName = settings.serverName;
        this.node.server = null;
        this.node.namespace = null;

        this.runtime = new OpcUaServerRuntime({
            node: this.node,
            registry,
            settings
        });

        this.node.runtime = this.runtime;

        this.node.readValueByPath = (path) => {
            return this.runtime.readValueByPath(path);
        };

        this.node.readValueByNodeId = (nodeId) => {
            return this.runtime.readValueByNodeId(nodeId);
        };

        this.node.readValue = (identifierType, identifier) => {
            return this.runtime.readValue(identifierType, identifier);
        };

        this.node.writeEventByPath = (valuePayload) => {
            return this.runtime.writeEventByPath(valuePayload);
        };

        this.node.writeValueByPath = (path, value) => {
            return this.runtime.writeValueByPath(path, value);
        };

        this.node.writeValueByNodeId = (nodeId, value) => {
            return this.runtime.writeValueByNodeId(nodeId, value);
        };

        this.node.writeValue = (identifierType, identifier, value) => {
            return this.runtime.writeValue(identifierType, identifier, value);
        };

        try {
            this.lifecyclePromise = this.runtime.start();
            await this.lifecyclePromise;

            this.node.server = this.runtime.server;
            this.node.namespace = this.runtime.namespace;

            this.isRunning = true;

            const endpointUrl = this.runtime.getEndpointUrl();

            process.send({
                type: "status",
                data: {
                    fill: "green",
                    shape: "dot",
                    text: endpointUrl
                        ? "running " + endpointUrl
                        : "running"
                },
                nodeId: nodeId
            });

            process.send({
                type: "send",
                data: {
                    payload: {
                        status: "running"
                    },
                    topic : settings.serverName
                },
                nodeId: nodeId
            });


        } catch (error) {
            this.isRunning = false;
            console.error("Failed to start OPC UA server:", error);

            process.send({
                type: "error",
                data: "Failed to start OPC UA server: " + error.message
            });

            process.send({
                type: "send",
                data: {
                    payload: {
                        status: "error"
                    },
                    topic : settings.serverName
                },
                nodeId: nodeId
            });

            process.send({
                type: "status",
                data: {
                    fill: "red",
                    shape: "dot",
                    text: "Failed to start OPC UA server"
                },
                nodeId: nodeId
            });
        }
    }

    /**
     * Para o servidor
     */
    async stop(nodeId) {
        try {
            if (!this.runtime) return;

            if (this.lifecyclePromise) {
                await this.lifecyclePromise.catch(() => { });
                this.lifecyclePromise = null;
            }

            await this.runtime.stop();

            this.node.server = null;
            this.node.namespace = null;
            this.isRunning = false;

            process.send({
                type: "status",
                data: {
                    fill: "red",
                    shape: "ring",
                    text: "stopped"
                },
                nodeId: nodeId
            });


        } catch (error) {
            console.error("Failed to stop OPC UA server:", error);

            process.send({
                type: "error",
                data: "Failed to stop OPC UA server: " + error.message
            });
        }
    }

    readFromPayload(msg, nodeId) {

        try {

            const server = this.node.runtime
            const payload = msg ? msg.payload : undefined;
            const target = msg && msg.opcuaServerIo ? msg.opcuaServerIo : {};
            const identifierType = this.resolveIdentifierType(target);

            let result = {};
            let readArrayResults = null;

            if (Array.isArray(payload)) {
                if (!payload.length) {
                    throw new Error("msg.payload array does not contain any items");
                }

                readArrayResults = payload.map((item) => this.readPayloadItem(identifierType, item));

                result = {
                    payload: readArrayResults,
                    identifiers: payload.map((item) => this.resolvePayloadItemIdentifier(item))
                };
            } else if (payload && typeof payload === "object" && !Array.isArray(payload)) {
                const identifiers = Object.keys(payload);
                if (!identifiers.length) {
                    throw new Error("msg.payload object does not contain any " + this.getIdentifierLabel(identifierType));
                }

                const resultPayload = {};
                identifiers.forEach((identifier) => {
                    try {
                        resultPayload[identifier] = server.readValue(identifierType, identifier);
                    } catch (error) {
                        resultPayload[identifier] = undefined;
                    }
                });

                result = {
                    payload: resultPayload,
                    identifiers: identifiers
                };
            } else {
                const identifier = this.resolveIdentifier(target);
                let directValue = null;
                let directError = null;
                try {
                    directValue = server.readValue(identifierType, identifier);
                } catch (e) {
                    directValue = null;
                    directError = { identifier, message: e.message || String(e) };
                }
                result = {
                    payload: directValue,
                    identifiers: [identifier],
                    directError
                };

            }


            msg.opcua = msg.opcua || {};
            msg.payload = result.payload;
            this.assignReadMetadata(msg, identifierType, result.identifiers);



            if (result.identifiers.length === 1) {
                msg.topic = result.identifiers[0];
            }



            let hasFailures = false;
            if (readArrayResults) {
                const failed = readArrayResults.filter(item => item && item.status !== "Good");
                if (failed.length) {
                    hasFailures = true;
                }
            }
            if (result.directError) {
                hasFailures = true;
            }

            if (!hasFailures) {
                process.send({
                    type: "send",
                    data: msg,
                    nodeId: nodeId
                });
            }

            process.send({
                type: "status",
                data: {
                    fill: hasFailures ? (result.directError ? "red" : "yellow") : "green",
                    shape: "dot",
                    text: hasFailures
                        ? (result.directError ? "read failed" : "partial read failed")
                        : (result.identifiers.length > 1 ? "read " + result.identifiers.length + " tags" : "read " + result.identifiers[0])
                },
                nodeId: nodeId
            });

            // Emit a partialError for items that could not be read (array-of-objects mode only)
            if (readArrayResults) {
                const failed = readArrayResults
                    .filter(item => item && item.status !== "Good")
                    .map(item => ({ name: item.name, path: item.path, status: item.status }));

                if (failed.length) {
                    process.send({
                        type: "partialError",
                        error: "Some tags could not be read: " + failed.map(f => f.path).join(", "),
                        failed: failed,
                        originalMsg: msg,
                        nodeId: nodeId
                    });
                }
            }

            // Emit a partialError for a direct single-tag read failure
            if (result.directError) {
                const { identifier, message } = result.directError;
                process.send({
                    type: "partialError",
                    error: "Some tags could not be read: " + identifier,
                    failed: [{ name: "", path: identifier, status: message }],
                    originalMsg: msg,
                    nodeId: nodeId
                });
            }

        } catch (error) {

            process.send({
                type: "error",
                data: { fill: "red", shape: "ring", text: "failed read" },
                error: error.message,
                originalMsg: msg,
                nodeId: nodeId
            });
        }

    }

    writeEventFromPayload(msg, nodeId) {
        try {
            var writtenPaths = null
            const payload = msg ? msg.payload : undefined;

            writtenPaths = payload

            if (payload && Array.isArray(payload)) {



                payload.forEach((valuePayload) => {
                    this.node.writeEventByPath(valuePayload);
                });


            } else if (payload && typeof payload === "object" && !Array.isArray(payload)) {


                this.node.writeEventByPath(payload);



            }

            process.send({
                type: "send",
                data: msg,
                nodeId: nodeId
            });

            process.send({
                type: "status",
                data: {
                    fill: "green",
                    shape: "dot",
                    text: writtenPaths.length > 1 ? "write " + writtenPaths.length + " events" : "Event " + writtenPaths.nodePath
                },
                nodeId: nodeId
            });


        } catch (error) {

            process.send({
                type: "error",
                data: { fill: "red", shape: "ring", text: "failed write" },
                error: error.message,
                originalMsg: msg,
                nodeId: nodeId
            });
        }



        //return [path];
    }


    writeFromPayload(msg, nodeId) {
        try {
            let writtenPaths = null;
            let payload = msg ? msg.payload : undefined;
            let directError = null;

            const target = msg && msg.opcuaServerIo ? msg.opcuaServerIo : {};
            const identifierType = this.resolveIdentifierType(target);

            let isSingleTag = false;
            try {
                this.resolveIdentifier(target);
                isSingleTag = true;
            } catch (e) {
                // not a single tag
            }

            // Buffer serializado pelo IPC
            if (
                payload &&
                typeof payload === "object" &&
                payload.type === "Buffer" &&
                Array.isArray(payload.data)
            ) {
                payload = Buffer.from(payload.data);
            }

            const dataType =
                target.dataType ||
                target.type ||
                target.builtInType ||
                "";

            const isByteString =
                typeof dataType === "string" &&
                dataType.toLowerCase() === "bytestring";



            // Buffer ou Uint8Array
            if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {

                const identifier = this.resolveIdentifier(target);
                try {
                    this.node.writeValue(
                        identifierType,
                        identifier,
                        Buffer.isBuffer(payload)
                            ? payload
                            : Buffer.from(payload)
                    );
                } catch (e) {
                    directError = { identifier, message: e.message || String(e) };
                    msg.payload = null;
                }

                writtenPaths = [identifier];
            }

            // Array de números
            else if (
                Array.isArray(payload) &&
                payload.every(item => typeof item === "number")
            ) {

                const identifier = this.resolveIdentifier(target);
                try {
                    this.node.writeValue(
                        identifierType,
                        identifier,
                        isByteString
                            ? Buffer.from(payload)
                            : payload
                    );
                } catch (e) {
                    directError = { identifier, message: e.message || String(e) };
                    msg.payload = null;
                }

                writtenPaths = [identifier];
            }

            // Array de objetos
            else if (Array.isArray(payload) && (!isSingleTag || this.isBatchWritePayload(payload))) {

                if (!payload.length) {
                    throw new Error("msg.payload array does not contain any items");
                }

                const writeArrayResults = payload.map(item =>
                    this.writePayloadItem(identifierType, item)
                );

                msg.payload = writeArrayResults;

                writtenPaths = writeArrayResults.map(item => item.path);
            }

            // Objeto { path: value }
            else if (
                payload &&
                typeof payload === "object" &&
                !Array.isArray(payload)
            ) {

                const identifiers = Object.keys(payload);

                if (!identifiers.length) {
                    throw new Error(
                        "msg.payload object does not contain any " +
                        this.getIdentifierLabel(identifierType)
                    );
                }

                identifiers.forEach(identifier => {
                    try {
                        this.node.writeValue(
                            identifierType,
                            identifier,
                            payload[identifier]
                        );
                    } catch (e) {
                        // suppress per-item errors; unknown paths become undefined
                    }
                });

                writtenPaths = identifiers;
            }

            // Valor simples
            else {

                const identifier = this.resolveIdentifier(target);
                try {
                    this.node.writeValue(
                        identifierType,
                        identifier,
                        payload
                    );
                } catch (e) {
                    directError = { identifier, message: e.message || String(e) };
                    msg.payload = null;
                }

                writtenPaths = [identifier];
            }

            msg.opcua = msg.opcua || {};

            this.assignWriteMetadata(
                msg,
                identifierType,
                writtenPaths
            );


            if (writtenPaths.length === 1) {
                msg.topic = writtenPaths[0];
            }

            let hasFailures = false;
            if (Array.isArray(msg.payload) && msg.payload.length && msg.payload[0] && typeof msg.payload[0].status === "string") {
                const failed = msg.payload.filter(item => item.status !== "Good");
                if (failed.length) {
                    hasFailures = true;
                }
            }
            if (directError) {
                hasFailures = true;
            }

            if (!hasFailures) {
                process.send({
                    type: "send",
                    data: msg,
                    nodeId
                });
            }

            process.send({
                type: "status",
                data: {
                    fill: hasFailures ? (directError ? "red" : "yellow") : "green",
                    shape: "dot",
                    text: hasFailures
                        ? (directError ? "write failed" : "partial write failed")
                        : (writtenPaths.length > 1 ? `write ${writtenPaths.length} tags` : `write ${writtenPaths[0]}`)
                },
                nodeId
            });

            // Emit a partialError for items that could not be written (array-of-objects mode only)
            if (Array.isArray(msg.payload) && msg.payload.length && msg.payload[0] && typeof msg.payload[0].status === "string") {
                const failed = msg.payload
                    .filter(item => item.status !== "Good")
                    .map(item => ({ name: item.name, path: item.path, status: item.status }));

                if (failed.length) {
                    process.send({
                        type: "partialError",
                        error: "Some tags could not be written: " + failed.map(f => f.path).join(", "),
                        failed: failed,
                        originalMsg: msg,
                        nodeId
                    });
                }
            }

            // Emit a partialError for a direct single-tag write failure
            if (directError) {
                const { identifier, message } = directError;
                process.send({
                    type: "partialError",
                    error: "Some tags could not be written: " + identifier,
                    failed: [{ name: "", path: identifier, status: message }],
                    originalMsg: msg,
                    nodeId
                });
            }

        } catch (error) {

            process.send({
                type: "error",
                data: {
                    fill: "red",
                    shape: "ring",
                    text: "failed write"
                },
                error: error.message,
                originalMsg: msg,
                nodeId
            });
        }
    }

    isBatchWritePayload(payload) {
        if (!Array.isArray(payload) || payload.length === 0) {
            return false;
        }
        return payload.every(item => 
            item && 
            typeof item === "object" && 
            !Array.isArray(item) && 
            (item.path !== undefined || item.nodeId !== undefined || item.identifier !== undefined)
        );
    }

    resolveIdentifierType(target) {
        return target && target.identifierType === "nodeId" ? "nodeId" : "path";
    }

    resolveIdentifier(target) {
        const identifierType = this.resolveIdentifierType(target);
        if (identifierType === "nodeId") {
            const nodeId = String(target.tagNodeId || "").trim();
            if (!nodeId) {
                throw new Error("No tag nodeId configured");
            }
            return nodeId;
        }

        const path = String(target.tagPath || "").trim();
        if (!path) {
            throw new Error("No tag path configured");
        }

        return path;
    }

    getIdentifierLabel(identifierType) {
        return identifierType === "nodeId" ? "nodeIds" : "tag paths";
    }

    resolvePayloadItemIdentifier(item) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new Error("Each payload item must be an object");
        }

        const identifier = String(item.path || "").trim();
        if (!identifier) {
            throw new Error("Each payload item must contain a path");
        }

        return identifier;
    }

    readPayloadItem(identifierType, item) {
        const identifier = this.resolvePayloadItemIdentifier(item);
        let value = null;
        let status = "Good";
        try {
            value = this.node.readValue(identifierType, identifier);
        } catch (e) {
            value = null;
            status = e.message || String(e);
        }
        return {
            name: item.name,
            path: identifier,
            value,
            status
        };
    }

    writePayloadItem(identifierType, item) {
        const identifier = this.resolvePayloadItemIdentifier(item);
        let writtenValue = null;
        let status = "Good";
        try {
            this.node.writeValue(identifierType, identifier, item.value);
            writtenValue = item.value;
        } catch (e) {
            writtenValue = null;
            status = e.message || String(e);
        }
        return {
            name: item.name,
            path: identifier,
            value: writtenValue,
            status
        };
    }

    assignReadMetadata(msg, identifierType, identifiers) {
        msg.opcua.identifierType = identifierType;
        if (identifierType === "nodeId") {
            msg.opcua.readNodeIds = identifiers;
            delete msg.opcua.readPaths;
            if (identifiers.length === 1) {
                msg.opcua.tagNodeId = identifiers[0];
                delete msg.opcua.tagPath;
            }
            return;
        }

        msg.opcua.readPaths = identifiers;
        delete msg.opcua.readNodeIds;
        if (identifiers.length === 1) {
            msg.opcua.tagPath = identifiers[0];
            delete msg.opcua.tagNodeId;
        }
    }

    assignWriteMetadata(msg, identifierType, identifiers) {
        msg.opcua.identifierType = identifierType;
        if (identifierType === "nodeId") {
            msg.opcua.writtenNodeIds = identifiers;
            delete msg.opcua.writtenPaths;
            if (identifiers.length === 1) {
                msg.opcua.tagNodeId = identifiers[0];
                delete msg.opcua.tagPath;
            }
            return;
        }

        msg.opcua.writtenPaths = identifiers;
        delete msg.opcua.writtenNodeIds;
        if (identifiers.length === 1) {
            msg.opcua.tagPath = identifiers[0];
            delete msg.opcua.tagNodeId;
        }
    }

    /**
     * Atualiza a árvore do servidor
     */
    async update(payload, nodeId) {
        try {


            process.send({
                type: "status",
                data: {
                    fill: "yellow",
                    shape: "dot",
                    text: "updating items"
                },
                nodeId: nodeId
            });

            process.send({
                type: "send",
                data: {
                    payload: {
                        status: "updating"
                    },
                    topic : this.node.serverName
                },
                nodeId: nodeId
            });

            await this.ensureReady();

            const nextTree = this.parser.normalizeTreeConfig(payload);

            await this.runtime.updateTree(nextTree);

            const endpointUrl = await this.runtime.getEndpointUrl();

            process.send({
                type: "send",
                data: {
                    payload: {
                        status: "running"
                    },
                    topic : this.node.serverName
                },
                nodeId: nodeId
            });


            process.send({
                type: "status",
                data: {
                    fill: "green",
                    shape: "dot",
                    text: endpointUrl
                        ? "running " + endpointUrl
                        : "running"
                },
                nodeId: nodeId
            });


        } catch (error) {


            process.send({
                type: "errorUpdateServer",
                data: error.message,
                nodeId: nodeId
            });

            process.send({
                type: "send",
                data: {
                    payload: {
                        status: "error"
                    }
                },
                nodeId: nodeId
            });

            process.send({
                type: "status",
                data: {
                    fill: "red",
                    shape: "dot",
                    text: "error update"
                },
                nodeId: nodeId
            });
        }
    }


    /**
     * metodos opc ua
     */
    registerMethodInput(methodName, nodeId) {

        if (methodName) {

            registry.registerMethodHandler(methodName, nodeId);
        } else {


        }


    }


    handleMethodOutput(msg, nodeId) {

        resolveRegisteredServer(this.node, msg, registry);

        if (!msg._callId) {
            throw new Error("Missing _callId for OPC UA method response");
        }

        registry.resolveMethodCall(msg._callId, msg.payload);


        process.send({
            type: "status",
            data: {
                fill: "green",
                shape: "dot",
                text: "response sent"
            },
            nodeId: nodeId
        });


    }

    /**
     * Garante que o servidor está pronto
     */
    async ensureReady() {
        if (!this.runtime) {
            throw new Error("Server not created");
        }

        if (this.lifecyclePromise) {
            await this.lifecyclePromise;
        }

        this.runtime.ensureReady();
    }


    readActiveAlarms(msg, nodeId) {
        try {
            const result = registry.getActiveAlarms(this.node);
            const safeResult = Array.isArray(result) ? result : [];

            const msg2 = Object.assign({}, msg || {}, {
                payload: safeResult
            });

            process.send({
                type: "send",
                data: msg2,
                nodeId: nodeId
            });

            process.send({
                type: "status",
                data: {
                    fill: "green",
                    shape: "dot",
                    text: safeResult.length + " active alarm" + (safeResult.length !== 1 ? "s" : "")
                },
                nodeId: nodeId
            });
        } catch (error) {
            process.send({
                type: "error",
                data: error.message,
                nodeId: nodeId
            });
        }
    }

    async readActiveSessions(msg, nodeId) {
        try {
            await this.ensureReady();
            const server = this.node && this.node.server;
            if (!server || !server.engine) {
                throw new Error("OPC UA server is not available");
            }

            const rawSessions = server.engine._sessions || {};
            const sessions = Object.values(rawSessions).map((session) => buildSessionSnapshot(session));

            if (msg) {
                const outMsg = Object.assign({}, msg);
                outMsg.payload = sessions;

                process.send({
                    type: "send",
                    data: outMsg,
                    nodeId: nodeId
                });
            }

            process.send({
                type: "status",
                data: {
                    fill: "green",
                    shape: "dot",
                    text: sessions.length === 1
                        ? "1 session"
                        : sessions.length + " sessions"
                },
                nodeId: nodeId
            });
        } catch (error) {
            if (msg) {
                process.send({
                    type: "error",
                    data: { fill: "red", shape: "ring", text: "failed getSessions" },
                    error: error.message,
                    originalMsg: msg,
                    nodeId: nodeId
                });
            } else {
                process.send({
                    type: "status",
                    data: { fill: "red", shape: "ring", text: "failed getSessions: " + error.message },
                    nodeId: nodeId
                });
            }
        }
    }

    async deleteActiveSessions(msg, nodeId) {
        try {
            await this.ensureReady();
            const server = this.node && this.node.server;
            if (!server || !server.engine) {
                throw new Error("OPC UA server is not available");
            }

            const payload = msg && Array.isArray(msg.payload) ? msg.payload : [];
            if (!payload.length) {
                throw new Error("msg.payload must be a non-empty array of { sessionId } objects");
            }

            const engine = server.engine;
            const rawSessions = engine._sessions || {};

            const results = payload.map((item) => {
                const requestedId = String(item && item.sessionId || "").trim();
                if (!requestedId) {
                    return { sessionId: requestedId, status: "error", error: "sessionId is required" };
                }

                // Sessions are keyed by authenticationToken; find by matching nodeId (the GUID sessionId)
                const found = Object.values(rawSessions).find(
                    (s) => safeToString(s.nodeId) === requestedId
                );

                if (!found) {
                    return { sessionId: requestedId, status: "not_found" };
                }

                try {
                    engine.closeSession(found.authenticationToken, true, "Forcing");
                    return { sessionId: requestedId, status: "deleted" };
                } catch (closeError) {
                    return { sessionId: requestedId, status: "error", error: closeError.message };
                }
            });

            const deletedCount = results.filter((r) => r.status === "deleted").length;
            const notFoundCount = results.filter((r) => r.status === "not_found").length;
            const errorCount = results.filter((r) => r.status === "error").length;

            if (msg) {
                const outMsg = Object.assign({}, msg);
                outMsg.payload = results;

                process.send({
                    type: "send",
                    data: outMsg,
                    nodeId: nodeId
                });
            }

            const statusParts = [];
            if (deletedCount) statusParts.push("deleted " + deletedCount);
            if (notFoundCount) statusParts.push("not found " + notFoundCount);
            if (errorCount) statusParts.push("error " + errorCount);

            process.send({
                type: "status",
                data: {
                    fill: errorCount ? "red" : (notFoundCount ? "yellow" : "green"),
                    shape: "dot",
                    text: statusParts.join(", ") || "no sessions"
                },
                nodeId: nodeId
            });
        } catch (error) {
            if (msg) {
                process.send({
                    type: "error",
                    data: { fill: "red", shape: "ring", text: "failed deleteSessions" },
                    error: error.message,
                    originalMsg: msg,
                    nodeId: nodeId
                });
            } else {
                process.send({
                    type: "status",
                    data: { fill: "red", shape: "ring", text: "failed deleteSessions: " + error.message },
                    nodeId: nodeId
                });
            }
        }
    }

    async validateLogin(msg, nodeId) {
        try {
            await this.ensureReady();
            const runtime = this.runtime;
            if (!runtime) {
                throw new Error("OPC UA server is not available");
            }

            const payload = msg && msg.payload ? msg.payload : {};
            const username = typeof payload.userName === "string" ? payload.userName : (typeof payload.username === "string" ? payload.username : "");
            const password = typeof payload.password === "string" ? payload.password : "";

            const normalizedUserName = username.trim();
            const users = Array.isArray(runtime.users) ? runtime.users : [];
            const user = users.find((entry) => entry && entry.username === normalizedUserName);

            let isValid = false;
            if (user) {
                if (user.password && user.password === password) {
                    isValid = true;
                } else if (user.passwordHash) {
                    let bcrypt = null;
                    try {
                        bcrypt = require("bcryptjs");
                    } catch (e) {
                        bcrypt = null;
                    }
                    if (bcrypt) {
                        try {
                            isValid = bcrypt.compareSync(password, user.passwordHash);
                        } catch (err) {
                            // ignore comparison error
                        }
                    }
                }
            }

            let result;
            if (isValid) {
                const groups = typeof user.group === "string"
                    ? user.group.split(",").map(g => g.trim()).filter(Boolean)
                    : Array.isArray(user.group)
                        ? user.group
                        : [];

                result = {
                    status: "Good",
                    username: user.username,
                    group: user.group,
                    groups: groups
                };
            } else {
                result = {
                    status: "erro",
                    message: "Invalid username or password"
                };
            }

            if (msg) {
                const outMsg = Object.assign({}, msg);
                outMsg.payload = result;

                process.send({
                    type: "send",
                    data: outMsg,
                    nodeId: nodeId
                });
            }

            process.send({
                type: "status",
                data: {
                    fill: isValid ? "green" : "yellow",
                    shape: "dot",
                    text: isValid ? "Login: Good" : "Login: erro"
                },
                nodeId: nodeId
            });
        } catch (error) {
            if (msg) {
                const outMsg = Object.assign({}, msg);
                outMsg.payload = {
                    status: "erro",
                    message: error.message
                };
                process.send({
                    type: "send",
                    data: outMsg,
                    nodeId: nodeId
                });
            }
            process.send({
                type: "status",
                data: { fill: "red", shape: "ring", text: "Login error: " + error.message },
                nodeId: nodeId
            });
        }
    }

}

/**
 * Serializes a node-opcua ServerSession into a plain, IPC-safe object.
 */
function buildSessionSnapshot(session) {
    return {
        sessionId: safeToString(session.nodeId),
        sessionName: String(session.sessionName || ""),
        status: String(session.__status || ""),
        creationDate: session.creationDate instanceof Date ? session.creationDate.toISOString() : null,
        sessionTimeout: safeNumber(session.sessionTimeout),
        clientLastContactTime: safeNumber(session.clientLastContactTime),
        channelId: session.channelId != null ? session.channelId : null,
        clientDescription: buildClientDescription(session.clientDescription),
        userIdentityToken: buildUserIdentityToken(session.userIdentityToken),
        channel: buildChannelInfo(session.channel),
        currentSubscriptionCount: safeNumber(session.currentSubscriptionCount),
        cumulatedSubscriptionCount: safeNumber(session.cumulatedSubscriptionCount),
        currentMonitoredItemCount: safeNumber(session.currentMonitoredItemCount),
        aborted: Boolean(session.aborted)
    };
}

function safeToString(value) {
    try {
        return value != null ? String(value) : null;
    } catch (_) {
        return null;
    }
}

function safeNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function buildClientDescription(desc) {
    if (!desc || typeof desc !== "object") {
        return null;
    }
    return {
        applicationUri: safeToString(desc.applicationUri),
        productUri: safeToString(desc.productUri),
        applicationName: desc.applicationName && desc.applicationName.text
            ? String(desc.applicationName.text)
            : safeToString(desc.applicationName),
        applicationType: safeToString(desc.applicationType)
    };
}

function buildUserIdentityToken(token) {
    if (!token || typeof token !== "object") {
        return null;
    }
    return {
        policyId: safeToString(token.policyId),
        userName: safeToString(token.userName),
        // Never expose passwords or raw credential bytes
        tokenType: safeToString(token.schema && token.schema.name)
    };
}

function buildChannelInfo(channel) {
    if (!channel || typeof channel !== "object") {
        return null;
    }
    return {
        channelId: channel.channelId != null ? channel.channelId : null,
        remoteAddress: safeToString(channel.remoteAddress),
        remotePort: safeNumber(channel.remotePort),
        bytesRead: safeNumber(channel.bytesRead),
        bytesWritten: safeNumber(channel.bytesWritten),
        transactionsCount: safeNumber(channel.transactionsCount),
        securityMode: safeToString(channel.securityMode),
        securityPolicy: safeToString(channel.securityPolicy)
    };
}

/**
 * Instância única do processo
 */
const serverProcess = new OpcUaServerProcess();

/**
 * Comunicação com processo pai (Node-RED)
 */
process.on("message", async (msg) => {
    try {
        switch (msg.type) {
            case "createServer":
                await serverProcess.create(msg.settings, msg.nodeId);
                break;

            case "stopServer":

                await serverProcess.stop(msg.nodeId);
                break;

            case "updateServer":
                await serverProcess.update(msg.msg.payload, msg.nodeId);
                break;

            case "writeTagServer":

                serverProcess.writeFromPayload(msg.msg, msg.nodeId)
                break;

            case "writeEventServer":

                serverProcess.writeEventFromPayload(msg.msg, msg.nodeId)
                break;



            case "readTagServer":

                serverProcess.readFromPayload(msg.msg, msg.nodeId)
                break;

            case "registerMethodInput":
                serverProcess.registerMethodInput(msg.node.methodName, msg.nodeId)
                break;

            case "handleMethodOutput":
                serverProcess.handleMethodOutput(msg.msg, msg.nodeId)
                break;

            case "buildServerSnapshot":
                try {
                    await serverProcess.ensureReady();
                    OpcUaServerStatusNode(serverProcess.node, msg.msg, msg.nodeId);
                } catch (error) {
                    process.send({
                        type: "status",
                        data: {
                            fill: msg.msg ? "red" : "yellow",
                            shape: "ring",
                            text: msg.msg ? "Status: " + error.message : "waiting for server"
                        },
                        nodeId: msg.nodeId
                    });
                }
                break;
            case "eventsServer":
                eventsServer(serverProcess.node, msg.node, msg.nodeId)
                break;
            case "readActiveAlarms":
                serverProcess.readActiveAlarms(msg.msg, msg.nodeId)
                break;
            case "readActiveSessions":
                await serverProcess.readActiveSessions(msg.msg, msg.nodeId);
                break;
            case "deleteActiveSessions":
                await serverProcess.deleteActiveSessions(msg.msg, msg.nodeId);
                break;
            case "validateLogin":
                await serverProcess.validateLogin(msg.msg, msg.nodeId);
                break;



            default:
                console.warn("Unknown message type2:", msg.type);
        }
    } catch (error) {
        console.error("Process message error:", error);

        process.send({
            type: "error",
            data: error.message
        });
    }
});

/**
 * Segurança: captura erros não tratados
 */
process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception:", err);

    process.send({
        type: "error",
        data: "Uncaught Exception: " + err.message,
        nodeId: serverProcess.node.id
    });
});

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled Rejection:", reason);

    process.send({
        type: "error",
        data: "Unhandled Rejection: " + (reason?.message || reason),
        nodeId: serverProcess.node.id
    });
});

if (require.main !== module) {
    module.exports = { OpcUaServerProcess };
}