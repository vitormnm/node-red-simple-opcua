"use strict";

const {
    DEFAULT_NAMESPACE_URI,
    DEFAULT_RESOURCE_PATH,
    DEFAULT_SERVER_NAME,
    MessageSecurityMode,
    SecurityPolicy,
    SECURITY_MODE_MAP,
    SECURITY_POLICY_MAP,
    DATA_TYPE_MAP,
    normalizePort
} = require("./opcua-constants");

class OpcUaServerConfigParser {
    constructor(node) {
        this.node = node;
    }

    parseNodeConfig(config, credentials) {
        const security = this.applySecuritySettings(config.securityPolicy, config.securityMode);
        return {
            id: this.node.id,
            name: config.name,
            serverName: config.serverName || DEFAULT_SERVER_NAME,
            port: normalizePort(config.port),
            maxConnections: this.normalizeMaxConnections(config.maxConnections),
            namespaceUri: config.namespaceUri || DEFAULT_NAMESPACE_URI,
            resourcePath: config.resourcePath || DEFAULT_RESOURCE_PATH,
            treeConfig: this.parseTreeConfig(config.tree),
            allowAnonymous: this.normalizeAllowAnonymous(config.allowAnonymous),
            users: this.parseUsersConfig(config.users, credentials),
            securityPolicy: security.securityPolicy,
            securityMode: security.securityMode
        };
    }

    parseTreeConfig(rawTree) {
        try {
            return this.normalizeTreeConfig(rawTree);
        } catch (error) {
            this.node.warn("Invalid tree configuration in editor, using empty tree: " + error.message);
            return { objects: [], folders: [], objectsTypes: [], nameSpaces: [] };
        }
    }

    parseUsersConfig(rawUsers, credentials) {
        try {
            const users = this.normalizeUsersConfig(rawUsers);
            const credentialUser = this.normalizeCredentialUser(credentials);
            if (credentialUser) {
                users.unshift(credentialUser);
            }
            return users;
        } catch (error) {
            this.node.warn("Invalid users configuration in editor, using only credential user: " + error.message);
            const credentialUser = this.normalizeCredentialUser(credentials);
            return credentialUser ? [credentialUser] : [];
        }
    }

    normalizeTreeConfig(rawTree) {
        let parsed = rawTree;

        if (parsed === undefined || parsed === null || parsed === "") {
            parsed = { objects: [], folders: [], objectsTypes: [], nameSpaces: [] };
        }

        if (typeof parsed === "string") {
            parsed = JSON.parse(parsed);
        }

        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Tree configuration must be an object");
        }

        // Normalize root-level type definitions first so instances can reference them
        const objectsTypes = this.normalizeObjectTypes(parsed.objectsTypes || parsed.objectTypes || []);

        // Build a lookup map by type name for fast resolution
        this._objectsTypesMap = {};
        for (const typeDef of objectsTypes) {
            this._objectsTypesMap[typeDef.name] = typeDef;
        }

