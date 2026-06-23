"use strict";

const {
    DATA_TYPE_MAP,
    StatusCodes,
    Variant,
    VariantArrayType,
    sanitizeNodeIdPath,
    DataType,
    coerceNodeId,
    PermissionType,
    resolveNodeId
} = require("./opcua-constants");

const { OpcUaAddressSpaceAlarm } = require("./opcua-address-space-alarm")

class OpcUaAddressSpaceBuilder {
    constructor(options) {
        this.namespace = options.namespace;
        this.namespaces = options.namespaces || new Map([[2, this.namespace]]);
        this.server = options.server;
        this.registry = options.registry;
        this.node = options.node;
        this.serverName = options.serverName;
        const hasUsers = Array.isArray(options.users) && options.users.length > 0;
        this.authorizationDisabled = !hasUsers;
        this.nodeEntries = new Map();
        this.variableStore = new Map();
        this.variableNodeIdStore = new Map();
        this.objectTypeStore = new Map();
        this.alarmStore = new Map();
        this.pendingAlarms = [];

        this.addressSpace = options.addressSpace;



        this.addressSpaceAlarm = new OpcUaAddressSpaceAlarm({
            namespace: this.namespace,
            registry: this.registry,
            server: this.server,
            node: this.node
        });
    }

    rebuild(treeConfig) {

        this.sync(treeConfig, { fullReset: true });
    }

    sync(treeConfig, options) {
        if (!this.namespace || !this.server) {
            throw new Error("Address space is not initialized");
        }

        const settings = options || {};
        const desiredEntries = this.collectDesiredEntries(treeConfig);



        if (settings.fullReset) {
            this.clearDynamicNodes();
        }

        const removalRoots = this.collectRemovalRoots(desiredEntries);
        removalRoots.forEach((path) => this.removeSubtree(path));



        this.updateExistingNodes(desiredEntries);
        this.createMissingNodes(desiredEntries);
        this.flushPendingAlarms();

    }



    clearDynamicNodes() {
        const paths = Array.from(this.nodeEntries.keys()).sort(comparePathDepthDesc);

        paths.forEach((path) => this.removeSingleNode(path));
        this.nodeEntries.clear();
        this.variableStore.clear();
        this.variableNodeIdStore.clear();
        this.objectTypeStore.clear();
        if (this.enumerationStore) this.enumerationStore.clear();
        this.alarmStore.clear(); // Adicione esta linha
        this.pendingAlarms = [];
    }

    readValueByPath(path) {
        return this.getVariableRecordByPath(path).getValue();
    }

    readValueByNodeId(nodeId) {
        return this.getVariableRecordByNodeId(nodeId).getValue();
    }

    eventValueByPath(valuePayload) {

        const path = valuePayload.nodePath
        const value = valuePayload.value
        const message = valuePayload.message
        const severity = valuePayload.severity
        if (!this.nodeEntries.has(path)) {
            throw new Error("Unknown path: " + path);
        }

        const entry = this.nodeEntries.get(path);



        entry.node.raiseEvent("BaseEventType", {
            sourceName: {
                dataType: DataType.String,
                value: path
            },
            message: {
                dataType: DataType.LocalizedText,
                value: { text: message }
            },
            severity: {
                dataType: DataType.UInt16,
                value: severity
            }
        });

    }

    writeValueByPath(path, value) {
        return this.getVariableRecordByPath(path).setValue(value);
    }

    writeValueByNodeId(nodeId, value) {
        return this.getVariableRecordByNodeId(nodeId).setValue(value);
    }

    readValue(identifierType, identifier) {
        const record = this.getVariableRecord(identifierType, identifier);
        let val = record.getValue();
        if (record.type === "Int64" || record.type === "UInt64") {
            const convertToNumber = (v) => {
                const num = Number(v);
                return Number.isFinite(num) ? num : v;
            };
            if (record.isArray) {
                val = Array.isArray(val) ? val.map(convertToNumber) : convertToNumber(val);
            } else {
                val = convertToNumber(val);
            }
        }
        return val;
    }

    writeValue(identifierType, identifier, value) {
        return this.getVariableRecord(identifierType, identifier).setValue(value);
    }

    collectDesiredEntries(treeConfig) {
        const desiredEntries = new Map();
        const objectTypeConfigs = this.buildObjectTypeConfigMap(treeConfig);

        (Array.isArray(treeConfig.objectsTypes) ? treeConfig.objectsTypes : []).forEach((objectTypeConfig) => {
            this.collectObjectTypeDefinition(desiredEntries, objectTypeConfig, objectTypeConfigs);
        });

        (Array.isArray(treeConfig.enumerations) ? treeConfig.enumerations : []).forEach((enumerationConfig) => {
            this.collectEnumerationDefinition(desiredEntries, enumerationConfig);
        });

        (Array.isArray(treeConfig.folders) ? treeConfig.folders : []).forEach((folderConfig) => {
            this.collectBranch(desiredEntries, "folder", folderConfig, "", "organizedBy", objectTypeConfigs);
        });

        (Array.isArray(treeConfig.objects) ? treeConfig.objects : []).forEach((objectConfig) => {
            this.collectBranch(desiredEntries, "object", objectConfig, "", "organizedBy", objectTypeConfigs);
        });

        return desiredEntries;
    }

    buildObjectTypeConfigMap(treeConfig) {
        const objectTypeConfigs = new Map();

        (Array.isArray(treeConfig.objectsTypes) ? treeConfig.objectsTypes : []).forEach((objectTypeConfig) => {
            if (objectTypeConfigs.has(objectTypeConfig.name)) {
                throw new Error("Duplicate object type name: " + objectTypeConfig.name);
            }
            objectTypeConfigs.set(objectTypeConfig.name, objectTypeConfig);
        });

        return objectTypeConfigs;
    }

    collectObjectTypeDefinition(desiredEntries, config, objectTypeConfigs) {
        const path = this.buildObjectTypePath(config.name);
        desiredEntries.set(path, this.buildEntryDefinition("objectTypeDefinition", config, path, "", "typeDefinition"));
        this.collectBranchChildren(desiredEntries, config, path, "componentOf", objectTypeConfigs, {
            skipAlarms: false,
            preserveCollectionNames: true,
            typeRootPath: path
        });
    }

    collectEnumerationDefinition(desiredEntries, config) {
        const path = this.buildEnumerationPath(config.name);
        desiredEntries.set(path, this.buildEntryDefinition("enumeration", config, path, "", "typeDefinition"));
    }

    collectBranch(desiredEntries, kind, config, parentPath, relationship, objectTypeConfigs, options) {
        const settings = options || {};
        const path = settings.preserveCollectionNames
            ? this.buildCollectionPath(parentPath, kind === "folder" ? "folders" : "objects", config.name)
            : this.buildPath(parentPath, config.name);
        desiredEntries.set(path, this.buildEntryDefinition(kind, config, path, parentPath, relationship));
        this.collectBranchChildren(
            desiredEntries,
            config,
            path,
            kind === "folder" ? "organizedBy" : "componentOf",
            objectTypeConfigs,
            settings
        );
    }

