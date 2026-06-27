"use strict";

module.exports = function (RED) {
    const registry = require("./opcua-server-registry");
    const { OpcUaServerConfigParser } = require("./lib/opcua-config");
    const { OpcUaServerRuntime } = require("./lib/opcua-server-runtime");

    const { fork } = require("child_process");
    const path = require("path");

    const getCertificatesFolder = (serverName) => {
        const safeServerName = (serverName || "default")
            .replace(/[\\/:\*\?"<>|]/g, "_")
            .replace(/^\.+$/, "");
        try {
            const userDir = (RED.settings && RED.settings.userDir) || path.join(require('os').homedir(), ".node-red");
            let flowFile = (RED.settings && RED.settings.flowFile) || "flows.json";
            if (typeof flowFile !== "string") {
                flowFile = "flows.json";
            }
            const flowFileFolder = path.isAbsolute(flowFile) ? path.dirname(flowFile) : path.join(userDir, path.dirname(flowFile));
            return path.join(flowFileFolder, "simple_opcua", "server", safeServerName);
        } catch (err) {
            return path.join(require('os').homedir(), ".node-red", "simple_opcua", "server", safeServerName);
        }
    };

    function OpcUaServerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const parser = new OpcUaServerConfigParser(node);
        const settings = parser.parseNodeConfig(config, this.credentials || {});
        settings.certificatesFolder = getCertificatesFolder(settings.serverName);



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
                reportError(node, "Input processing failed", error, msg);
                if (done) {
                    done();
                }
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




    function reportError(node, message, error, msg) {
        const details = error && error.message ? error.message : String(error);
        if (msg) {
            node.error(message + ": " + details, msg);
        } else {
            node.error(message + ": " + details);
        }
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

    RED.httpAdmin.get("/opc-ua-server/certificates", function (req, res) {
        const serverName = req.query.serverName || "default";
        const certificatesFolder = getCertificatesFolder(serverName);

        const fs = require("fs");
        const trustedDir = path.join(certificatesFolder, "trusted", "certs");
        const rejectedDir = path.join(certificatesFolder, "rejected");

        // Ensure directories exist
        try {
            if (!fs.existsSync(trustedDir)) {
                fs.mkdirSync(trustedDir, { recursive: true });
            }
            if (!fs.existsSync(rejectedDir)) {
                fs.mkdirSync(rejectedDir, { recursive: true });
            }
        } catch (e) {
            // Ignore directory creation errors (fallback to empty)
        }

        const listFiles = (dir) => {
            try {
                if (!fs.existsSync(dir)) {
                    return [];
                }
                return fs.readdirSync(dir).filter(file => {
                    const stats = fs.statSync(path.join(dir, file));
                    return stats.isFile() && (file.endsWith(".der") || file.endsWith(".pem") || file.endsWith(".crt"));
                });
            } catch (err) {
                return [];
            }
        };

        res.json({
            trusted: listFiles(trustedDir),
            rejected: listFiles(rejectedDir)
        });
    });

    RED.httpAdmin.post("/opc-ua-server/certificates/move", function (req, res) {
        const { serverName, filename, fromFolder, toFolder } = req.body;
        const certificatesFolder = getCertificatesFolder(serverName);

        const fs = require("fs");

        if (!filename || !fromFolder || !toFolder) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const getFolderDir = (folderName) => {
            if (folderName === "trusted") {
                return path.join(certificatesFolder, "trusted", "certs");
            }
            if (folderName === "rejected") {
                return path.join(certificatesFolder, "rejected");
            }
            return null;
        };

        const srcDir = getFolderDir(fromFolder);
        const destDir = getFolderDir(toFolder);

        if (!srcDir || !destDir) {
            return res.status(400).json({ error: "Invalid folders specified" });
        }

        const srcPath = path.join(srcDir, filename);
        const destPath = path.join(destDir, filename);

        try {
            if (!fs.existsSync(srcPath)) {
                return res.status(404).json({ error: "Source certificate not found" });
            }

            // Ensure destination directory exists
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }

            fs.renameSync(srcPath, destPath);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: "Failed to move certificate: " + err.message });
        }
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