        return {
            objects: this.normalizeObjects(parsed.objects || []),
            folders: this.normalizeFolders(parsed.folders || []),
            objectsTypes,
            nameSpaces: this.normalizeNamespaces(parsed.nameSpaces || parsed.namespaces || [])
        };
    }

    normalizeNamespaces(rawNamespaces) {
        if (!Array.isArray(rawNamespaces)) {
            throw new Error("'nameSpaces' must be an array");
        }

        const seenIds = new Set();
        return rawNamespaces.map((namespaceConfig) => {
            const normalized = this.normalizeNamespaceDefinition(namespaceConfig);
            if (seenIds.has(normalized.id)) {
                throw new Error("Duplicate namespace id: " + normalized.id);
            }
            seenIds.add(normalized.id);
            return normalized;
        });
    }

    normalizeNamespaceDefinition(namespaceConfig) {
        if (!namespaceConfig || typeof namespaceConfig !== "object" || Array.isArray(namespaceConfig)) {
            throw new Error("Each namespace must be an object");
        }

        const id = this.normalizeNamespaceId(namespaceConfig.id);
        const name = typeof namespaceConfig.name === "string" ? namespaceConfig.name.trim() : "";

        if (!name) {
            throw new Error("Each namespace requires a non-empty name");
        }

        return {
            id,
            name
        };
    }

    normalizeObjectTypes(objectTypes) {
        if (!Array.isArray(objectTypes)) {
            throw new Error("'objectsTypes' must be an array");
        }

        return objectTypes.map((objectTypeConfig) => this.normalizeBranch(objectTypeConfig, "object type"));
    }

    normalizeUsersConfig(rawUsers) {
        let parsed = rawUsers;

        if (parsed === undefined || parsed === null || parsed === "") {
            parsed = [];
        }

        if (typeof parsed === "string") {
            parsed = JSON.parse(parsed);
        }

        if (!Array.isArray(parsed)) {
            throw new Error("Users configuration must be an array");
        }

        return parsed.map((userConfig) => this.normalizeUser(userConfig));
    }

    normalizeCredentialUser(credentials) {
        const safeCredentials = credentials || {};
        const username = typeof safeCredentials.username === "string" ? safeCredentials.username.trim() : "";
        const password = typeof safeCredentials.password === "string" ? safeCredentials.password : "";

        if (!username || !password) {
            return null;
        }

        return {
            username,
            password,
            passwordHash: ""
        };
    }

    normalizeFolders(folders) {
        if (!Array.isArray(folders)) {
            throw new Error("'folders' must be an array");
        }

        return folders.map((folderConfig) => this.normalizeBranch(folderConfig, "folder"));
    }

    normalizeObjects(objects) {
        if (!Array.isArray(objects)) {
            throw new Error("'objects' must be an array");
        }

        return objects.map((objectConfig) => this.normalizeBranch(objectConfig, "object"));
    }

    normalizeBranch(branchConfig, branchType) {
        if (!branchConfig || typeof branchConfig !== "object" || Array.isArray(branchConfig)) {
            throw new Error("Each " + branchType + " must be an object");
        }

        const name = this.requiredName(branchConfig, branchType);

        return {
            name,
            displayName: branchConfig.displayName || name,
            description: branchConfig.description || "",
            nodeId: this.normalizeOptionalNodeId(branchConfig.nodeId),
            namespaceId: this.normalizeNamespaceId(branchConfig.namespaceId),
            folders: Array.isArray(branchConfig.folders)
                ? branchConfig.folders.map((folderConfig) => this.normalizeBranch(folderConfig, "folder"))
                : [],
            objects: Array.isArray(branchConfig.objects)
                ? branchConfig.objects.map((objectConfig) => this.normalizeBranch(objectConfig, "object"))
                : [],
            variables: Array.isArray(branchConfig.variables)
                ? branchConfig.variables.map((variableConfig) => this.normalizeVariable(variableConfig))
                : [],
            methods: Array.isArray(branchConfig.methods)
                ? branchConfig.methods.map((methodConfig) => this.normalizeMethod(methodConfig))
                : Array.isArray(branchConfig.method)
                    ? branchConfig.method.map((methodConfig) => this.normalizeMethod(methodConfig))
                    : [],
            objectsTypes: Array.isArray(branchConfig.objectsTypes)
                ? branchConfig.objectsTypes.map((objectTypeConfig) => this.normalizeObjectTypeInstance(objectTypeConfig))
                : Array.isArray(branchConfig.objectTypes)
                    ? branchConfig.objectTypes.map((objectTypeConfig) => this.normalizeObjectTypeInstance(objectTypeConfig))
                    : [],
            alarms: Array.isArray(branchConfig.alarms)
                ? branchConfig.alarms.map((alarmConfig) => this.normalizeAlarm(alarmConfig))
                : []
        };
    }

    normalizeObjectTypeInstance(objectTypeConfig) {
        if (!objectTypeConfig || typeof objectTypeConfig !== "object" || Array.isArray(objectTypeConfig)) {
            throw new Error("Each object type instance must be an object");
        }

        const normalizedBranch = this.normalizeBranch(objectTypeConfig, "object type instance");
        const objectsType = typeof objectTypeConfig.objectsType === "string" && objectTypeConfig.objectsType.trim()
            ? objectTypeConfig.objectsType.trim()
            : typeof objectTypeConfig.objectType === "string" && objectTypeConfig.objectType.trim()
                ? objectTypeConfig.objectType.trim()
                : "";

        if (!objectsType) {
            throw new Error("Each object type instance requires a non-empty objectsType");
        }

        normalizedBranch.objectsType = objectsType;

        // Children inherited from the type definition are intentionally NOT injected here.
        // The builder (walkInheritedChildren) locates and registers them after node-opcua
        // creates them automatically via addObject({ typeDefinition }). Injecting them here
        // would cause addVariable to be called with the type's nodeId, triggering a
        // "nodeId already registered" error from node-opcua.

        return normalizedBranch;
    }

    // Returns the string value after "s=" in a nodeId like "ns=2;s=Motor_type2"
    _extractNodeIdValue(nodeId) {
        if (!nodeId) return "";
        const m = nodeId.match(/(?:^|;)s=(.+)$/);
        return m ? m[1] : "";
    }

    normalizeVariable(variableConfig) {
        if (!variableConfig || typeof variableConfig !== "object" || Array.isArray(variableConfig)) {
            throw new Error("Each variable must be an object");
        }
        const name = this.requiredName(variableConfig, "variable");
        const type = this.normalizeType(variableConfig.type);
        const access = this.normalizeAccess(variableConfig.access);

        return {
            name,
            type,
            access,
            value: this.coerceValue(variableConfig.value, type),
            description: variableConfig.description || "",
            displayName: variableConfig.displayName || name,
            nodeId: this.normalizeOptionalNodeId(variableConfig.nodeId),
            namespaceId: this.normalizeNamespaceId(variableConfig.namespaceId)
        };
    }

    normalizeMethod(methodConfig) {
        if (!methodConfig || typeof methodConfig !== "object" || Array.isArray(methodConfig)) {
            throw new Error("Each method must be an object");
        }

        const name = this.requiredName(methodConfig, "method");

        return {
            name,
            displayName: methodConfig.displayName || name,
            description: methodConfig.description || "",
            nodeId: this.normalizeOptionalNodeId(methodConfig.nodeId),
            namespaceId: this.normalizeNamespaceId(methodConfig.namespaceId),
            inputs: Array.isArray(methodConfig.inputs)
                ? methodConfig.inputs.map((arg) => this.normalizeMethodArg(arg))
                : Array.isArray(methodConfig.inputArguments)
                    ? methodConfig.inputArguments.map((arg) => this.normalizeMethodArg(arg))
                    : [],
            outputs: Array.isArray(methodConfig.outputs)
                ? methodConfig.outputs.map((arg) => this.normalizeMethodArg(arg))
                : Array.isArray(methodConfig.outputArguments)
                    ? methodConfig.outputArguments.map((arg) => this.normalizeMethodArg(arg))
                    : []
        };
    }

    normalizeMethodArg(arg) {
        if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
            throw new Error("Each method arg must be an object");
        }

        const name = this.requiredName(arg, "method arg");

        return {
            name,
            type: this.normalizeType(arg.type),
            displayName: arg.displayName || name,
            description: arg.description || ""
        };
    }

    normalizeAlarm(alarmConfig) {
        if (!alarmConfig || typeof alarmConfig !== "object" || Array.isArray(alarmConfig)) {
            throw new Error("Each alarm must be an object");
        }

        const name = this.requiredName(alarmConfig, "alarm");
        const type = typeof alarmConfig.type === "string" && alarmConfig.type.trim()
            ? alarmConfig.type.trim()
            : "levelAlarm";

        const base = {
            name,
            type,
            sourceName: typeof alarmConfig.sourceName === "string" ? alarmConfig.sourceName : name,
            severity: Number.isFinite(Number(alarmConfig.severity)) ? Number(alarmConfig.severity) : 500,
            variableNodeId: typeof alarmConfig.variableNodeId === "string" ? alarmConfig.variableNodeId : "",
            displayName: typeof alarmConfig.displayName === "string" ? alarmConfig.displayName : "",
            description: typeof alarmConfig.description === "string" ? alarmConfig.description : "",
            nodeId: this.normalizeOptionalNodeId(alarmConfig.nodeId),
            namespaceId: this.normalizeNamespaceId(alarmConfig.namespaceId),
            enabled: typeof alarmConfig.enabled === "boolean" ? alarmConfig.enabled : true
        };

        if (type === "levelAlarm") {
            base.highHighLimit = Number.isFinite(Number(alarmConfig.highHighLimit)) ? Number(alarmConfig.highHighLimit) : 100;
            base.highHighMessage = typeof alarmConfig.highHighMessage === "string" ? alarmConfig.highHighMessage : "High High alarm";
            base.highLimit = Number.isFinite(Number(alarmConfig.highLimit)) ? Number(alarmConfig.highLimit) : 80;
            base.highMessage = typeof alarmConfig.highMessage === "string" ? alarmConfig.highMessage : "High alarm";
            base.lowLimit = Number.isFinite(Number(alarmConfig.lowLimit)) ? Number(alarmConfig.lowLimit) : 20;
            base.lowMessage = typeof alarmConfig.lowMessage === "string" ? alarmConfig.lowMessage : "Low alarm";
            base.lowLowLimit = Number.isFinite(Number(alarmConfig.lowLowLimit)) ? Number(alarmConfig.lowLowLimit) : 0;
            base.lowLowMessage = typeof alarmConfig.lowLowMessage === "string" ? alarmConfig.lowLowMessage : "Low Low alarm";
        } else if (type === "digitalAlarm") {
            base.normalStateValue = Number.isFinite(Number(alarmConfig.normalStateValue)) ? Number(alarmConfig.normalStateValue) : 0;
            base.digitalMessage = typeof alarmConfig.digitalMessage === "string" ? alarmConfig.digitalMessage : "Digital alarm";
        }

        return base;
    }

    normalizeUser(userConfig) {
        if (!userConfig || typeof userConfig !== "object" || Array.isArray(userConfig)) {
            throw new Error("Each user must be an object");
        }

        const username = typeof userConfig.username === "string" ? userConfig.username.trim() : "";
        const passwordHash = typeof userConfig.passwordHash === "string" ? userConfig.passwordHash : "";
        const password = typeof userConfig.password === "string" ? userConfig.password : "";

        if (!username) {
            throw new Error("Each user requires a non-empty username");
        }

        if (!passwordHash && !password) {
            throw new Error("Each user requires a password or password hash");
        }

        return {
            username,
            password,
            passwordHash
        };
    }

    requiredName(entry, label) {
        if (!entry || typeof entry.name !== "string" || !entry.name.trim()) {
            throw new Error("Each " + label + " requires a non-empty name");
        }

        return entry.name.trim();
    }

    normalizeOptionalNodeId(nodeId) {
        return typeof nodeId === "string" ? nodeId.trim() : "";
    }

    normalizeNamespaceId(namespaceId) {
        if (namespaceId === undefined || namespaceId === null || namespaceId === "") {
            return 2;
        }

        const parsed = Number(namespaceId);
        if (!Number.isInteger(parsed) || parsed < 2) {
            throw new Error("Namespace id must be an integer greater than or equal to 2");
        }

        return parsed;
    }

    normalizeType(type) {
        const normalized = typeof type === "string" ? type.trim() : "";
        const aliases = {
            int16: "Int16",
            int32: "Int32",
            float: "Float",
            boolean: "Boolean",
            string: "String",
            bytestring: "ByteString"
        };
        const canonical = aliases[normalized.toLowerCase()] || normalized;
        if (!DATA_TYPE_MAP[canonical]) {
            throw new Error("Unsupported variable type: " + type);
        }

        return canonical;
    }

    normalizeAccess(access) {
        const normalized = typeof access === "string" ? access.toLowerCase() : "readonly";
        if (normalized === "rw") {
            return "readwrite";
        }
        if (normalized === "ro") {
            return "readonly";
        }
        if (normalized !== "readonly" && normalized !== "readwrite") {
            throw new Error("Unsupported access mode: " + access);
        }

        return normalized;
    }

    normalizeAllowAnonymous(value) {
        if (typeof value === "string") {
            return value !== "false";
        }

        return value !== false;
    }

    normalizeMaxConnections(value) {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) {
            return 10;
        }
        return parsed;
    }

    applySecuritySettings(policy, mode) {
        const rawPolicy = typeof policy === "string" ? policy.trim() : "None";
        const rawMode = typeof mode === "string" ? mode.trim() : "None";

        let securityPolicy = Object.prototype.hasOwnProperty.call(SECURITY_POLICY_MAP, rawPolicy)
            ? SECURITY_POLICY_MAP[rawPolicy]
            : SECURITY_POLICY_MAP.None;
        let securityMode = Object.prototype.hasOwnProperty.call(SECURITY_MODE_MAP, rawMode)
            ? SECURITY_MODE_MAP[rawMode]
            : SECURITY_MODE_MAP.None;

        if (securityMode === MessageSecurityMode.None) {
            securityPolicy = SecurityPolicy.None;
            if (rawPolicy !== "None") {
                this.node.warn("Security policy adjusted to None because security mode is None");
            }
        } else if (securityPolicy === SecurityPolicy.None) {
            securityPolicy = SecurityPolicy.Basic256Sha256;
            this.node.warn("Security policy adjusted to Basic256Sha256 because signed modes require a policy");
        }

        return {
            securityPolicy,
            securityMode
        };
    }

    coerceValue(value, type) {
        if (Array.isArray(value)) {
            return value.map((item) => this.coerceScalarValue(item, type));
        }

        if (typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
                try {
                    const parsed = JSON.parse(trimmed);
                    if (Array.isArray(parsed)) {
                        return parsed.map((item) => this.coerceScalarValue(item, type));
                    }
                } catch (error) {
                    throw new Error("Invalid array value for type " + type + ": " + error.message);
                }
            }
        }

        return this.coerceScalarValue(value, type);
    }

    coerceScalarValue(value, type) {
        if (type === "Int32") {
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) {
                return 0;
            }
            return Math.trunc(parsed);
        }

        if (type === "Float") {
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) {
                return 0;
            }
            return parsed;
        }

        if (type === "Boolean") {
            if (typeof value === "string") {
                const normalized = value.trim().toLowerCase();
                if (normalized === "false" || normalized === "0" || normalized === "") {
                    return false;
                }
                if (normalized === "true" || normalized === "1") {
                    return true;
                }
            }

            return Boolean(value);
        }

        return value === undefined || value === null ? "" : String(value);
    }
}

module.exports = {
    OpcUaServerConfigParser
};