    collectBranchChildren(desiredEntries, config, path, childRelationship, objectTypeConfigs, options) {
        const settings = options || {};
        const preserveCollectionNames = !!settings.preserveCollectionNames;
        (Array.isArray(config.folders) ? config.folders : []).forEach((folderConfig) => {
            this.collectBranch(
                desiredEntries,
                "folder",
                folderConfig,
                path,
                childRelationship,
                objectTypeConfigs,
                settings
            );
        });

        (Array.isArray(config.objects) ? config.objects : []).forEach((objectConfig) => {
            this.collectBranch(
                desiredEntries,
                "object",
                objectConfig,
                path,
                childRelationship,
                objectTypeConfigs,
                settings
            );
        });

        (Array.isArray(config.variables) ? config.variables : []).forEach((variableConfig) => {
            const childPath = preserveCollectionNames
                ? this.buildCollectionPath(path, "variables", variableConfig.name)
                : this.buildPath(path, variableConfig.name);
            desiredEntries.set(
                childPath,
                this.buildEntryDefinition("variable", variableConfig, childPath, path, "componentOf")
            );
        });

        (Array.isArray(config.methods) ? config.methods : []).forEach((methodConfig) => {
            const childPath = preserveCollectionNames
                ? this.buildCollectionPath(path, "methods", methodConfig.name)
                : this.buildPath(path, methodConfig.name);
            desiredEntries.set(
                childPath,
                this.buildEntryDefinition("method", methodConfig, childPath, path, "componentOf")
            );
        });

        (Array.isArray(config.objectsTypes) ? config.objectsTypes : []).forEach((objectTypeInstanceConfig) => {
            this.collectObjectTypeInstance(
                desiredEntries,
                objectTypeInstanceConfig,
                path,
                childRelationship,
                objectTypeConfigs,
                settings
            );
        });

        if (!settings.skipAlarms) {
            //alarmes
            (Array.isArray(config.alarms) ? config.alarms : []).forEach((alarmConfig) => {
                const childPath = preserveCollectionNames
                    ? this.buildCollectionPath(path, "alarms", alarmConfig.name)
                    : this.buildPath(path, alarmConfig.name);

                desiredEntries.set(
                    childPath,
                    this.buildEntryDefinition("alarm", alarmConfig, childPath, path, "componentOf")
                );
                //this.addAlarmPlaceholder(path, alarmConfig);
            });
        }
    }

    collectObjectTypeInstance(desiredEntries, instanceConfig, parentPath, relationship, objectTypeConfigs, options) {
        const path = this.buildPath(parentPath, instanceConfig.name);
        desiredEntries.set(
            path,
            this.buildEntryDefinition("objectTypeInstance", instanceConfig, path, parentPath, relationship)
        );
        // Variables, methods and nested objectsTypes inherited from the type definition
        // are instantiated automatically by node-opcua when addObject({ typeDefinition })
        // is called. We must NOT add them as independent desiredEntries — that would
        // create duplicate nodes on top of the ones the lib already created.
        // Only extra children defined directly on the instance (not inherited) are added here.
        const instanceOnlyConfig = {
            folders: Array.isArray(instanceConfig.folders) ? instanceConfig.folders : [],
            objects: Array.isArray(instanceConfig.objects) ? instanceConfig.objects : [],
            variables: Array.isArray(instanceConfig.variables) ? instanceConfig.variables : [],
            methods: Array.isArray(instanceConfig.methods) ? instanceConfig.methods : [],
            alarms: Array.isArray(instanceConfig.alarms) ? instanceConfig.alarms : [],
            objectsTypes: Array.isArray(instanceConfig.objectsTypes) ? instanceConfig.objectsTypes : []
        };
        this.collectBranchChildren(desiredEntries, instanceOnlyConfig, path, "componentOf", objectTypeConfigs, Object.assign({}, options, {
            skipAlarms: false,
            preserveCollectionNames: false
        }));
    }

    expandObjectTypeInstanceConfig(instanceConfig, objectTypeConfigs, stack) {
        const typeName = instanceConfig.objectsType;
        if (stack.indexOf(typeName) !== -1) {
            throw new Error("Circular object type reference: " + stack.concat(typeName).join(" -> "));
        }

        const baseConfig = objectTypeConfigs.get(typeName);
        if (!baseConfig) {
            throw new Error("Unknown object type: " + typeName);
        }

        return this.mergeObjectTypeConfigs(baseConfig, instanceConfig, objectTypeConfigs, stack.concat(typeName));
    }

    mergeObjectTypeConfigs(baseConfig, instanceConfig, objectTypeConfigs, stack) {
        const merged = {
            name: instanceConfig.name,
            displayName: instanceConfig.displayName || instanceConfig.name,
            description: instanceConfig.description || "",
            folders: this.cloneConfigs(baseConfig.folders),
            objects: this.cloneConfigs(baseConfig.objects),
            variables: this.cloneConfigs(baseConfig.variables),
            methods: this.cloneConfigs(baseConfig.methods),
            alarms: this.cloneConfigs(baseConfig.alarms),
            objectsTypes: []
        };

        const baseInstances = Array.isArray(baseConfig.objectsTypes) ? baseConfig.objectsTypes : [];
        const instanceOverrides = Array.isArray(instanceConfig.objectsTypes) ? instanceConfig.objectsTypes : [];

        merged.objectsTypes = baseInstances
            .map((nestedInstanceConfig) => this.mergeNestedObjectTypeInstance(nestedInstanceConfig, objectTypeConfigs, stack))
            .concat(this.cloneConfigs(instanceOverrides));

        merged.folders = merged.folders.concat(this.cloneConfigs(instanceConfig.folders));
        merged.objects = merged.objects.concat(this.cloneConfigs(instanceConfig.objects));
        merged.variables = merged.variables.concat(this.cloneConfigs(instanceConfig.variables));
        merged.methods = merged.methods.concat(this.cloneConfigs(instanceConfig.methods));
        merged.alarms = merged.alarms.concat(this.cloneConfigs(instanceConfig.alarms));

        return merged;
    }

    mergeNestedObjectTypeInstance(instanceConfig, objectTypeConfigs, stack) {
        const cloned = this.cloneConfig(instanceConfig);
        if (cloned && cloned.objectsType) {
            const typeName = cloned.objectsType;
            if (stack.indexOf(typeName) !== -1) {
                throw new Error("Circular object type reference: " + stack.concat(typeName).join(" -> "));
            }
            if (!objectTypeConfigs.has(typeName)) {
                throw new Error("Unknown object type: " + typeName);
            }
        }
        return cloned;
    }

    cloneConfigs(items) {
        return Array.isArray(items) ? items.map((item) => this.cloneConfig(item)) : [];
    }

    cloneConfig(item) {
        return item ? JSON.parse(JSON.stringify(item)) : item;
    }

