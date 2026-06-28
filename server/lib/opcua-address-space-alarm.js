const {
    StatusCodes,
    Variant,
    DataType
} = require("./opcua-constants");

class OpcUaAddressSpaceAlarm {

    constructor(options) {
        this.namespace = options.namespace;
        this.node = options.node;
        this.serverName = options.registry;
        this.registry = options.registry;
        this.alarmTypesByNamespace = new Map();
    }

    emitTagAccess(operation, details) {
        this.registry.emitTagAccess(Object.assign({
            operation,
            serverId: this.node.id,
            serverNodeName: this.node.name || "",
            serverName: this.serverName,
            timestamp: new Date().toISOString(),
            users: []
        }, details));
    }

    createAlarm(namespace, browseName, parentNode, inputNode, conditionName, nodeId, sourceName, alarmConfig) {
        try {
            const type = alarmConfig.type;
            let alarmNode = null;
            const alarmTypes = this.ensureNamespaceTypes(namespace);

            const config = {
                browseName: browseName,
                componentOf: parentNode,
                inputNode: inputNode,
                conditionSource: parentNode,
                conditionName: conditionName,
                normalState: false,
                nodeId: nodeId,
                description: alarmConfig.description || "",
                namespace: namespace,
                optionals: [
                    "ConfirmedState",
                    "Confirm"
                ]
            };

            if (type === "digitalAlarm") {
                alarmNode = namespace.instantiateAlarmCondition(alarmTypes.digitalAlarmType, config);
            }

            if (type === "levelAlarm") {
                alarmNode = namespace.instantiateAlarmCondition(alarmTypes.levelAlarmType, config);

                alarmNode.getPropertyByName("lowLowLimit")
                    .setValueFromSource({
                        dataType: DataType.Int32,
                        value: alarmConfig.lowLowLimit
                    });

                alarmNode.getPropertyByName("lowLimit")
                    .setValueFromSource({
                        dataType: DataType.Int32,
                        value: alarmConfig.lowLimit
                    });

                alarmNode.getPropertyByName("highHighLimit")
                    .setValueFromSource({
                        dataType: DataType.Int32,
                        value: alarmConfig.highHighLimit
                    });

                alarmNode.getPropertyByName("highLimit")
                    .setValueFromSource({
                        dataType: DataType.Int32,
                        value: alarmConfig.highLimit
                    });
            }

            alarmNode.getPropertyByName("enabled")
                .setValueFromSource({
                    dataType: DataType.Boolean,
                    value: alarmConfig.enabled
                });

            alarmNode.sourceName.setValueFromSource({
                dataType: DataType.String,
                value: sourceName
            });

            alarmNode.alarmConfig = alarmConfig;
            return alarmNode;
        } catch (error) {
            console.error("createAlarm");
            console.error(error);
        }
    }

    checkAlarm(alarm, variableValue) {
        if (alarm) {
            const alarmConfig = alarm.alarmConfig;
            const type = alarmConfig.type;

            if (type === "levelAlarm") {
                this.levelAlarm(alarm, variableValue);
            }
            if (type === "digitalAlarm") {
                this.digitalAlarm(alarm, variableValue);
            }
        }
    }

    levelAlarm(alarm, variableValue) {
        const alarmNode = alarm.node;
        const alarmConfig = alarm.alarmConfig;

        const isActive = alarmNode.activeState.id.readValue().value.value;
        const highHighSp = alarmNode.getPropertyByName("highHighLimit").readValue().value.value;
        const highSp = alarmNode.getPropertyByName("highLimit").readValue().value.value;
        const lowSp = alarmNode.getPropertyByName("lowLimit").readValue().value.value;
        const lowLowSp = alarmNode.getPropertyByName("lowLowLimit").readValue().value.value;
        const enabled = alarmNode.getPropertyByName("enabled").readValue().value.value;
        let lastMessage = null;
        let message = null;

        const sendValue = alarmConfig.sendValue !== false;

        if (variableValue >= highHighSp && enabled) {
            message = sendValue ? (alarmConfig.highHighMessage + ": " + variableValue) : alarmConfig.highHighMessage;
            this.raiseAlarm(alarmNode, message, alarmConfig.severity);
            lastMessage = message;
        } else if (variableValue >= highSp && enabled) {
            message = sendValue ? (alarmConfig.highMessage + ": " + variableValue) : alarmConfig.highMessage;
            this.raiseAlarm(alarmNode, message, alarmConfig.severity);
            lastMessage = message;
        } else if (variableValue <= lowLowSp && enabled) {
            message = sendValue ? (alarmConfig.lowLowMessage + ": " + variableValue) : alarmConfig.lowLowMessage;
            this.raiseAlarm(alarmNode, message, alarmConfig.severity);
            lastMessage = message;
        } else if (variableValue <= lowSp && enabled) {
            message = sendValue ? (alarmConfig.lowMessage + ": " + variableValue) : alarmConfig.lowMessage;
            this.raiseAlarm(alarmNode, message, alarmConfig.severity);
            lastMessage = message;
        } else if (isActive) {
            this.clearAlarm(alarmNode, lastMessage, alarmConfig.severity);
        }

        this.alarmMethods(alarmNode);
    }

