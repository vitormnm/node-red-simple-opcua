"use strict";



const {
    OPCUAServer,
    UserTokenType,
    buildApplicationUri
} = require("./opcua-constants");
const { OpcUaAddressSpaceBuilder } = require("./opcua-address-space-builder");
const { OpcUaServerMethods } = require("./opcua-server-methods");

class OpcUaServerRuntime {
    constructor(options) {
        this.node = options.node;
        this.registry = options.registry;
        this.id = options.settings.id;
        this.name = options.settings.name;
        this.serverName = options.settings.serverName;
        this.port = options.settings.port;
        this.maxConnections = options.settings.maxConnections;
        this.namespaceUri = options.settings.namespaceUri;
        this.resourcePath = options.settings.resourcePath;
        this.allowAnonymous = options.settings.allowAnonymous;
        this.users = options.settings.users;
        this.securityPolicy = options.settings.securityPolicy;
        this.securityMode = options.settings.securityMode;
        this.treeConfig = options.settings.treeConfig;

        this.server = null;
        this.namespace = null;
        this.namespaces = new Map();
        this.namespaceDefinitions = new Map();
        this.addressSpaceBuilder = null;


    }

    async start() {
        if (this.server) {
            return;
        }

        this.server = new OPCUAServer(this.buildServerOptions());
        await this.server.initialize();

        const addressSpace = this.server.engine.addressSpace;
   
        this.initializeNamespaces(this.treeConfig);

        this.addressSpaceBuilder = new OpcUaAddressSpaceBuilder({
            namespace: this.namespace,
            namespaces: this.namespaces,
            server: this.server,
            registry: this.registry,
            node: this.node,
            serverName: this.serverName,
            addressSpace: this.addressSpace
        });


        this.addressSpaceBuilder.rebuild(this.treeConfig);
        await this.server.start();
        this.registry.registerServer(this);

        //Methods
        const ServerMethods = new OpcUaServerMethods({
            addressSpace: addressSpace,
            registry: this.registry,
            node: this.node
        })

        ServerMethods.start();

      
    }

    async stop() {
        if (!this.server) {
            this.node.status({ fill: "grey", shape: "ring", text: "stopped" });
            return;
        }

        try {
            if (this.addressSpaceBuilder) {
                this.addressSpaceBuilder.clearDynamicNodes();
                this.addressSpaceBuilder.variableStore.clear();
            }

            await this.server.shutdown(1000);
        } finally {
            this.registry.unregisterServer(this.id);
            this.addressSpaceBuilder = null;
            this.namespace = null;
            this.namespaces = new Map();
            this.namespaceDefinitions = new Map();
            this.server = null;
            this.node.status({ fill: "grey", shape: "ring", text: "stopped" });
        }
    }

    ensureReady() {
        if (!this.server || !this.namespace || !this.addressSpaceBuilder) {
            throw new Error("OPC UA server is not available");
        }
    }



    async updateTree(treeConfig) {
        this.ensureReady();
        this.syncNamespaces(treeConfig);
        this.treeConfig = treeConfig;
        this.addressSpaceBuilder.sync(treeConfig);
    }

    readValueByPath(path) {
        this.ensureReady();
        return this.addressSpaceBuilder.readValueByPath(path);
    }

    readValueByNodeId(nodeId) {
        this.ensureReady();
        return this.addressSpaceBuilder.readValueByNodeId(nodeId);
    }

    readValue(identifierType, identifier) {
        this.ensureReady();
        return this.addressSpaceBuilder.readValue(identifierType, identifier);
    }

    writeEventByPath(valuesPayload) {
        this.ensureReady();
        return this.addressSpaceBuilder.eventValueByPath(valuesPayload);
    }

    writeValueByPath(path, value) {
        this.ensureReady();
        return this.addressSpaceBuilder.writeValueByPath(path, value);
    }

    writeValueByNodeId(nodeId, value) {
        this.ensureReady();
        return this.addressSpaceBuilder.writeValueByNodeId(nodeId, value);
    }

    writeValue(identifierType, identifier, value) {
        this.ensureReady();
        return this.addressSpaceBuilder.writeValue(identifierType, identifier, value);
    }