    rewriteAlarmVariablePaths(branchConfig, currentPath, rootInstancePath) {
        if (!branchConfig || typeof branchConfig !== "object") {
            return;
        }

        (Array.isArray(branchConfig.alarms) ? branchConfig.alarms : []).forEach((alarmConfig) => {
            const variableNodeId = String(alarmConfig.variableNodeId || "").trim();
            if (!variableNodeId) {
                return;
            }

            if (variableNodeId.indexOf(".") === 0) {
                alarmConfig.variableNodeId = this.resolveObjectTypeRelativeReference(rootInstancePath, variableNodeId);
                return;
            }

            if (variableNodeId.indexOf(currentPath + ".") === 0 || variableNodeId === currentPath) {
                return;
            }

            if (variableNodeId.indexOf(rootInstancePath + ".") === 0 || variableNodeId === rootInstancePath) {
                return;
            }

            if (variableNodeId.indexOf("__objectTypes.") === 0) {
                return;
            }

            alarmConfig.variableNodeId = currentPath + "." + variableNodeId;
        });

        (Array.isArray(branchConfig.folders) ? branchConfig.folders : []).forEach((folderConfig) => {
            this.rewriteAlarmVariablePaths(folderConfig, this.buildPath(currentPath, folderConfig.name), rootInstancePath);
        });

        (Array.isArray(branchConfig.objects) ? branchConfig.objects : []).forEach((objectConfig) => {
            this.rewriteAlarmVariablePaths(objectConfig, this.buildPath(currentPath, objectConfig.name), rootInstancePath);
        });
    }

    buildEntryDefinition(kind, config, path, parentPath, relationship) {
        return {
            kind,
            path,
            parentPath,
            relationship,
            config,
            signature: this.buildSignature(kind, config, parentPath, relationship)
        };
    }

    normalizeAccessPermissions(config) {
        const rawPermissions = config && (config.accessPermission || config.accessPermissions);
        if (!Array.isArray(rawPermissions) || !rawPermissions.length) {
            return ["public"];
        }

        const seen = new Set();
        const normalized = rawPermissions.reduce((result, value) => {
            const permission = String(value || "").trim().toLowerCase();
            if (!permission || seen.has(permission)) {
                return result;
            }
            seen.add(permission);
            result.push(permission);
            return result;
        }, []);

        return normalized.length ? normalized : ["public"];
    }

    resolvePermissionRoleId(permission) {
        const normalized = String(permission || "").trim().toLowerCase();
        if (!normalized) {
            return null;
        }

        const wellKnownRoles = {
            public: ["WellKnownRole_Anonymous", "WellKnownRole_AuthenticatedUser"],
            anonymous: ["WellKnownRole_Anonymous"],
            authenticated: ["WellKnownRole_AuthenticatedUser"],
            authenticateduser: ["WellKnownRole_AuthenticatedUser"],
            operator: ["WellKnownRole_Operator"],
            supervisor: ["WellKnownRole_Supervisor"],
            engineer: ["WellKnownRole_Engineer"],
            engineering: ["WellKnownRole_Engineer"],
            observer: ["WellKnownRole_Observer"],
            admin: ["WellKnownRole_ConfigureAdmin"],
            configureadmin: ["WellKnownRole_ConfigureAdmin"],
            securityadmin: ["WellKnownRole_SecurityAdmin"]
        };

        if (wellKnownRoles[normalized]) {
            return wellKnownRoles[normalized].map((roleId) => resolveNodeId(roleId));
        }

        return [resolveNodeId("ns=1;s=NodeRedRole/" + this.sanitizeRoleSegment(normalized))];
    }

