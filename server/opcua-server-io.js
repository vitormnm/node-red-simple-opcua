"use strict";

module.exports = function (RED) {
    const registry = require("./opcua-server-registry");

    RED.httpAdmin.get("/opcua-server-io/servers", RED.auth.needsPermission("flows.read"), function (req, res) {
        try {
            res.json(registry.listActiveServers());

        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });


    const path = require("path");






    function OpcUaServerIoNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;


        node.name = (config.name || "").trim();
        node.serverRef = (config.serverRef || "").trim();
        node.mode = config.mode || "read";
        node.identifierType = config.identifierType === "nodeId" ? "nodeId" : "path";
        node.tagPath = (config.tagPath || "").trim();
        node.tagNodeId = (config.tagNodeId || "").trim();
        node.methodName = (config.methodName || "").trim();
        node.intervalMs = normalizeInterval(config.intervalMs);
        node._childListenerAttached = false;
        node._attachedChild = null;
        node._childListenerRetry = null;

        const handler = (msg) => {
            onMessage(msg, node);
        };
        node._messageHandler = handler;

        attachChildListener(node, handler);
        ensureChildListener(node, handler);

        if (node.mode === "method-input") {
            registerMethodInput(node);
        }
        if (node.mode === "events") {
            registerEvents(node, { throwOnError: false, waitForServer: true, timeoutMs: 5000 });
        }
        if (node.mode === "status") {
            requestSnapshot(node, null, { throwOnError: false, waitForServer: true, timeoutMs: 5000 });
        }


        node.on("input", async function (msg, send, done) {
            try {
                send = send || function () {
                    node.send.apply(node, arguments);
                };

                if (node.mode === "read") {
                    await handleRead(node, msg, send);
                }

                if (node.mode === "write") {
                    await handleWrite(node, msg, send);
                }

                if (node.mode === "event") {
                    await handleEvent(node, msg, send);
                }

                if (node.mode === "activeAlarms") {
                    await handleActiveAlarms(node, msg, send);
                }

                if (node.mode === "method-output") {
                    await handleMethodOutput(node, msg, send);
                    done();
                    return;
                }
                if (node.mode === "events") {
                    await registerEvents(node, { waitForServer: true, timeoutMs: 5000 });
                }
                if (node.mode === "status") {
                    await requestSnapshot(node, msg, { waitForServer: true, timeoutMs: 5000 });
                }

                done();
            } catch (error) {
                node.status({ fill: "red", shape: "ring", text: node.mode + " failed" });
                done(error);
            }
        });

        node.on("close", function () {
            if (node._childListenerRetry) {
                clearInterval(node._childListenerRetry);
                node._childListenerRetry = null;
            }

            detachChildListener(node, handler);


            if (node.mode === "method-input") {
                registry.unregisterMethodHandler(node.methodName);
            }
            if (node.mode === "events") {
                registry.unregisterAccessListener(node.id);
            }
        });
    }

    function restoreBuffers(value) {
        // Formato exato que o Node.js IPC gera ao serializar um Buffer
        if (
            value !== null &&
            typeof value === "object" &&
            value.type === "Buffer" &&
            Array.isArray(value.data)
        ) {
            return Buffer.from(value.data);
        }

        return value;
    }

    function onMessage(msg, node) {
        if (msg.nodeId == node.id) {

            if (msg.type === "status") {

                node.status(msg.data);
            }

            if (msg.type === "send") {
                const data = msg.data;

                if (data && data.payload !== undefined) {
                    data.payload = restoreBuffers(data.payload);
                }

                // Strip internal _error tracking fields before forwarding to the flow
                if (Array.isArray(data && data.payload)) {
                    data.payload.forEach(item => {
                        if (item && typeof item === "object") delete item._error;
                    });
                }

                node.send(data);
            }

            if (msg.type === "error") {
                node.status(msg.data);
                node.error(msg.error);
            }

            if (msg.type === "partialError") {
                // Route failed items to catch node without changing the node status
                const catchMsg = Object.assign({}, msg.originalMsg || {}, {
                    payload: msg.failed,
                    error: msg.error
                });
                node.error(msg.error, catchMsg);
            }

            if (msg.type === "sendMethod") {

                node.status({
                    fill: "blue",
                    shape: "dot",
                    text: "method called"
                });

                node.send({
                    topic: msg.data.nodeId,
                    payload: msg.data.inputArguments,
                    opcua: {
                        server: msg.data.serverName,
                        method: msg.data.methodName,
                        data: msg.data
                    },
                    _callId: msg.data.callId
                });
            }

        }
    }


    function childControl(node) {

        const child = registry.resolveChild(node.serverRef)
        child.setMaxListeners(0);

        child.on("message", (msg) => {

            if (msg.type === "sendMethod") {

                node.status({
                    fill: "blue",
                    shape: "dot",
                    text: "method called"
                });

                node.send({
                    topic: msg.data.nodeId,
                    payload: msg.data.inputArguments,
                    opcua: {
                        server: msg.data.serverName,
                        method: msg.data.methodName,
                        data: msg.data
                    },
                    _callId: msg.data.callId
                });
            }
        });


        // if (child && !child._listenerAttached) {
        //     child._listenerAttached = true;

        // }
    }

    async function registerMethodInput(node) {
        await sendToChild(node, {
            type: "registerMethodInput",
            node: node,
            nodeId: node.id

        }, { throwOnError: false, waitForServer: true, timeoutMs: 5000 });
    }

    async function registerEvents(node, options) {
        return sendToChild(node, {
            type: "eventsServer",
            node: node,
            nodeId: node.id
        }, options);
    }

    async function requestSnapshot(node, msg, options) {
        return sendToChild(node, {
            type: "buildServerSnapshot",
            node: node,
            msg: msg,
            nodeId: node.id
        }, options);
    }


    async function handleWrite(node, msg) {

        // let serverName = null
        // if (msg.opcua.server === undefined) {
        //     serverName = node.serverRef
        // } else {
        //     serverName = msg.opcua.server
        // }

        await sendToChild(node, {
            type: "writeTagServer",
            msg: buildIoMessage(node, msg),
            node: node.id,
            nodeId: node.id,
        }, { waitForServer: true, timeoutMs: 5000 });
    }

    async function handleEvent(node, msg) {

        // let serverName = null
        // if (msg.opcua.server === undefined) {
        //     serverName = node.serverRef
        // } else {
        //     serverName = msg.opcua.server
        // }

        await sendToChild(node, {
            type: "writeEventServer",
            msg: msg,
            node: node.id,
            nodeId: node.id,
        }, { waitForServer: true, timeoutMs: 5000 });
    }

    async function handleActiveAlarms(node, msg) {

        // let serverName = null
        // if (msg.opcua.server === undefined) {
        //     serverName = node.serverRef
        // } else {
        //     serverName = msg.opcua.server
        // }

        await sendToChild(node, {
            type: "readActiveAlarms",
            msg: msg,
            node: node.id,
            nodeId: node.id,
        }, { waitForServer: true, timeoutMs: 5000 });
    }


    async function handleRead(node, msg) {
        // const server = resolveRegisteredServer(node, msg, registry);
        msg.opcua = msg.opcua || {};
        // msg.opcua.server = server.name || server.serverName || server.id;

        await sendToChild(node, {
            type: "readTagServer",
            msg: buildIoMessage(node, msg),
            node: node.id,
            nodeId: node.id,
        }, { waitForServer: true, timeoutMs: 5000 });
    }



    async function handleMethodOutput(node, msg, send) {
        await sendToChild(node, {
            type: "handleMethodOutput",
            msg: msg,
            node: node.id,
            nodeId: node.id,
        }, { waitForServer: true, timeoutMs: 5000 });
    }

    function buildIoMessage(node, msg) {
        const nextMsg = Object.assign({}, msg);
        nextMsg.opcuaServerIo = {
            identifierType: node.identifierType === "nodeId" ? "nodeId" : "path",
            tagPath: String(node.tagPath || "").trim(),
            tagNodeId: String(node.tagNodeId || "").trim()
        };
        return nextMsg;
    }

    function attachChildListener(node, handler) {
        const child = registry.resolveChild(node.serverRef);
        if (!child) {
            detachChildListener(node, handler);
            node.status({ fill: "yellow", shape: "ring", text: "waiting for server" });
            return false;
        }

        if (node._attachedChild === child && node._childListenerAttached) {
            return true;
        }

        detachChildListener(node, handler);
        child.on("message", handler);
        child.once("close", function () {
            if (node._attachedChild === child) {
                node._attachedChild = null;
                node._childListenerAttached = false;
                ensureChildListener(node, handler);
            }
        });
        child.once("exit", function () {
            if (node._attachedChild === child) {
                node._attachedChild = null;
                node._childListenerAttached = false;
                ensureChildListener(node, handler);
            }
        });
        child.once("disconnect", function () {
            if (node._attachedChild === child) {
                node._attachedChild = null;
                node._childListenerAttached = false;
                ensureChildListener(node, handler);
            }
        });
        node._attachedChild = child;
        node._childListenerAttached = true;

        if (node.mode === "method-input") {
            registerMethodInput(node);
        }

        return true;
    }

    function ensureChildListener(node, handler) {
        if (node._childListenerAttached || node._childListenerRetry) {
            return;
        }

        node._childListenerRetry = setInterval(function () {
            if (attachChildListener(node, handler)) {
                clearInterval(node._childListenerRetry);
                node._childListenerRetry = null;
            }
        }, 1000);
    }

    function detachChildListener(node, handler) {
        const child = node._attachedChild;
        if (!child) {
            node._childListenerAttached = false;
            node._attachedChild = null;
            return;
        }

        child.removeListener("message", handler);
        node._childListenerAttached = false;
        node._attachedChild = null;
    }

    function delay(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms);
        });
    }

    async function waitForChild(node, handler, timeoutMs) {
        var startedAt = Date.now();
        var timeout = timeoutMs || 5000;

        while ((Date.now() - startedAt) < timeout) {
            if (attachChildListener(node, handler)) {
                var child = registry.resolveChild(node.serverRef);
                if (child) {
                    return child;
                }
            }

            await delay(100);
        }

        return null;
    }

    function normalizeInterval(value) {
        const interval = Number(value);
        if (!Number.isFinite(interval) || interval <= 0) {
            return 500;
        }

        return Math.trunc(interval);
    }

    async function sendToChild(node, payload, options) {
        options = options || {};
        var handler = options.handler || node._messageHandler;
        if (options.ensureListener !== false) {
            attachChildListener(node, handler);
        }

        var child = registry.resolveChild(node.serverRef);

        if (!child && options.waitForServer) {
            node.status({ fill: "yellow", shape: "ring", text: "waiting for server" });
            child = await waitForChild(node, handler, options.timeoutMs);
        }

        if (!child) {
            const error = new Error("OPC UA server child process is not available for serverRef: " + node.serverRef);
            node.status({ fill: "red", shape: "ring", text: "server unavailable" });
            if (options.throwOnError === false) {
                node.error(error.message);
                return false;
            }
            throw error;
        }

        try {
            child.send(payload);
            if (node.mode !== "method-input") {
                node.status({ fill: "green", shape: "dot", text: "connected" });
            }
            return true;
        } catch (error) {
            node.status({ fill: "red", shape: "ring", text: "ipc unavailable" });
            node._childListenerAttached = false;
            node._attachedChild = null;
            ensureChildListener(node, handler);
            if (options.throwOnError === false) {
                node.error(error.message);
                return false;
            }
            throw error;
        }
    }




    OpcUaServerIoNode.prototype.sendMethodCall = function (call) {
        const node = this;

        node.status({
            fill: "blue",
            shape: "dot",
            text: "method called"
        });

        node.send({
            payload: call.inputArguments,
            opcua: {
                server: call.serverName,
                method: call.methodName
            },
            _callId: call.callId
        });
    };

    RED.nodes.registerType("opcua-server-io", OpcUaServerIoNode);
};