    digitalAlarm(alarm, variableValue) {
        const alarmNode = alarm.node;
        const alarmConfig = alarm.alarmConfig;
        const enabled = alarmNode.getPropertyByName("enabled").readValue().value.value;

        if (variableValue && enabled) {
            this.raiseAlarm(alarmNode, alarmConfig.digitalMessage, alarmConfig.severity);
        } else {
            this.clearAlarm(alarmNode, alarmConfig.digitalMessage, alarmConfig.severity);
        }

        this.alarmMethods(alarmNode);
    }

    alarmMethods(alarmNode) {
        alarmNode.confirm.bindMethod((inputArguments, context, callback) => {
            const alarm = context.object;
            const severity = alarm.severity.readValue().value.value;
            const message = alarm.message.readValue().value.value.text;
            alarm.confirmedState.setValue(true);

            const isAcked = alarm.ackedState.id.readValue().value.value;

            if (isAcked) {
                alarm.raiseNewCondition({
                    message: message,
                    severity: severity,
                    retain: false
                });

                this.raiseNewConditionAlarm(alarm, message, severity, false, context);
            } else {
                this.raiseNewConditionAlarm(alarm, message, severity, true, context);
            }

            callback(null, {
                statusCode: StatusCodes.Good,
                outputArguments: []
            });
        });

        alarmNode.acknowledge.bindMethod((inputArguments, context, callback) => {
            const alarm = context.object;
            const severity = alarm.severity.readValue().value.value;
            const message = alarm.message.readValue().value.value.text;
            alarm.ackedState.setValue(true);
            alarm.confirmedState.setValue(false);

            this.raiseNewConditionAlarm(alarm, message, severity, true, context);

            callback(null, {
                statusCode: StatusCodes.Good,
                outputArguments: []
            });
        });

        alarmNode.addComment.bindMethod((inputArguments, context, callback) => {
            const comment = inputArguments[1].value;
            const alarm = context.object;

            alarm.comment.setValueFromSource({
                value: comment,
                dataType: DataType.LocalizedText
            });
            callback(null, {
                statusCode: StatusCodes.Good,
                outputArguments: []
            });
        });
    }

    clearAlarm(alarmNode, message, severity) {
        const isAcked = !alarmNode.ackedState.id.readValue().value.value;

        alarmNode.activeState.setValue(false);
        alarmNode.raiseNewCondition({ message, severity: severity, isAcked });

        this.raiseNewConditionAlarm(alarmNode, message, severity, isAcked);
    }

    raiseAlarm(alarmNode, message, severity, retain = true) {
        const isActive = alarmNode.activeState.id.readValue().value.value;
        const isAcked = alarmNode.ackedState.id.readValue().value.value;
        if (isActive && isAcked) {
            alarmNode.activeState.setValue(false);
            alarmNode.ackedState.setValue(true);
            alarmNode.confirmedState.setValue(true);
        } else {
            alarmNode.ackedState.setValue(false);
            alarmNode.confirmedState.setValue(true);
        }

        alarmNode.activeState.setValue(true);
        this.raiseNewConditionAlarm(alarmNode, message, severity, retain);
    }

    getUserGroups(username) {
        const normalized = String(username || "").trim();
        if (!normalized || normalized.toLowerCase() === "anonymous") {
            return [];
        }
        const users = (this.node && this.node.runtime && this.node.runtime.users) || [];
        const user = users.find(u => u && u.username === normalized);
        if (!user) {
            return [];
        }
        return typeof user.group === "string"
            ? user.group.split(",").map(g => g.trim()).filter(Boolean)
            : Array.isArray(user.group)
                ? user.group
                : [];
    }

