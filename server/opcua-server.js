"use strict";

module.exports = function (RED) {
    const registry = require("./opcua-server-registry");
    const { OpcUaServerConfigParser } = require("./lib/opcua-config");
    const { OpcUaServerRuntime } = require("./lib/opcua-server-runtime");

    const { fork } = require("child_process");
    const path = require("path");

    function OpcUaServerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const parser = new OpcUaServerConfigParser(node);

        const settings = parser.parseNodeConfig(config, this.credentials || {});



        node.name = settings.name;
        node.serverName = settings.serverName;
        node.server = null;
        node.namespace = null;
        node.isClosing = false;

        node.status({ fill: "yellow", shape: "ring", text: "initializing OPC UA server" });

        // diretório do arquivo atual (mais seguro)
        const workerPath = path.resolve(__dirname, 'lib', "opcua-server-runtime-child.js");


        const fork_parameter = {
            "node": node,
            "settings": settings
        }


        const child = fork(workerPath, {
            cwd: __dirname, // opcional, mas recomendado
        });
        child.setMaxListeners(0);


        registry.registerChild(node.serverName, child);

        registry.registerServerNames(node.serverName, node.serverName);

        let crashHandled = false;
        function handleUnexpectedExit(code, signal) {
            if (node.isClosing || crashHandled) {
                return;
            }
            crashHandled = true;

            const errorDetails = `OPC UA server child process exited unexpectedly with code ${code} and signal ${signal}`;
            node.status({ fill: "red", shape: "dot", text: "Child process crashed" });

            const catchMsg = {
                topic: node.serverName,
                payload: {
                    status: "error",
                    error: errorDetails
                }
            };
            node.send(catchMsg);
            node.error(errorDetails, catchMsg);
        }

        child.on("exit", (code, signal) => {
            registry.unregisterChild(node.serverName, child);
            handleUnexpectedExit(code, signal);
        });

        child.on("close", (code, signal) => {
            registry.unregisterChild(node.serverName, child);
            handleUnexpectedExit(code, signal);
        });



        child.send({
            type: "createServer",
            config: config,
            node: node,
            nodeId: node.id,
            settings: settings
        });

        child.on("message", (msg) => {
            if (msg.nodeId == node.id) {

                if (msg.type === "send") {
                    node.send(msg.data);
                }

                if (msg.type === "status") {
                    node.status(msg.data);
                }

                if (msg.type === "log") {
                    node.log(msg.data);
                }

                if (msg.type === "errorUpdateServer") {
                    reportError(node, "Input processing failed", msg.data);
                }
            }
        });


        node.on("input", async function (msg, send, done) {
            send = send || function () {
                node.send.apply(node, arguments);
            };

            try {

                if (msg.payload !== undefined) {
                    child.send({
                        type: "updateServer",
                        msg: msg,
                        node: node,
                        nodeId: node.id,

                    });
                }



                done();
            } catch (error) {
                reportError(node, "Input processing failed", error);
                done(error);
            }
        });

        node.on("close", async function (removed, done) {
            try {
                node.isClosing = true;
                registry.unregisterChild(node.serverName, child);
                registry.unregisterServerNames(node.serverName);
                child.kill();

                done();
            } catch (error) {
                reportError(node, "Failed to stop OPC UA server", error);
                done(error);
            }
        });
    }




    function reportError(node, message, error) {
        const details = error && error.message ? error.message : String(error);
        node.error(message + ": " + details);
        node.status({ fill: "red", shape: "ring", text: message });
    }



    RED.httpAdmin.get("/opcua-server-resource/opcua-server.css", function (req, res) {
        const cssPath = path.join(__dirname, "view", "opcua-server.css");
        res.sendFile(cssPath);
    });

    RED.httpAdmin.get("/opcua-server-resource/opcua-server.js", function (req, res) {
        const jsPath = path.join(__dirname, "view", "opcua-server.js");
        res.sendFile(jsPath);
    });



    RED.nodes.registerType("opc-ua-server", OpcUaServerNode, {
        credentials: {
            username: { type: "text" },
            password: { type: "password" },
            users: { type: "text" },
            groups: { type: "text" }
        }
    });
};
