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

        node.status({ fill: "yellow", shape: "ring", text: "initializing OPC UA server" });

        // diretório do arquivo atual (mais seguro)
        const workerPath = path.resolve(__dirname, 'lib', "opcua-server-runtime-child.js");


        const fork_parameter = {
            "node": node,
            "settings": settings
        }

        // const child = fork(workerPath, [JSON.stringify(fork_parameter)], {
        //     cwd: __dirname, // opcional, mas recomendado
        // });

        const child = fork(workerPath, {
            cwd: __dirname, // opcional, mas recomendado
        });



        registry.registerChild(node.serverName, child);

        registry.registerServerNames(node.serverName, node.serverName);

        child.on("exit", () => {
            registry.unregisterChild(node.serverName, child);
        });

        child.on("close", () => {
            registry.unregisterChild(node.serverName, child);
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
                if (msg.type === "status") {

                    node.status(msg.data); // aqui sim usa o node
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

    RED.nodes.registerType("opc-ua-server", OpcUaServerNode, {
        credentials: {
            username: { type: "text" },
            password: { type: "password" }
        }
    });
};