    raiseNewConditionAlarm(alarmNode, message, severity, retain, context = null) {
        alarmNode.raiseNewCondition({ message, severity, retain });

        this.registry.registerActiveAlarms(alarmNode, message, severity, retain, this.node);

        const alarmConfig = alarmNode.alarmConfig || {};
        const sendValue = alarmConfig.sendValue !== false;

        const ConditionName = alarmNode.getPropertyByName("ConditionName").readValue().value.value;
        const SourceName = alarmNode.getPropertyByName("SourceName").readValue().value.value;
        const isActive = alarmNode.activeState.id.readValue().value.value;
        const isAcked = alarmNode.ackedState.id.readValue().value.value;
        const ConfirmedState = alarmNode.confirmedState.id.readValue().value.value;

        const users = [];
        if (context && context.session) {
            const session = context.session;
            const username = (session.userIdentityToken && session.userIdentityToken.userName)
                ? session.userIdentityToken.userName
                : "anonymous";
            const groups = this.getUserGroups(username);
            users.push({
                name: username,
                groups: groups
            });
        } else {
            users.push({
                name: "anonymous",
                groups: []
            });
        }

        this.emitTagAccess("alarm", {
            path: alarmNode.path || alarmNode.browseName.name,
            nodeID: alarmNode.nodeId.toString(),
            browseName: alarmNode.browseName.name,
            message: message,
            severity: severity,
            retain: retain,
            dataType: "alarm",
            value: sendValue ? "highHighSp" : null,
            activeState: isActive,
            sourceName: SourceName,
            conditionName: ConditionName,
            ConfirmedState: ConfirmedState,
            ackedState: isAcked,
            users: users,
            alarmNode: {
                nodeId: alarmNode.nodeId,
                browseName: alarmNode.browseName,
                displayName: alarmNode.displayName,
                description: alarmNode.description,
                nodeClass: alarmNode.nodeClass,
                typeDefinition: alarmNode.typeDefinition
            }
        });
    }

    ensureNamespaceTypes(namespace) {
        const namespaceKey = namespace.index;
        if (this.alarmTypesByNamespace.has(namespaceKey)) {
            return this.alarmTypesByNamespace.get(namespaceKey);
        }

        const types = this.createObjectType(namespace);
        this.alarmTypesByNamespace.set(namespaceKey, types);
        return types;
    }

    createObjectType(namespace) {
        const digitalAlarm = namespace.addObjectType({
            browseName: "digitalAlarm",
            subtypeOf: "OffNormalAlarmType"
        });

        const levelAlarm = namespace.addObjectType({
            browseName: "levelAlarm",
            subtypeOf: "OffNormalAlarmType"
        });

        namespace.addVariable({
            propertyOf: digitalAlarm,
            browseName: "enabled",
            dataType: "Boolean",
            modellingRule: "Mandatory",
            value: new Variant({ dataType: DataType.Boolean, value: true })
        });

        namespace.addVariable({
            propertyOf: levelAlarm,
            browseName: "enabled",
            dataType: "Boolean",
            modellingRule: "Mandatory",
            value: new Variant({ dataType: DataType.Boolean, value: true })
        });

        namespace.addVariable({
            propertyOf: levelAlarm,
            browseName: "highHighLimit",
            dataType: "Int32",
            modellingRule: "Mandatory",
            value: new Variant({ dataType: DataType.Int32, value: 0 })
        });

        namespace.addVariable({
            propertyOf: levelAlarm,
            browseName: "highLimit",
            dataType: "Int32",
            modellingRule: "Mandatory",
            value: new Variant({ dataType: DataType.Int32, value: 0 })
        });

        namespace.addVariable({
            propertyOf: levelAlarm,
            browseName: "lowLimit",
            dataType: "Int32",
            modellingRule: "Mandatory",
            value: new Variant({ dataType: DataType.Int32, value: 0 })
        });

        namespace.addVariable({
            propertyOf: levelAlarm,
            browseName: "lowLowLimit",
            dataType: "Int32",
            modellingRule: "Mandatory",
            value: new Variant({ dataType: DataType.Int32, value: 0 })
        });

        return {
            digitalAlarmType: digitalAlarm,
            levelAlarmType: levelAlarm
        };
    }
}

module.exports = { OpcUaAddressSpaceAlarm };
