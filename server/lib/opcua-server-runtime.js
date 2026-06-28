"use strict";



const path = require("path");
const {
    OPCUAServer,
    UserTokenType,
    buildApplicationUri,
    makeRoles,
    WellKnownRoles,
    resolveNodeId,
    OPCUACertificateManager,
    SecurityPolicy,
    MessageSecurityMode
} = require("./opcua-constants");
const { OpcUaAddressSpaceBuilder } = require("./opcua-address-space-builder");
const { OpcUaServerMethods } = require("./opcua-server-methods");
let bcrypt = null;

try {
    bcrypt = require("bcryptjs");
} catch (error) {
    bcrypt = null;
}

class OpcUaServerRuntime {
    constructor(options) {
        this.node = options.node;
        this.registry = options.registry;
        this.id = options.settings.id;
        this.name = options.settings.name;
        this.serverName = options.settings.serverName;
        this.port = options.settings.port;
        this.maxConnections = options.settings.maxConnections;
        this.minSessionTimeout = options.settings.minSessionTimeout;
        this.defaultSessionTimeout = options.settings.defaultSessionTimeout;
        this.maxSessionTimeout = options.settings.maxSessionTimeout;
        this.namespaceUri = options.settings.namespaceUri;
        this.resourcePath = options.settings.resourcePath;
        this.allowAnonymous = options.settings.allowAnonymous;
        this.automaticallyAcceptUnknownCertificate = options.settings.automaticallyAcceptUnknownCertificate;
        this.certificatesFolder = options.settings.certificatesFolder;
        this.groups = options.settings.groups;
        this.users = options.settings.users;
        this.securityPolicies = Array.isArray(options.settings.securityPolicies) && options.settings.securityPolicies.length > 0
            ? options.settings.securityPolicies
            : [SecurityPolicy.None];
        this.securityModes = Array.isArray(options.settings.securityModes) && options.settings.securityModes.length > 0
            ? options.settings.securityModes
            : [MessageSecurityMode.None];
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

        const certificateFolder = this.certificatesFolder || path.resolve(__dirname, "..", "..", "certificates");
        this.serverCertificateManager = new OPCUACertificateManager({
            rootFolder: certificateFolder,
            automaticallyAcceptUnknownCertificate: this.automaticallyAcceptUnknownCertificate
        });
        await this.serverCertificateManager.initialize();

        // Ensure directories exist immediately on startup
        const fs = require("fs");
        try {
            const trustedDir = path.join(certificateFolder, "trusted", "certs");
            const rejectedDir = path.join(certificateFolder, "rejected");
            if (!fs.existsSync(trustedDir)) {
                fs.mkdirSync(trustedDir, { recursive: true });
            }
            if (!fs.existsSync(rejectedDir)) {
                fs.mkdirSync(rejectedDir, { recursive: true });
            }
        } catch (e) {
            // Ignore directory creation errors
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
            addressSpace: this.addressSpace,
            allowAnonymous: this.allowAnonymous,
            users: this.users
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
        // Refresh the user list in the builder so newly added/removed users are
        // recognised in access events without requiring a full server restart.
        this.addressSpaceBuilder.updateUsers(this.users);
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

        const certificatesFolder = this.certificatesFolder || path.resolve(__dirname, "..", "..", "certificates");

        return {
            port: this.port,
            minSessionTimeout: this.minSessionTimeout !== undefined ? this.minSessionTimeout : 100,
            defaultSessionTimeout: this.defaultSessionTimeout !== undefined ? this.defaultSessionTimeout : 30000,
            maxSessionTimeout: this.maxSessionTimeout !== undefined ? this.maxSessionTimeout : 3000000,
            resourcePath: this.resourcePath,
            serverCertificateManager: this.serverCertificateManager,
            certificateFile: path.join(certificatesFolder, "own", "certs", "server_selfsigned_cert_2048.pem"),
            privateKeyFile: path.join(certificatesFolder, "own", "private", "private_key.pem"),
            buildInfo: {
                productName: "opc-ua-server",
                buildNumber: "1",
                buildDate: new Date()
            },
            serverCapabilities: {
                maxSessions: this.maxConnections
            },
            serverInfo: {
                applicationName: { text: this.serverName },
                applicationUri: buildApplicationUri(this.serverName),
                productUri: "urn:node-red:opc-ua-server"
            },
            securityPolicies: this.securityPolicies,
            securityModes: this.securityModes,
            allowAnonymous: this.allowAnonymous,
            userManager: {
                isValidUser: (username, password) => this.isValidUser(username, password),
                getUserRoles: (username) => this.getUserRoles(username)
            },
            userTokenPolicies
        };
    }

    getUserRoles(username) {
        const normalizedUserName = typeof username === "string" ? username.trim() : "";
        if (!normalizedUserName || normalizedUserName.toLowerCase() === "anonymous") {
            return makeRoles([WellKnownRoles.Anonymous]);
        }

        const user = this.users.find((entry) => entry && entry.username === normalizedUserName);
        if (!user) {
            return makeRoles([WellKnownRoles.AuthenticatedUser]);
        }

        const roles = [resolveNodeId("WellKnownRole_AuthenticatedUser")];
        const groups = typeof user.group === "string"
            ? user.group.split(",").map(g => g.trim()).filter(Boolean)
            : Array.isArray(user.group)
                ? user.group
                : [];

        groups.forEach((groupName) => {
            const customRole = this.resolveGroupRoleNodeId(groupName);
            if (customRole) {
                roles.push(customRole);
            }
        });
        return roles;
    }

    resolveGroupRoleNodeId(groupName) {
        const normalized = String(groupName || "").trim().toLowerCase();
        if (!normalized || normalized === "public") {
            return null;
        }

        const wellKnownRoles = {
            operator: "WellKnownRole_Operator",
            supervisor: "WellKnownRole_Supervisor",
            engineer: "WellKnownRole_Engineer",
            engineering: "WellKnownRole_Engineer",
            observer: "WellKnownRole_Observer",
            admin: "WellKnownRole_ConfigureAdmin",
            configureadmin: "WellKnownRole_ConfigureAdmin",
            securityadmin: "WellKnownRole_SecurityAdmin"
        };

        if (wellKnownRoles[normalized]) {
            return resolveNodeId(wellKnownRoles[normalized]);
        }

        return resolveNodeId("ns=1;s=NodeRedRole/" + this.sanitizeRoleSegment(normalized));
    }

    sanitizeRoleSegment(value) {
        return String(value || "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "_")
            .replace(/[^a-z0-9._-]/g, "_");
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
                if (!bcrypt) {
                    this.node.warn("bcryptjs is not installed, so hashed passwords cannot be validated.");
                    return false;
                }
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
