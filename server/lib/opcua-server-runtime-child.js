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


        } catch (error) {
            this.isRunning = false;
            console.error("Failed to start OPC UA server:", error);

            process.send({
                type: "error",
                data: "Failed to start OPC UA server: " + error.message
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

            let result = {}

            if (Array.isArray(payload)) {
                if (!payload.length) {
                    throw new Error("msg.payload array does not contain any items");
                }

                result = {
                    payload: payload.map((item) => this.readPayloadItem(identifierType, item)),
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
                result = {
                    payload: server.readValue(identifierType, identifier),
                    identifiers: [identifier]
                };

            }


            msg.opcua = msg.opcua || {};
            msg.payload = result.payload;
            this.assignReadMetadata(msg, identifierType, result.identifiers);

            if (result.identifiers.length === 1) {
                msg.topic = result.identifiers[0];
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
                    text: result.identifiers.length > 1 ? "read " + result.identifiers.length + " tags" : "read " + result.identifiers[0]
                },
                nodeId: nodeId
            });

        } catch (error) {

            process.send({
                type: "error",
                data: { fill: "red", shape: "ring", text: "failed read" },
                error: error.message,
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
                nodeId: nodeId
            });
        }



        //return [path];
    }



    writeFromPayload(msg, nodeId) {
        try {
            var writtenPaths = null
            const payload = msg ? msg.payload : undefined;
            const target = msg && msg.opcuaServerIo ? msg.opcuaServerIo : {};
            const identifierType = this.resolveIdentifierType(target);



            if (Array.isArray(payload)) {
                if (!payload.length) {
                    throw new Error("msg.payload array does not contain any items");
                }

                payload.forEach((item) => {
                    this.writePayloadItem(identifierType, item);
                });

                writtenPaths = payload.map((item) => this.resolvePayloadItemIdentifier(item));
            } else if (payload && typeof payload === "object" && !Array.isArray(payload)) {

                const identifiers = Object.keys(payload);
                if (!identifiers.length) {
                    throw new Error("msg.payload object does not contain any " + this.getIdentifierLabel(identifierType));
                }

                identifiers.forEach((identifier) => {
                    this.node.writeValue(identifierType, identifier, payload[identifier]);
                });

                writtenPaths = identifiers;
            } else {

                const identifier = this.resolveIdentifier(target);
                this.node.writeValue(identifierType, identifier, payload);


                writtenPaths = [identifier]
            }

            msg.opcua = msg.opcua || {};
            this.assignWriteMetadata(msg, identifierType, writtenPaths);
            if (writtenPaths.length === 1) {
                msg.topic = writtenPaths[0];
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
                    text: writtenPaths.length > 1 ? "write " + writtenPaths.length + " tags" : "write " + writtenPaths[0]
                },
                nodeId: nodeId
            });


        } catch (error) {

            process.send({
                type: "error",
                data: { fill: "red", shape: "ring", text: "failed write" },
                error: error.message,
                nodeId: nodeId
            });
        }



        //return [path];
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
        return {
            name: item.name,
            path: identifier,
            value: this.node.readValue(identifierType, identifier)
        };
    }

    writePayloadItem(identifierType, item) {
        const identifier = this.resolvePayloadItemIdentifier(item);
        this.node.writeValue(identifierType, identifier, item.value);
        return {
            name: item.name,
            path: identifier,
            value: item.value
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

            await this.ensureReady();

            const nextTree = this.parser.normalizeTreeConfig(payload);

            await this.runtime.updateTree(nextTree);

            const endpointUrl = await this.runtime.getEndpointUrl();


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
            var result = registry.getActiveAlarms(this.node)
            const msg2 = {
                payload: result
            }

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
                    text: result.paths.length > 1 ? "read " + result.paths.length + " tags" : "read " + result.paths[0]
                },
                nodeId: nodeId
            });
        } catch {

        }
    }

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
                OpcUaServerStatusNode(serverProcess.node, msg.msg, msg.nodeId)
                break
            case "eventsServer":
                eventsServer(serverProcess.node, msg.node, msg.nodeId)
                break;
            case "readActiveAlarms":
                serverProcess.readActiveAlarms(msg.msg, msg.nodeId)
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
        nodeId: nodeId
    });
});

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled Rejection:", reason);

    process.send({
        type: "error",
        data: "Unhandled Rejection: " + (reason?.message || reason),
        nodeId: nodeId
    });
});