    sanitizeRoleSegment(value) {
        return String(value || "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "_")
            .replace(/[^a-z0-9._-]/g, "_");
    }

    buildPermissionMask(kind, config) {
        if (kind === "method") {
            return PermissionType.Browse | PermissionType.Call;
        }

        const basePermissions = PermissionType.Browse | PermissionType.Read;
        if (kind === "alarm") {
            return basePermissions | PermissionType.ReceiveEvents;
        }

        if (kind === "variable" && config && config.access === "readwrite") {
            return basePermissions | PermissionType.Write;
        }

        return basePermissions;
    }

    buildRolePermissions(kind, config) {
        if (this.authorizationDisabled) {
            return undefined;
        }

        const permissions = this.normalizeAccessPermissions(config);
        const permissionMask = this.buildPermissionMask(kind, config);
        const rolePermissions = [];
        const seen = new Set();

        permissions.forEach((permission) => {
            const roleIds = this.resolvePermissionRoleId(permission);
            (roleIds || []).forEach((roleId) => {
                const key = coerceNodeId(roleId).toString();
                if (seen.has(key)) {
                    return;
                }
                seen.add(key);
                rolePermissions.push({
                    roleId,
                    permissions: permissionMask
                });
            });
        });

        return rolePermissions.length ? rolePermissions : undefined;
    }

    buildSignature(kind, config, parentPath, relationship) {
        if (kind === "variable") {
            return JSON.stringify({
                kind,
                parentPath,
                relationship,
                nodeId: config.nodeId || "",
                namespaceId: this.resolveNamespaceId(config),
                displayName: config.displayName || config.name,
                description: config.description || "",
                type: config.type,
                access: config.access,
                isArray: this.isArrayValue(config.value),
                accessPermission: this.normalizeAccessPermissions(config)
            });
        }

        if (kind === "method") {
            return JSON.stringify({
                kind,
                parentPath,
                relationship,
                nodeId: config.nodeId || "",
                namespaceId: this.resolveNamespaceId(config),
                displayName: config.displayName || config.name,
                description: config.description || "",
                accessPermission: this.normalizeAccessPermissions(config),
                inputs: Array.isArray(config.inputs) ? config.inputs : [],
                outputs: Array.isArray(config.outputs) ? config.outputs : []
            });
        }

        if (kind === "objectTypeInstance") {
            return JSON.stringify({
                kind,
                parentPath,
                relationship,
                nodeId: config.nodeId || "",
                namespaceId: this.resolveNamespaceId(config),
                displayName: config.displayName || config.name,
                description: config.description || "",
                accessPermission: this.normalizeAccessPermissions(config),
                objectsType: config.objectsType
            });
        }

        return JSON.stringify({
            kind,
            parentPath,
            relationship,
            nodeId: config.nodeId || "",
            namespaceId: this.resolveNamespaceId(config),
            displayName: config.displayName || config.name,
            description: config.description || "",
            accessPermission: this.normalizeAccessPermissions(config)
        });
    }

    collectRemovalRoots(desiredEntries) {
        const candidates = [];

        this.nodeEntries.forEach((entry, path) => {
            const desired = desiredEntries.get(path);

            if (!desired) {
                candidates.push(path);
                return;
            }

            if (entry.kind !== desired.kind || entry.signature !== desired.signature) {
                candidates.push(path);
            }
        });

        return collapsePaths(candidates);
    }

    updateExistingNodes(desiredEntries) {
        desiredEntries.forEach((desired, path) => {
            const existing = this.nodeEntries.get(path);
            if (!existing || existing.kind !== desired.kind) {
                return;
            }

            if (existing.kind === "variable") {
                const record = this.variableStore.get(path);
                if (record) {
                    record.setRuntimeValue(desired.config.value);
                }
            }
        });
    }

    createMissingNodes(desiredEntries) {
        const ordered = Array.from(desiredEntries.values()).sort(compareEntryCreationOrder);
        ordered.forEach((definition) => {
            if (this.nodeEntries.has(definition.path)) {
                return;
            }

            this.createNode(definition);
        });
    }

    createNode(definition) {
        const parentNode = this.resolveParentNode(definition.parentPath);



        if (definition.kind === "folder") {
            this.addFolder(parentNode, definition.config, definition.parentPath, definition.relationship, definition.path);
            return;
        }

        if (definition.kind === "objectTypeDefinition") {

            this.addObjectTypeDefinition(definition.config);
            return;
        }

        if (definition.kind === "enumeration") {
            this.addEnumerationTypeDefinition(definition.config);
            return;
        }

        if (definition.kind === "object") {
            this.addObject(parentNode, definition.config, definition.parentPath, definition.relationship, definition.path);
            return;
        }

        if (definition.kind === "objectTypeInstance") {
            this.addObjectTypeInstance(parentNode, definition.config, definition.parentPath, definition.relationship, definition.path);
            return;
        }

        if (definition.kind === "alarm") {
            this.addAlarm(parentNode, definition.config, definition.parentPath, definition.relationship, definition.path);
            return;

        }

        if (definition.kind === "variable") {
            this.addVariable(parentNode, definition.config, definition.parentPath, definition.path);
            return;
        }

        if (definition.kind === "method") {
            this.addMethod(parentNode, definition.config, definition.parentPath, definition.path);
        }


    }

    resolveParentNode(parentPath) {
        if (!parentPath) {
            return this.server.engine.addressSpace.rootFolder.objects;
        }

        const parentEntry = this.nodeEntries.get(parentPath);
        if (!parentEntry || !parentEntry.node) {
            throw new Error("Parent node is not available for path: " + parentPath);
        }

        return parentEntry.node;
    }

    removeSubtree(rootPath) {
        const affectedPaths = Array.from(this.nodeEntries.keys())
            .filter((path) => isSamePathOrDescendant(path, rootPath))
            .sort(comparePathDepthDesc);

        affectedPaths.forEach((path) => this.removeSingleNode(path));
    }

    removeSingleNode(path) {
        const entry = this.nodeEntries.get(path);
        if (!entry) {
            return;
        }

        if (entry.kind === "variable") {
            const record = this.variableStore.get(path);
            if (record && record.nodeIdKey) {
                this.variableNodeIdStore.delete(record.nodeIdKey);
            }
            this.variableStore.delete(path);
        }

        if (entry.kind === "objectTypeDefinition") {
            this.objectTypeStore.delete(entry.config.name);
        }

        if (entry.kind === "enumeration" && this.enumerationStore) {
            this.enumerationStore.delete(entry.config.name);
        }

        try {
            entry.namespace.deleteNode(entry.node);

        } catch (error) {
            console.error("error removeSingleNode")
            console.error(error)
            this.node.debug("Ignoring deleteNode error for " + path + ": " + error.message);
        }



        this.nodeEntries.delete(path);
    }

    addObject(parentNode, objectConfig, parentPath, relationship, pathOverride) {
        const namespace = this.getNamespaceForConfig(objectConfig);

        const addressSpace = this.server.engine.addressSpace;
        const serverNode = addressSpace.rootFolder.objects.server;


        const objectName = objectConfig.name;
        const nextPath = pathOverride || this.buildPath(parentPath, objectName);
        const options = {
            browseName: objectConfig.displayName || objectName,
            displayName: objectConfig.displayName || objectName,
            description: objectConfig.description || "",
            nodeId: this.resolveNodeId(objectConfig, nextPath, namespace),
            rolePermissions: this.buildRolePermissions("object", objectConfig),
            eventNotifier: 1, //enabled_events,
            eventSourceOf: serverNode
        };

        if (relationship === "organizedBy") {
            options.organizedBy = parentNode;
        } else {
            options.componentOf = parentNode;
        }

        if (this.isObjectTypePath(parentPath)) {
            options.modellingRule = "Mandatory";
        }

        const objectNode = namespace.addObject(options);
        this.registerNodeEntry("object", nextPath, parentPath, relationship, objectConfig, objectNode, namespace);
    }

    addObjectTypeDefinition(objectTypeConfig) {
        const namespace = this.getNamespaceForConfig(objectTypeConfig);
        const objectTypeNode = namespace.addObjectType({
            browseName: objectTypeConfig.name,
            displayName: objectTypeConfig.displayName || objectTypeConfig.name,
            description: objectTypeConfig.description || "",
            nodeId: this.resolveNodeId(objectTypeConfig, this.buildObjectTypePath(objectTypeConfig.name), namespace),
            rolePermissions: this.buildRolePermissions("objectTypeDefinition", objectTypeConfig),
            subtypeOf: "BaseObjectType"
        });


        const path = this.buildObjectTypePath(objectTypeConfig.name);



        this.registerNodeEntry("objectTypeDefinition", path, "", "typeDefinition", objectTypeConfig, objectTypeNode, namespace);
        this.objectTypeStore.set(objectTypeConfig.name, {
            node: objectTypeNode,
            config: objectTypeConfig,
            path: path,
            namespace: namespace
        });
    }

    addEnumerationTypeDefinition(config) {
        const namespace = this.getNamespaceForConfig(config);
        const enumTypeNode = namespace.addEnumerationType({
            browseName: config.displayName || config.name,
            displayName: config.displayName || config.name,
            description: config.description || "",
            nodeId: this.resolveNodeId(config, this.buildEnumerationPath(config.name), namespace),
            enumeration: config.enumeration
        });

        const path = this.buildEnumerationPath(config.name);

        this.registerNodeEntry("enumeration", path, "", "typeDefinition", config, enumTypeNode, namespace);
        if (!this.enumerationStore) this.enumerationStore = new Map();
        this.enumerationStore.set(config.name, {
            node: enumTypeNode,
            config: config,
            path: path,
            namespace: namespace
        });
    }

    addObjectTypeInstance(parentNode, instanceConfig, parentPath, relationship, pathOverride) {
        const objectTypeEntry = this.objectTypeStore.get(instanceConfig.objectsType);
        if (!objectTypeEntry || !objectTypeEntry.node) {
            throw new Error("Object type is not available for instance " + instanceConfig.name + ": " + instanceConfig.objectsType);
        }

        const objectName = instanceConfig.name;
        const nextPath = pathOverride || this.buildPath(parentPath, objectName);
        const namespace = this.getNamespaceForConfig(instanceConfig);

        const options = {
            browseName: instanceConfig.displayName || objectName,
            displayName: instanceConfig.displayName || objectName,
            description: instanceConfig.description || "",
            nodeId: this.resolveNodeId(instanceConfig, nextPath, namespace),
            rolePermissions: this.buildRolePermissions("objectTypeInstance", instanceConfig),
            typeDefinition: objectTypeEntry.node.nodeId,
            eventNotifier: 1
        };

        if (relationship === "organizedBy") {
            options.organizedBy = parentNode;
        } else {
            options.componentOf = parentNode;
        }

        const objectNode = namespace.addObject(options);
        this.registerNodeEntry("objectTypeInstance", nextPath, parentPath, relationship, instanceConfig, objectNode, namespace);

        // Create the inherited children explicitly using the configs that opcua-config.js
        // already rewrote with the correct instance nodeIds (e.g. server1.newObjectType.cmd_on).
        // We do NOT call instantiate() because node-opcua cannot auto-assign nodeIds for the
        // cloned children when the type children already have explicit string nodeIds registered.
        this.createInheritedChildren(objectNode, nextPath, instanceConfig, namespace);
    }

    createInheritedChildren(instanceNode, instancePath, instanceConfig, namespace) {
        const typeEntry = this.objectTypeStore.get(instanceConfig.objectsType);
        if (!typeEntry) return;

        // Extract the type's nodeId value prefix (e.g. "Motor_type2") and the
        // instance's nodeId value prefix (e.g. "server1.newObjectType") so we can
        // rewrite every child nodeId from the type to the instance on-the-fly.
        const typeNodeId = typeEntry.config.nodeId || "";
        const instanceNodeId = instanceConfig.nodeId || "";
        const typePrefix = this.extractNodeIdStringValue(typeNodeId);
        const instancePrefix = this.extractNodeIdStringValue(instanceNodeId);

        this.createInheritedBranchChildren(typeEntry.config, instanceNode, instancePath, typePrefix, instancePrefix);
    }

    extractNodeIdStringValue(nodeId) {
        const m = String(nodeId || "").match(/(?:^|;)[si]=(.+)$/);
        return m ? m[1] : "";
    }

    rewriteInheritedNodeId(nodeId, typePrefix, instancePrefix) {
        if (!nodeId || !typePrefix || !instancePrefix) return nodeId;
        const m = String(nodeId).match(/^(ns=\d+;[si]=)([\s\S]*)$/);
        if (m && m[2].startsWith(typePrefix)) {
            return m[1] + instancePrefix + m[2].slice(typePrefix.length);
        }
        return nodeId;
    }

    createInheritedBranchChildren(typeConfig, parentOpcNode, parentPath, typePrefix, instancePrefix) {
        const variables = Array.isArray(typeConfig.variables) ? typeConfig.variables : [];
        const methods = Array.isArray(typeConfig.methods) ? typeConfig.methods : [];
        const folders = Array.isArray(typeConfig.folders) ? typeConfig.folders : [];
        const objects = Array.isArray(typeConfig.objects) ? typeConfig.objects : [];

        variables.forEach((varConfig) => {
            const childPath = this.buildPath(parentPath, varConfig.name);
            const rewrittenConfig = Object.assign({}, varConfig, {
                nodeId: this.rewriteInheritedNodeId(varConfig.nodeId, typePrefix, instancePrefix)
            });
            this.addVariable(parentOpcNode, rewrittenConfig, parentPath, childPath);
        });

        methods.forEach((methodConfig) => {
            const childPath = this.buildPath(parentPath, methodConfig.name);
            const rewrittenConfig = Object.assign({}, methodConfig, {
                nodeId: this.rewriteInheritedNodeId(methodConfig.nodeId, typePrefix, instancePrefix)
            });
            this.addMethod(parentOpcNode, rewrittenConfig, parentPath, childPath);
        });

        folders.forEach((folderConfig) => {
            const childPath = this.buildPath(parentPath, folderConfig.name);
            const rewrittenConfig = Object.assign({}, folderConfig, {
                nodeId: this.rewriteInheritedNodeId(folderConfig.nodeId, typePrefix, instancePrefix)
            });
            this.addFolder(parentOpcNode, rewrittenConfig, parentPath, "componentOf", childPath);
            const childNode = this.nodeEntries.get(childPath) && this.nodeEntries.get(childPath).node;
            if (childNode) {
                this.createInheritedBranchChildren(folderConfig, childNode, childPath, typePrefix, instancePrefix);
            }
        });

        objects.forEach((objectConfig) => {
            const childPath = this.buildPath(parentPath, objectConfig.name);
            const rewrittenConfig = Object.assign({}, objectConfig, {
                nodeId: this.rewriteInheritedNodeId(objectConfig.nodeId, typePrefix, instancePrefix)
            });
            this.addObject(parentOpcNode, rewrittenConfig, parentPath, "componentOf", childPath);
            const childNode = this.nodeEntries.get(childPath) && this.nodeEntries.get(childPath).node;
            if (childNode) {
                this.createInheritedBranchChildren(objectConfig, childNode, childPath, typePrefix, instancePrefix);
            }
        });
    }

    addAlarm(parentNode, alarmConfig, parentPath, relationship, pathOverride) {



        try {

            const name = alarmConfig.name;
            const variableNodeId = alarmConfig.variableNodeId;
            const objectName = alarmConfig.name;
            const nextPath = pathOverride || this.buildPath(parentPath, objectName);
            const path = pathOverride || this.buildPath(parentPath, name);
            const namespace = this.getNamespaceForConfig(alarmConfig);
            const options = {
                browseName: alarmConfig.displayName || objectName,
                displayName: alarmConfig.displayName || objectName,
                description: alarmConfig.description || "",
                nodeId: this.resolveNodeId(alarmConfig, nextPath, namespace),
                eventNotifier: 1 //enabled_events
            };

            if (relationship === "organizedBy") {
                options.organizedBy = parentNode;
            } else {
                options.componentOf = parentNode;
            }

            const variableToMonitor = this.resolveAlarmVariableRecord(parentPath, parentNode, variableNodeId)

            const sourceName = variableToMonitor.node.displayName[0].text

            const browseName = alarmConfig.displayName || objectName
            const inputNode = variableToMonitor.node



            const conditionName = alarmConfig.displayName || objectName
            const nodeId = this.resolveNodeId(alarmConfig, nextPath, namespace)

            const alarmNode = this.addressSpaceAlarm.createAlarm(namespace, browseName, parentNode, inputNode, conditionName, nodeId, sourceName, alarmConfig)
            const alarmRolePermissions = this.buildRolePermissions("alarm", alarmConfig);
            if (alarmNode && alarmRolePermissions) {
                alarmNode.setRolePermissions(alarmRolePermissions);
            }




            // register alarm
            variableToMonitor.alarm = {
                node: alarmNode,
                alarmConfig: alarmConfig,
            }
            // const alarmNode = this.namespace.instantiateOffNormalAlarm(options);
            this.registerNodeEntry("alarm", nextPath, parentPath, relationship, alarmConfig, alarmNode, namespace);




        } catch (error) {

            if (error && error.message && error.message.indexOf("Unknown alarm variable reference:") === 0) {
                this.queuePendingAlarm(parentNode, alarmConfig, parentPath, relationship);
                return;
            }
            console.error("erro addAlarm")
            console.error(error)
        }


    }

    queuePendingAlarm(parentNode, alarmConfig, parentPath, relationship) {
        const path = this.buildPath(parentPath, alarmConfig.name);
        const alreadyQueued = this.pendingAlarms.some((item) => item.path === path);
        if (alreadyQueued) {
            return;
        }

        this.pendingAlarms.push({
            path: path,
            parentNode: parentNode,
            alarmConfig: this.cloneConfig(alarmConfig),
            parentPath: parentPath,
            relationship: relationship
        });
    }

    flushPendingAlarms() {
        if (!this.pendingAlarms.length) {
            return;
        }

        const pending = this.pendingAlarms.slice();
        this.pendingAlarms = [];

        pending.forEach((item) => {
            if (this.nodeEntries.has(item.path)) {
                return;
            }

            this.addAlarm(item.parentNode, item.alarmConfig, item.parentPath, item.relationship);
        });

        if (this.pendingAlarms.length) {
            const unresolved = this.pendingAlarms.map((item) => item.path).join(", ");
            this.pendingAlarms = [];
            throw new Error("Unresolved alarms after build: " + unresolved);
        }
    }




    addFolder(parentNode, folderConfig, parentPath, relationship, pathOverride) {
        const namespace = this.getNamespaceForConfig(folderConfig);

        const addressSpace = this.server.engine.addressSpace;
        const serverNode = addressSpace.rootFolder.objects.server;

        const folderName = folderConfig.name;
        const nextPath = pathOverride || this.buildPath(parentPath, folderName);
        const options = {
            browseName: folderConfig.displayName || folderName,
            displayName: folderConfig.displayName || folderName,
            description: folderConfig.description || "",
            nodeId: this.resolveNodeId(folderConfig, nextPath, namespace),
            rolePermissions: this.buildRolePermissions("folder", folderConfig),
            typeDefinition: "FolderType",
            eventSourceOf: serverNode,
            eventNotifier: 1 //enabled_events
        };

        if (relationship === "organizedBy") {
            options.organizedBy = parentNode;
        } else {
            options.componentOf = parentNode;
        }

        if (this.isObjectTypePath(parentPath)) {
            options.modellingRule = "Mandatory";
        }

        const folderNode = namespace.addObject(options);
        this.registerNodeEntry("folder", nextPath, parentPath, relationship, folderConfig, folderNode, namespace);
    }

    resolveDataType(type) {
        if (DATA_TYPE_MAP[type]) return DATA_TYPE_MAP[type];
        if (this.enumerationStore && this.enumerationStore.has(type)) {
            return this.enumerationStore.get(type).node.nodeId;
        }
        return type;
    }

    addVariable(parentNode, variableConfig, parentPath, pathOverride) {
        const namespace = this.getNamespaceForConfig(variableConfig);
        const name = variableConfig.name;
        const type = variableConfig.type;
        const access = variableConfig.access;
        const path = pathOverride || this.buildPath(parentPath, name);
        const nodeId = this.resolveNodeId(variableConfig, path, namespace);
        const browseName = variableConfig.displayName || name;
        let initialValue = variableConfig.value;
        if (browseName === "AcceptAllCertificates" && this.server && this.server.serverCertificateManager) {
            initialValue = this.server.serverCertificateManager.automaticallyAcceptUnknownCertificate;
        }
        const state = {
            type,
            access,
            isArray: this.isArrayValue(initialValue),
            currentValue: this.coerceValue(initialValue, type, this.isArrayValue(initialValue))
        };

        const variableNode = namespace.addVariable({
            componentOf: parentNode,
            browseName,
            displayName: browseName,
            description: variableConfig.description || "",
            nodeId,
            rolePermissions: this.buildRolePermissions("variable", variableConfig),
            dataType: this.resolveDataType(type),
            modellingRule: this.isObjectTypePath(parentPath) ? "Mandatory" : undefined,
            valueRank: state.isArray ? 1 : -1,
            accessLevel: access === "readwrite" ? "CurrentRead | CurrentWrite" : "CurrentRead",
            userAccessLevel: access === "readwrite" ? "CurrentRead | CurrentWrite" : "CurrentRead",
            minimumSamplingInterval: 500,
            value: {
                get: () => {
                    if (browseName === "AcceptAllCertificates" && this.server && this.server.serverCertificateManager) {
                        state.currentValue = this.server.serverCertificateManager.automaticallyAcceptUnknownCertificate;
                    }
                    this.emitTagAccess("read", {
                        path,
                        nodeID: nodeId,
                        browseName,
                        dataType: state.type,
                        value: state.currentValue
                    });

                    let val = state.currentValue;
                    if (state.type === "Int64" || state.type === "UInt64") {
                        const bigIntToInt64Array = (v) => {
                            let bigintVal;
                            try {
                                bigintVal = BigInt(v);
                            } catch (e) {
                                bigintVal = 0n;
                            }
                            const mask = 0xFFFFFFFFFFFFFFFFn;
                            bigintVal = bigintVal & mask;

                            const high = Number(bigintVal >> 32n);
                            const low = Number(bigintVal & 0xFFFFFFFFn);
                            return [high, low];
                        };

                        if (state.isArray) {
                            val = Array.isArray(val) ? val.map(bigIntToInt64Array) : [bigIntToInt64Array(val)];
                        } else {
                            val = bigIntToInt64Array(val);
                        }
                    }

                    const variantOptions = {
                        dataType: DATA_TYPE_MAP[state.type] || DataType.Int32,
                        value: val
                    };

                    // ByteString nunca e array - Buffer nao deve ser VariantArrayType.Array
                    if (state.type !== "ByteString" && this.isArrayValue(state.currentValue)) {
                        variantOptions.arrayType = VariantArrayType.Array;
                    } else if (state.type === "Int64" || state.type === "UInt64") {
                        variantOptions.arrayType = VariantArrayType.Scalar;
                    }

                    return new Variant(variantOptions);
                },
                set: (variant) => {
                    if (state.access !== "readwrite") {
                        return StatusCodes.BadNotWritable;
                    }

                    try {
                        state.currentValue = this.coerceValue(variant.value, state.type, state.isArray);
                        this.emitTagAccess("write", {
                            path,
                            nodeID: nodeId,
                            browseName,
                            dataType: state.type,
                            value: state.currentValue
                        });

                        if (browseName === "AcceptAllCertificates" && this.server && this.server.serverCertificateManager) {
                            this.server.serverCertificateManager.automaticallyAcceptUnknownCertificate = !!state.currentValue;
                            console.log(`AcceptAllCertificates updated by client to: ${state.currentValue}`);
                            console.log(`Server Certificate Manager automaticallyAcceptUnknownCertificate is now: ${this.server.serverCertificateManager.automaticallyAcceptUnknownCertificate}`);
                        }

                        const alarm = this.variableStore.get(path).alarm
                        this.addressSpaceAlarm.checkAlarm(alarm, variant.value)

                        return StatusCodes.Good;
                    } catch (error) {
                        console.error("addVariable")
                        console.error(error)
                        // this.node.warn("Rejected OPC UA write for " + path + ": " + error.message);
                        return StatusCodes.BadTypeMismatch;
                    }
                }
            }
        });

        this.registerNodeEntry("variable", path, parentPath, "componentOf", variableConfig, variableNode, namespace);
        const record = {
            node: variableNode,
            path: path,
            nodeId: nodeId,
            nodeIdKey: this.normalizeNodeIdKey(nodeId),
            type: state.type,
            isArray: state.isArray,
            getValue: () => state.currentValue,
            setRuntimeValue: (nextValue) => {
                state.currentValue = this.coerceValue(nextValue, state.type, state.isArray);
                return state.currentValue;
            },
            setValue: (nextValue) => {
                if (state.access !== "readwrite") {
                    throw new Error("Tag is read-only: " + path);
                }

                state.currentValue = this.coerceValue(nextValue, state.type, state.isArray);

                const alarm = this.variableStore.get(path).alarm
                this.addressSpaceAlarm.checkAlarm(alarm, state.currentValue)

                return state.currentValue;
            }
        };
        this.variableStore.set(path, record);
        this.variableNodeIdStore.set(record.nodeIdKey, record);
    }





    addMethod(parentNode, methodConfig, parentPath, pathOverride) {
        const namespace = this.getNamespaceForConfig(methodConfig);
        const methodName = methodConfig.name;
        const path = pathOverride || this.buildPath(parentPath, methodName);
        const nodeId = this.resolveNodeId(methodConfig, path, namespace)
        const methodNode = namespace.addMethod(parentNode, {
            browseName: methodConfig.displayName || methodName,
            displayName: methodConfig.displayName || methodName,
            description: { text: methodConfig.description || "" },
            nodeId: nodeId,
            rolePermissions: this.buildRolePermissions("method", methodConfig),
            modellingRule: this.isObjectTypePath(parentPath) ? "Mandatory" : undefined,
            inputArguments: methodConfig.inputs.map((arg) => ({
                name: arg.name,
                description: { text: arg.description || "" },
                dataType: DATA_TYPE_MAP[arg.type]
            })),
            outputArguments: methodConfig.outputs.map((arg) => ({
                name: arg.name,
                description: { text: arg.description || "" },
                dataType: DATA_TYPE_MAP[arg.type]
            }))
        });

        methodNode.bindMethod((inputArguments, context, callback) => {
            const callId = Date.now() + "_" + Math.random();

            this.registry.emitMethodCall({
                methodName: methodConfig.name,
                nodeId: nodeId,
                callId,
                inputArguments,
                outputArguments: methodConfig.outputs.map((arg) => ({
                    name: arg.name,
                    description: { text: arg.description || "" },
                    dataType: DATA_TYPE_MAP[arg.type]
                })),
                serverName: this.serverName
            });

            this.registry.waitForMethodResponse(callId)
                .then((outputs) => {
                    callback(null, {
                        statusCode: StatusCodes.Good,
                        outputArguments: outputs.map((output) => new Variant(output))
                    });
                })
                .catch(() => {
                    callback(null, {
                        statusCode: StatusCodes.BadInternalError
                    });
                });
        });

        this.registerNodeEntry("method", path, parentPath, "componentOf", methodConfig, methodNode, namespace);
    }

    addAlarmPlaceholder(parentPath, alarmConfig) {
        const path = this.buildPath(parentPath, alarmConfig.name);
        this.node.debug("Alarm definition received but not implemented yet: " + path + " (" + alarmConfig.type + ")");
    }

    registerNodeEntry(kind, path, parentPath, relationship, config, node, namespace) {
        this.nodeEntries.set(path, {
            kind,
            path,
            parentPath,
            relationship,
            config,
            signature: this.buildSignature(kind, config, parentPath, relationship),
            node,
            namespace
        });
    }

    buildPath(parentPath, name) {
        return parentPath ? parentPath + "." + name : name;
    }

    buildObjectTypePath(name) {
        return "__objectTypes." + name;
    }

    buildEnumerationPath(name) {
        return "__enumerations." + name;
    }

    buildCollectionPath(parentPath, collectionName, name) {

        // return parentPath ? parentPath + "." + collectionName + "." + name : collectionName + "." + name;
        //change nodeId path
        return parentPath ? parentPath + "." + name : name + "." + name;

    }

    isObjectTypePath(path) {
        return String(path || "").indexOf("__objectTypes.") === 0;
    }

    buildStableNodeId(path, namespace) {
        return "ns=" + namespace.index + ";s=" + sanitizeNodeIdPath(path);
    }

    resolveNodeId(config, path, namespace) {
        const customNodeId = config && typeof config.nodeId === "string" ? config.nodeId.trim() : "";
        return customNodeId || this.buildStableNodeId(path, namespace);
    }

    resolveNamespaceId(config) {
        const namespaceId = config && config.namespaceId !== undefined ? Number(config.namespaceId) : 2;
        return Number.isInteger(namespaceId) && namespaceId >= 2 ? namespaceId : 2;
    }

    getNamespaceForConfig(config) {
        const namespaceId = this.resolveNamespaceId(config);
        if (!this.namespaces.has(namespaceId)) {
            throw new Error("Namespace " + namespaceId + " is not available");
        }

        return this.namespaces.get(namespaceId);
    }

    emitTagAccess(operation, details) {
        let val = details.value;
        if (details.dataType === "Int64" || details.dataType === "UInt64") {
            const convertToNumber = (v) => {
                const num = Number(v);
                return Number.isFinite(num) ? num : v;
            };
            const isArray = this.isArrayValue(val);
            if (isArray) {
                const items = this.extractArrayItems(val);
                val = Array.isArray(items) ? items.map(convertToNumber) : convertToNumber(val);
            } else {
                val = convertToNumber(val);
            }
        }

        this.registry.emitTagAccess({
            operation,
            serverId: this.node.id,
            serverNodeName: this.node.name || "",
            serverName: this.serverName,
            timestamp: new Date().toISOString(),
            path: details.path,
            nodeID: details.nodeID,
            browseName: details.browseName,
            dataType: details.dataType,
            value: val
        });
    }

    getVariableRecord(identifierType, identifier) {
        if (identifierType === "nodeId") {
            return this.getVariableRecordByNodeId(identifier);
        }

        return this.getVariableRecordByPath(identifier);
    }

    getVariableRecordByPath(path) {
        if (!this.variableStore.has(path)) {
            throw new Error("Unknown path: " + path);
        }

        return this.variableStore.get(path);
    }

    getVariableRecordByNodeId(nodeId) {
        const key = this.normalizeNodeIdKey(nodeId);
        if (!this.variableNodeIdStore.has(key)) {
            throw new Error("Unknown nodeId: " + nodeId);
        }

        return this.variableNodeIdStore.get(key);
    }

    normalizeNodeIdKey(nodeId) {
        return coerceNodeId(nodeId).toString();
    }

    resolveAlarmVariableRecord(parentPath, parentNode, variableNodeId) {
        const reference = String(variableNodeId || "").trim();
        if (!reference) {
            throw new Error("Alarm variableNodeId is required");
        }

        if (reference.indexOf(".") === 0) {
            const relativeReference = this.resolveObjectTypeRelativeReference(parentPath, reference);

            //not work
            var corrente = parentNode.getComponentByName("corrent")

            return {
                node: corrente
            }
            if (this.variableStore.has(relativeReference)) {
                return this.variableStore.get(relativeReference);
            }
        }

        if (this.variableStore.has(reference)) {
            return this.variableStore.get(reference);
        }

        try {
            return this.getVariableRecordByNodeId(reference);
        } catch (error) {
            // ignore and continue with path heuristics
        }

        const stringNodeIdPath = this.extractStringNodeIdPath(reference);
        if (stringNodeIdPath) {
            if (this.variableStore.has(stringNodeIdPath)) {
                return this.variableStore.get(stringNodeIdPath);
            }

            const relativeStringNodeIdPath = this.buildPath(parentPath, stringNodeIdPath);
            if (this.variableStore.has(relativeStringNodeIdPath)) {
                return this.variableStore.get(relativeStringNodeIdPath);
            }
        }

        const relativePath = this.buildPath(parentPath, reference);
        if (this.variableStore.has(relativePath)) {
            return this.variableStore.get(relativePath);
        }

        const suffixMatches = Array.from(this.variableStore.entries())
            .filter(([path]) => {
                return path === reference ||
                    path.indexOf("." + reference) !== -1 ||
                    (stringNodeIdPath && (path === stringNodeIdPath || path.indexOf("." + stringNodeIdPath) !== -1));
            });

        if (suffixMatches.length === 1) {
            return suffixMatches[0][1];
        }

        throw new Error("Unknown alarm variable reference: " + reference);
    }

    extractStringNodeIdPath(reference) {
        const match = /^ns=\d+;s=(.+)$/.exec(String(reference || "").trim());
        return match ? match[1] : "";
    }

    resolveObjectTypeRelativeReference(rootInstancePath, reference) {
        const tokens = String(reference || "")
            .trim()
            .replace(/^\.+/, "")
            .split(".")
            .filter((token) => token !== "")
            .map((token) => this.normalizeCollectionToken(token));

        if (!tokens.length) {
            return rootInstancePath;
        }

        return rootInstancePath + "." + tokens.join(".");
    }

    normalizeCollectionToken(token) {
        const normalized = String(token || "").trim().toLowerCase();
        const aliases = {
            variaveis: "variables",
            variables: "variables",
            objetos: "objects",
            objects: "objects",
            pastas: "folders",
            folders: "folders",
            metodos: "methods",
            methods: "methods",
            alarmes: "alarms",
            alarms: "alarms",
            objecttypes: "objectsTypes",
            objectstypes: "objectsTypes",
            tiposobjetos: "objectsTypes"
        };

        return aliases[normalized] || token;
    }

    coerceValue(value, type, expectArray) {
        // ByteString nunca e array - Buffer/Uint8Array tratados diretamente
        if (type === "ByteString") {
            return this.coerceScalarValue(value, type);
        }

        if (expectArray) {
            const items = this.extractArrayItems(value);
            if (!items) {
                throw new Error("Expected array value for type " + type);
            }

            return items.map((item) => this.coerceScalarValue(item, type));
        }

        if (typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
                try {
                    const parsed = JSON.parse(trimmed);
                    if (Array.isArray(parsed)) {
                        throw new Error("Expected scalar value for type " + type + " but received array");
                    }
                } catch (error) {
                    if (error.message.indexOf("Expected scalar value") === 0) {
                        throw error;
                    }

                    throw new Error("Invalid array value for type " + type + ": " + error.message);
                }
            }
        }

        if (this.extractArrayItems(value)) {
            if ((type === "Int64" || type === "UInt64") && Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number") {
                // Do not throw, this is a standard scalar Int64/UInt64 represented as [high, low]
            } else {
                throw new Error("Expected scalar value for type " + type + " but received array");
            }
        }

        return this.coerceScalarValue(value, type);
    }