    getEndpointUrl() {
        if (!this.server || !Array.isArray(this.server.endpoints)) {
            return "";
        }

        for (let index = 0; index < this.server.endpoints.length; index += 1) {
            const endpoint = this.server.endpoints[index];
            if (!endpoint || typeof endpoint.endpointDescriptions !== "function") {
                continue;
            }

            const descriptions = endpoint.endpointDescriptions();
            if (Array.isArray(descriptions) && descriptions.length && descriptions[0].endpointUrl) {
                return descriptions[0].endpointUrl;
            }
        }

        return "opc.tcp://localhost:" + this.port + this.resourcePath;
    }

    buildServerOptions() {
        const activeUsers = Array.isArray(this.users) ? this.users : [];
        const userTokenPolicies = [];

        if (this.allowAnonymous) {
            userTokenPolicies.push({
                policyId: "anonymous",
                tokenType: UserTokenType.Anonymous
            });
        }

        if (activeUsers.length) {
            userTokenPolicies.push({
                policyId: "username",
                tokenType: UserTokenType.UserName
            });
        }

        return {
            port: this.port,
            resourcePath: this.resourcePath,
            buildInfo: {
                productName: "opc-ua-server",
                buildNumber: "1",
                buildDate: new Date()
            },
            // serverCertificateManager: {
            //     automaticallyAcceptUnknownCertificate: true
            // },
            serverCapabilities: {
                maxSessions: this.maxConnections
            },
            serverInfo: {
                applicationName: { text: this.serverName },
                applicationUri: buildApplicationUri(this.serverName),
                productUri: "urn:node-red:opc-ua-server"
            },
            securityPolicies: [this.securityPolicy],
            securityModes: [this.securityMode],
            allowAnonymous: this.allowAnonymous,
            userManager: {
                isValidUser: (username, password) => this.isValidUser(username, password)
            },
            userTokenPolicies
        };
    }

    isValidUser(username, password) {
        return this.users.some((user) => {
            if (user.username !== username) {
                return false;
            }

            if (user.password && user.password === password) {
                return true;
            }

            if (user.passwordHash) {
                try {
                    return bcrypt.compareSync(password, user.passwordHash);
                } catch (error) {
                    this.node.warn("Failed to validate password hash for user " + username + ": " + error.message);
                    return false;
                }
            }

            return false;
        });
    }

    initializeNamespaces(treeConfig) {
        const addressSpace = this.server.engine.addressSpace;
        const configuredNamespaces = this.buildNamespaceDefinitions(treeConfig);

        this.namespaces = new Map();
        this.namespaceDefinitions = configuredNamespaces;

        configuredNamespaces.forEach((uri, namespaceId) => {
            const namespace = addressSpace.getNamespace(uri) || addressSpace.registerNamespace(uri);
            this.namespaces.set(namespaceId, namespace);
        });

        this.namespace = this.namespaces.get(2);
    }

    syncNamespaces(treeConfig) {
        const addressSpace = this.server.engine.addressSpace;
        const nextDefinitions = this.buildNamespaceDefinitions(treeConfig);

        this.namespaceDefinitions.forEach((uri, namespaceId) => {
            const nextUri = nextDefinitions.get(namespaceId);
            if (nextUri && nextUri !== uri) {
                throw new Error("Namespace URI changes require a redeploy: namespace " + namespaceId);
            }

            if (!nextUri) {
                throw new Error("Removing namespaces requires a redeploy: namespace " + namespaceId);
            }
        });

        nextDefinitions.forEach((uri, namespaceId) => {
            if (this.namespaces.has(namespaceId)) {
                return;
            }

            const namespace = addressSpace.getNamespace(uri) || addressSpace.registerNamespace(uri);
            this.namespaces.set(namespaceId, namespace);
        });

        this.namespaceDefinitions = nextDefinitions;
        this.namespace = this.namespaces.get(2);
    }

    buildNamespaceDefinitions(treeConfig) {
        const definitions = new Map();
        const configuredNamespaces = Array.isArray(treeConfig && treeConfig.nameSpaces) ? treeConfig.nameSpaces : [];
        let defaultNamespaceUri = this.namespaceUri;

        configuredNamespaces.forEach((namespaceConfig) => {
            if (namespaceConfig.id === 2) {
                defaultNamespaceUri = namespaceConfig.name;
            }
        });

        definitions.set(2, defaultNamespaceUri);

        configuredNamespaces
            .slice()
            .sort((left, right) => left.id - right.id)
            .forEach((namespaceConfig) => {
                definitions.set(namespaceConfig.id, namespaceConfig.name);
            });

        return definitions;
    }
}

module.exports = {
    OpcUaServerRuntime
};
