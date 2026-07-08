"use strict";

const path = require("path");
const { OPCUACertificateManager, UserTokenType } = require("node-opcua");

const {
    OPCUAClient,
    getMethodArgumentDefinition,
    resolveMethodObjectId,
    resolveSecurityMode,
    resolveSecurityPolicy,
    AttributeIds,
    dataValueToItemResult,
    enrichItemResultWithEnumeration
} = require("./opcua-client-utils");

const {
    browseNode,
    ROOT_NODE_ID
} = require("./lib/opcua-client-browser");



module.exports = function (RED) {
    function OpcUaClientConfigNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        

        node.name = (config.name || "").trim();
        node.sessionName = (config.sessionName || "ClientSession1").trim();
        node.endpoint = (config.endpoint || "").trim();
        node.securityPolicy = config.securityPolicy || "None";
        node.securityMode = config.securityMode || "None";
        node.authType = config.authType || "anonymous";
        node.initialDelay = config.initialDelay !== undefined ? Number(config.initialDelay) : 1000;
        node.maxDelay = config.maxDelay !== undefined ? Number(config.maxDelay) : 10000;
        node.maxRetry = (config.maxRetry !== undefined && Number(config.maxRetry) !== 10) ? Number(config.maxRetry) : -1;
        node.requestedSessionTimeout = config.requestedSessionTimeout !== undefined ? Number(config.requestedSessionTimeout) : 300000;
        node.defaultTransactionTimeout = (config.defaultTransactionTimeout !== undefined && config.defaultTransactionTimeout !== "") ? Number(config.defaultTransactionTimeout) : 15000;
        node.keepSessionAlive = config.keepSessionAlive !== false;
        node.autoReconnect = config.autoReconnect !== false;
        node.endpointMustExist = config.endpointMustExist === true;
        node.logErrors = config.logErrors === true;
        node.emitErrorOnConnectionLoss = config.emitErrorOnConnectionLoss !== false;
        node.client = null;
        node.session = null;
        node.connectPromise = null;
        node.methodObjectIdCache = new Map();
        node.methodDefinitionCache = new Map();

        node.on("close", function (done) {
            node.closing = true;
            node.closeConnection().then(() => done(), done);
        });
    }

    OpcUaClientConfigNode.prototype.getSession = async function () {
        if (this.session) {
            return this.session;
        }

        if (!this.connectPromise) {
            if (!this.endpoint) {
                throw new Error("OPC UA endpoint is not configured");
            }

            this.connectPromise = (async () => {
                const userDir = (RED.settings && RED.settings.userDir) || path.join(require('os').homedir(), ".node-red");
                let flowFile = (RED.settings && RED.settings.flowFile) || "flows.json";
                if (typeof flowFile !== "string") {
                    flowFile = "flows.json";
                }
                const flowFileFolder = path.isAbsolute(flowFile) ? path.dirname(flowFile) : path.join(userDir, path.dirname(flowFile));
                const clientName = (this.name || "").trim() || this.sessionName || "default";
                const safeClientName = clientName
                    .replace(/[\\/:\*\?"<>|]/g, "_")
                    .replace(/^\.+$/, "");
                const clientCertificateFolder = path.join(flowFileFolder, "simple_opcua", "client", safeClientName);

                // Ensure directories exist immediately
                const fs = require("fs");
                try {
                    const trustedDir = path.join(clientCertificateFolder, "trusted", "certs");
                    const rejectedDir = path.join(clientCertificateFolder, "rejected");
                    if (!fs.existsSync(trustedDir)) {
                        fs.mkdirSync(trustedDir, { recursive: true });
                    }
                    if (!fs.existsSync(rejectedDir)) {
                        fs.mkdirSync(rejectedDir, { recursive: true });
                    }
                } catch (e) {
                    // Ignore directory creation errors
                }

                const clientCertificateManager = new OPCUACertificateManager({
                    rootFolder: clientCertificateFolder,
                    automaticallyAcceptUnknownCertificate: true
                });
                await clientCertificateManager.initialize();

                const client = OPCUAClient.create({
                    endpointMustExist: this.endpointMustExist,
                    keepSessionAlive: this.keepSessionAlive,
                    securityMode: resolveSecurityMode(this.securityMode),
                    securityPolicy: resolveSecurityPolicy(this.securityPolicy),
                    clientName: this.sessionName || "ClientSession",
                    clientCertificateManager: clientCertificateManager,
                    requestedSessionTimeout: this.requestedSessionTimeout,
                    defaultTransactionTimeout: this.defaultTransactionTimeout,
                    connectionStrategy: {
                        maxRetry: this.autoReconnect ? this.maxRetry : 0,
                        initialDelay: this.initialDelay,
                        maxDelay: this.maxDelay
                    }
                });
                this.client = client;

                client.on("connection_lost", (err) => {
                    if (!this.closing) {
                        this.emit("connection_lost", err || new Error("Connection lost"));
                    }
                });

                client.on("connection_reestablished", () => {
                    if (!this.closing) {
                        this.emit("connection_reestablished");
                    }
                });

                client._nextSessionName = () => {
                    return this.sessionName || "ClientSession1";
                };

                try {
                    await client.connect(this.endpoint);

                    const credentials = this.credentials || {};
                    let userIdentity = { type: UserTokenType.Anonymous };

                    if (this.authType === "username") {
                        userIdentity = {
                            type: UserTokenType.UserName,
                            userName: credentials.username || "",
                            password: credentials.password || ""
                        };
                    }
                    const session = await client.createSession(userIdentity);

                    session.on("session_closed", () => {
                        this.session = null;
                        this.methodObjectIdCache.clear();
                        this.methodDefinitionCache.clear();
                    });

                    this.session = session;
                     
                    return session;
                } catch (error) {
                    try {
                        await client.disconnect();
                    } catch (disconnectError) {
                        // Ignore secondary disconnect failures after a failed connect/createSession.
                    }
                    this.client = null;
                    this.session = null;
                    throw error;
                } finally {
                    this.connectPromise = null;
                }
            })();
        }

        const timeoutMs = this.defaultTransactionTimeout || 15000;
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                this.connectPromise = null;
                if (this.client) {
                    this.client.disconnect().catch(() => {});
                    this.client = null;
                }
                reject(new Error("Connection timeout: failed to connect to OPC UA server within " + timeoutMs + "ms"));
            }, timeoutMs);
        });

        try {
            const session = await Promise.race([this.connectPromise, timeoutPromise]);
            clearTimeout(timeoutId);
            return session;
        } catch (err) {
            clearTimeout(timeoutId);
            throw err;
        }
    };

    OpcUaClientConfigNode.prototype.resolveMethodObjectId = async function (session, methodNodeId) {
        return resolveMethodObjectId(session, methodNodeId, this.methodObjectIdCache);
    };

    OpcUaClientConfigNode.prototype.getMethodArgumentDefinition = async function (session, methodNodeId) {
        return getMethodArgumentDefinition(session, methodNodeId, this.methodDefinitionCache);
    };

    OpcUaClientConfigNode.prototype.closeConnection = async function () {
        const session = this.session;
        const client = this.client;

        this.session = null;
        this.client = null;
        this.connectPromise = null;
        this.methodObjectIdCache.clear();
        this.methodDefinitionCache.clear();

        if (session) {
            try {
                await session.close();
            } catch (error) {
                // Ignore close errors during shutdown.
            }
        }

        if (client) {
            try {
                await client.disconnect();
            } catch (error) {
                // Ignore disconnect errors during shutdown.
            }
        }
    };

    RED.nodes.registerType("opcua-client-config", OpcUaClientConfigNode, {
        credentials: {
            username: { type: "text" },
            password: { type: "password" }
        }
    });

    RED.httpAdmin.get("/opcua-client-config/:id/browse", RED.auth.needsPermission("flows.read"), async function (req, res) {
        try {
            const configNode = RED.nodes.getNode(req.params.id);

            if (!configNode) {
                res.status(404).json({ error: "OPC UA client configuration not found" });
                return;
            }

            const payload = await browseForEditor(configNode, req.query.nodeId);
            res.json(payload);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    RED.httpAdmin.get("/opcua-client-config/:id/read", RED.auth.needsPermission("flows.read"), async function (req, res) {
        try {
            const configNode = RED.nodes.getNode(req.params.id);

            if (!configNode) {
                res.status(404).json({ error: "OPC UA client configuration not found" });
                return;
            }

            const nodeId = req.query.nodeId;
            if (!nodeId) {
                throw new Error("Missing nodeId parameter");
            }

            const session = await configNode.getSession();
            const dataValue = await session.read({
                nodeId: nodeId,
                attributeId: AttributeIds.Value
            });

            if (dataValue.statusCode && !dataValue.statusCode.isGood()) {
                throw new Error("Read failed: " + dataValue.statusCode.toString());
            }

            const cache = new Map();
            let result = dataValueToItemResult({ nodeID: nodeId }, dataValue);
            result = await enrichItemResultWithEnumeration(result, session, cache, nodeId);

            res.json({ value: result.value, valueEnumeration: result.valueEnumeration });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    RED.httpAdmin.post("/opcua-client-config/test-connection", RED.auth.needsPermission("flows.write"), async function (req, res) {
        let client;
        let session;
        try {
            const body = req.body || {};
            const endpoint = (body.endpoint || "").trim();
            const securityPolicy = body.securityPolicy || "None";
            const securityMode = body.securityMode || "None";
            const authType = body.authType || "anonymous";
            let username = body.username || "";
            let password = body.password || "";
            const endpointMustExist = body.endpointMustExist === true;
            const nodeId = body.nodeId;
            const defaultTransactionTimeout = (body.defaultTransactionTimeout !== undefined && body.defaultTransactionTimeout !== "") ? Number(body.defaultTransactionTimeout) : 15000;

            if (!endpoint) {
                throw new Error("OPC UA endpoint is not configured");
            }

            if (nodeId) {
                const credentials = RED.nodes.getCredentials(nodeId) || {};
                if (username === "__PWRD__" || !username) {
                    username = credentials.username || "";
                }
                if (password === "__PWRD__") {
                    password = credentials.password || "";
                }
            }

            const userDir = (RED.settings && RED.settings.userDir) || path.join(require('os').homedir(), ".node-red");
            let flowFile = (RED.settings && RED.settings.flowFile) || "flows.json";
            if (typeof flowFile !== "string") {
                flowFile = "flows.json";
            }
            const flowFileFolder = path.isAbsolute(flowFile) ? path.dirname(flowFile) : path.join(userDir, path.dirname(flowFile));
            
            const clientName = "test_connection_" + (nodeId || "new");
            const safeClientName = clientName
                .replace(/[\\/:\*\?"<>|]/g, "_")
                .replace(/^\.+$/, "");
            const clientCertificateFolder = path.join(flowFileFolder, "simple_opcua", "client", safeClientName);

            const fs = require("fs");
            try {
                const trustedDir = path.join(clientCertificateFolder, "trusted", "certs");
                const rejectedDir = path.join(clientCertificateFolder, "rejected");
                if (!fs.existsSync(trustedDir)) {
                    fs.mkdirSync(trustedDir, { recursive: true });
                }
                if (!fs.existsSync(rejectedDir)) {
                    fs.mkdirSync(rejectedDir, { recursive: true });
                }
            } catch (e) {
                // Ignore directory creation errors
            }

            const clientCertificateManager = new OPCUACertificateManager({
                rootFolder: clientCertificateFolder,
                automaticallyAcceptUnknownCertificate: true
            });
            await clientCertificateManager.initialize();

            client = OPCUAClient.create({
                endpointMustExist: endpointMustExist,
                keepSessionAlive: false,
                securityMode: resolveSecurityMode(securityMode),
                securityPolicy: resolveSecurityPolicy(securityPolicy),
                clientName: "ConnectionTestSession",
                clientCertificateManager: clientCertificateManager,
                requestedSessionTimeout: 15000,
                defaultTransactionTimeout: defaultTransactionTimeout,
                connectionStrategy: {
                    maxRetry: 0
                }
            });

            await client.connect(endpoint);

            let userIdentity = { type: UserTokenType.Anonymous };

            if (authType === "username") {
                userIdentity = {
                    type: UserTokenType.UserName,
                    userName: username,
                    password: password
                };
            }
            session = await client.createSession(userIdentity);

            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, message: error.message });
        } finally {
            if (session) {
                try {
                    await session.close();
                } catch (e) {}
            }
            if (client) {
                try {
                    await client.disconnect();
                } catch (e) {}
            }
        }
    });
};

async function browseForEditor(configNode, nodeId) {
    const session = await configNode.getSession();
    const result = await browseNode(session, {
        nodeID: nodeId || ROOT_NODE_ID
    });
    if (result && result.children) {
        result.browse = result.children;
        delete result.children;
    }
    return result;
}