    coerceScalarValue(value, type) {

        if (type === "Int16") {
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) {
                return 0;
            }
            return Math.trunc(parsed);
        }


        if (type === "Int32") {
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) {
                return 0;
            }
            return Math.trunc(parsed);
        }

        if (type === "Int64") {
            const minVal = -9223372036854775808n;
            const maxVal = 9223372036854775807n;
            if (Array.isArray(value) && value.length === 2) {
                try {
                    const h = BigInt(value[0]);
                    const l = BigInt(value[1]);
                    const signMask = 1n << 31n;
                    const shiftHigh = 1n << 32n;
                    let bigintVal;
                    if ((h & signMask) === signMask) {
                        bigintVal = (h & ~signMask) * shiftHigh + l - 0x8000000000000000n;
                    } else {
                        bigintVal = h * shiftHigh + l;
                    }
                    if (bigintVal < minVal) bigintVal = minVal;
                    else if (bigintVal > maxVal) bigintVal = maxVal;
                    return String(bigintVal);
                } catch (error) {
                    return "0";
                }
            }
            try {
                let bigintVal = BigInt(value);
                if (bigintVal < minVal) bigintVal = minVal;
                else if (bigintVal > maxVal) bigintVal = maxVal;
                return String(bigintVal);
            } catch (error) {
                const parsed = Number(value);
                if (Number.isFinite(parsed)) {
                    try {
                        let bigintVal = BigInt(Math.trunc(parsed));
                        if (bigintVal < minVal) bigintVal = minVal;
                        else if (bigintVal > maxVal) bigintVal = maxVal;
                        return String(bigintVal);
                    } catch (e2) {
                        return "0";
                    }
                }
                return "0";
            }
        }

        if (type === "UInt64") {
            const minVal = 0n;
            const maxVal = 18446744073709551615n;
            if (Array.isArray(value) && value.length === 2) {
                try {
                    const h = BigInt(value[0]);
                    const l = BigInt(value[1]);
                    const shiftHigh = 1n << 32n;
                    let bigintVal = h * shiftHigh + l;
                    if (bigintVal < minVal) bigintVal = minVal;
                    else if (bigintVal > maxVal) bigintVal = maxVal;
                    return String(bigintVal);
                } catch (error) {
                    return "0";
                }
            }
            try {
                let bigintVal = BigInt(value);
                if (bigintVal < minVal) bigintVal = minVal;
                else if (bigintVal > maxVal) bigintVal = maxVal;
                return String(bigintVal);
            } catch (error) {
                const parsed = Number(value);
                if (Number.isFinite(parsed)) {
                    try {
                        let bigintVal = BigInt(Math.trunc(parsed));
                        if (bigintVal < minVal) bigintVal = minVal;
                        else if (bigintVal > maxVal) bigintVal = maxVal;
                        return String(bigintVal);
                    } catch (e2) {
                        return "0";
                    }
                }
                return "0";
            }
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

        if (type === "ByteString") {
            if (Buffer.isBuffer(value)) {
                return value;
            }
            if (value instanceof Uint8Array) {
                return Buffer.from(value);
            }
            if (typeof value === "string") {
                return Buffer.from(value, "base64");
            }
            if (Array.isArray(value)) {
                return Buffer.from(value);
            }
            return Buffer.alloc(0);
        }

        return value === undefined || value === null ? "" : String(value);
    }

    isArrayValue(value) {
        return this.extractArrayItems(value) !== null;
    }

    extractArrayItems(value) {
        if (Array.isArray(value)) {
            return value;
        }

        if (typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
                const parsed = JSON.parse(trimmed);
                return Array.isArray(parsed) ? parsed : null;
            }
            return null;
        }

        if (ArrayBuffer.isView(value)) {
            return Array.from(value);
        }

        return null;
    }
}

