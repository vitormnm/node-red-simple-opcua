"use strict";

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
        node.endpoint = (config.endpoint || "").trim();
        node.securityPolicy = config.securityPolicy || "None";
        node.securityMode = config.securityMode || "None";
        node.authType = config.authType || "anonymous";
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
            const client = OPCUAClient.create({
                endpointMustExist: false,
                keepSessionAlive: true,
                securityMode: resolveSecurityMode(this.securityMode),
                securityPolicy: resolveSecurityPolicy(this.securityPolicy)
            });

            try {
                await client.connect(this.endpoint);

                const credentials = this.credentials || {};
                const session = this.authType === "username"
                    ? await client.createSession({
                        userName: credentials.username || "",
                        password: credentials.password || ""
                    })
                    : await client.createSession();

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
    return browseNode(session, {
        nodeID: nodeId || ROOT_NODE_ID
    });
}
