"use strict";

const path = require("path");
const { OPCUACertificateManager, UserTokenType } = require("node-opcua");

const {
    OPCUAClient,
    getMethodArgumentDefinition,
    resolveMethodObjectId,
    resolveSecurityMode,
    resolveSecurityPolicy
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
        node.keepSessionAlive = config.keepSessionAlive !== false;
        node.autoReconnect = config.autoReconnect !== false;
        node.endpointMustExist = config.endpointMustExist === true;
        node.client = null;
        node.session = null;
        node.connectPromise = null;
        node.methodObjectIdCache = new Map();
        node.methodDefinitionCache = new Map();

        node.on("close", function (done) {
            node.closeConnection().then(() => done(), done);
        });
    }

    OpcUaClientConfigNode.prototype.getSession = async function () {
        if (this.session) {
            return this.session;
        }

        if (this.connectPromise) {
            return this.connectPromise;
        }

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
                connectionStrategy: {
                    maxRetry: this.autoReconnect ? this.maxRetry : 0,
                    initialDelay: this.initialDelay,
                    maxDelay: this.maxDelay
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

                this.client = client;
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

        return this.connectPromise;
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