function collapsePaths(paths) {
    return Array.from(new Set(paths))
        .sort(comparePathDepthAsc)
        .filter((path, index, ordered) => {
            for (let current = 0; current < index; current += 1) {
                if (isSamePathOrDescendant(path, ordered[current])) {
                    return false;
                }
            }
            return true;
        });
}

function isSamePathOrDescendant(path, rootPath) {
    return path === rootPath || path.indexOf(rootPath + ".") === 0;
}

function comparePathDepthAsc(left, right) {
    return pathDepth(left) - pathDepth(right);
}

function comparePathDepthDesc(left, right) {
    return pathDepth(right) - pathDepth(left);
}

function pathDepth(path) {
    return String(path || "").split(".").length;
}

function compareEntryCreationOrder(left, right) {
    const depthDelta = pathDepth(left.path) - pathDepth(right.path);
    if (depthDelta !== 0) {
        return depthDelta;
    }

    return kindRank(left.kind) - kindRank(right.kind);
}

function kindRank(kind) {
    if (kind === "objectTypeDefinition" || kind === "enumeration") {
        return -1;
    }
    if (kind === "folder") {
        return 0;
    }
    if (kind === "object") {
        return 1;
    }
    if (kind === "objectTypeInstance") {
        return 1;
    }
    if (kind === "variable") {
        return 2;
    }
    if (kind === "method") {
        return 3;
    }
    if (kind === "alarm") {
        return 4;
    }
    return 10;
}

module.exports = {
    OpcUaAddressSpaceBuilder
};
