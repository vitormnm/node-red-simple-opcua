"use strict";

const servers = new Map();
const methodHandlers = new Map();
const pendingCalls = new Map();
const accessListeners = new Map();
const childs = new Map();
const activeAlarms = new Map();

const serversNames = new Map(); //get serve name for opcua-server-io

function registerServer(node) {
    servers.set(node.id, node);
}

function registerServerNames(node) {
    serversNames.set(node, node);
}


function registerChild(serverName, child) {
    if (!serverName || !child) {
        return;
    }

    childs.set(serverName, child);

    const cleanup = () => {
        if (childs.get(serverName) === child) {
            childs.delete(serverName);
        }
    };

    child.once("exit", cleanup);
    child.once("close", cleanup);
    child.once("disconnect", cleanup);
}

function unregisterServer(nodeId) {
    servers.delete(nodeId);
}

function unregisterServerNames(name) {
    serversNames.delete(name);
}


function resolveServer(reference) {
    const activeServers = Array.from(servers.values()).filter((node) => node && node.server);

    if (!reference) {
        if (activeServers.length === 1) {
            return activeServers[0];
        }
        return null;
    }

    const normalizedReference = String(reference).trim();
    return activeServers.find((node) =>
        node.id === normalizedReference ||
        node.name === normalizedReference ||
        node.serverName === normalizedReference
    ) || null;
}

function listActiveServers() {
    return Array.from(serversNames.values())

    // return Array.from(servers.values())
    //     .filter((node) => node && node.server)
    //     .map((node) => ({
    //         id: node.id,
    //         name: node.name || "",
    //         serverName: node.serverName || "",
    //         label: node.name || node.serverName || node.id,
    //         value: node.serverName || node.name || node.id
    //     }));
}

function resolveChild(serverName) {
    const child = childs.get(serverName);

    if (!child) {
        return null;
    }

    if (child.killed || child.exitCode !== null || child.channel === null || !child.connected) {
        childs.delete(serverName);
        return null;
    }

    return child;
}

function unregisterChild(serverName, child) {
    if (!serverName) {
        return;
    }

    if (child) {
        if (childs.get(serverName) === child) {
            childs.delete(serverName);
        }
        return;
    }

    childs.delete(serverName);
}

function registerMethodHandler(methodName, nodeId) {
    methodHandlers.set(methodName, nodeId);
}

function unregisterMethodHandler(methodName) {
    methodHandlers.delete(methodName);
}

function emitMethodCall(call) {
    const nodeId = methodHandlers.get(call.methodName);

    process.send({
        type: "sendMethod",
        data: call,
        nodeId: nodeId
    });
    //handler.sendMethodCall(call);
}

function waitForMethodResponse(callId) {
    return new Promise((resolve, reject) => {
        pendingCalls.set(callId, { resolve, reject });

        setTimeout(() => {
            if (pendingCalls.has(callId)) {
                pendingCalls.delete(callId);
                reject(new Error("Timeout waiting method response"));
            }
        }, 10000);
    });
}

function resolveMethodCall(callId, payload) {
    const pending = pendingCalls.get(callId);

    if (!pending) {
        return;
    }

    pending.resolve(payload);
    pendingCalls.delete(callId);
}

function registerAccessListener(listenerId, node) {
    accessListeners.set(listenerId, node);
}

// function registerActiveAlarms(alarm, node) {

// const lista = activeAlarms.get(node.id) ?? [];
// lista.push(alarm);
// activeAlarms.set(node.id, lista);


// }

function registerActiveAlarms(alarm, message, severity, retain, node) {


    const alarmNodeId = alarm.nodeId.toString();
    const lista = activeAlarms.get(node.id) ?? [];

    // remove antigo se já existir
    const novaLista = lista.filter(
        x => x.alarm.nodeId.toString() !== alarmNodeId
    );

    if (retain) {
        // adiciona novo
        novaLista.push({
            alarm,
            message,
            severity,
            retain
        });
    }

    // atualiza o map (com ou sem o alarme)
    activeAlarms.set(node.id, novaLista);
}

function getActiveAlarms(node) {
    try {


        var lista = activeAlarms.get(node.id) ?? [];
        var saida = []


        lista.forEach(element => {

            const alarmNode = element.alarm
            const ConditionName = alarmNode.getPropertyByName("ConditionName").readValue().value.value;
            const SourceName = alarmNode.getPropertyByName("SourceName").readValue().value.value;
            const isActive = alarmNode.activeState.id.readValue().value.value;
            const isAcked = alarmNode.ackedState.id.readValue().value.value;
            const ConfirmedState = alarmNode.confirmedState.id.readValue().value.value;



            saida.push({
                activeState: isActive,
                message: element.message,
                severity: element.severity,
                retain: element.retain,
                sourceName: SourceName,
                conditionName: ConditionName,
                ConfirmedState: ConfirmedState,
                ackedState: isAcked
            })
        });


        //  return activeAlarms.get(node.id) ?? [];
        return saida


    } catch (error) {
        console.error("getActiveAlarms")
        console.error(error)
    }

}

function unregisterAccessListener(listenerId) {
    accessListeners.delete(listenerId);
}

function emitTagAccess(event) {
    accessListeners.forEach((listener) => {
        if (!listener || typeof listener.enqueueAccessEvent !== "function") {
            return;
        }

        listener.enqueueAccessEvent(event);
    });
}

module.exports = {
    registerServer,
    registerServerNames,
    registerChild,
    unregisterChild,
    resolveChild,
    unregisterServer,
    unregisterServerNames,
    resolveServer,
    listActiveServers,
    registerMethodHandler,
    unregisterMethodHandler,
    emitMethodCall,
    waitForMethodResponse,
    resolveMethodCall,
    registerAccessListener,
    unregisterAccessListener,
    emitTagAccess,
    registerActiveAlarms,
    getActiveAlarms,
};
