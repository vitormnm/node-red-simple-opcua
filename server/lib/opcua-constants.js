"use strict";

const os = require("os");
const opcua = require("node-opcua");

const {
    OPCUAServer,
    Variant,
    DataType,
    StatusCodes,
    SecurityPolicy,
     VariantArrayType,
    MessageSecurityMode,
    UserTokenType,
    coerceNodeId ,
    resolveNodeId,
    PermissionType,
    makeRoles,
    WellKnownRoles,
    OPCUACertificateManager,
} = opcua;

const DEFAULT_PORT = 4840;
const DEFAULT_SERVER_NAME = "Node-RED OPC UA Server";
const DEFAULT_NAMESPACE_URI = "urn:node-red:opc-ua-server";
const DEFAULT_RESOURCE_PATH = "/";

const SECURITY_POLICY_MAP = {
    None: SecurityPolicy.None,
    Basic128Rsa15: SecurityPolicy.Basic128Rsa15,
    Basic256: SecurityPolicy.Basic256,
    Basic256Sha256: SecurityPolicy.Basic256Sha256,
    Aes128_Sha256_RsaOaep: SecurityPolicy.Aes128_Sha256_RsaOaep,
    Aes256_Sha256_RsaPss: SecurityPolicy.Aes256_Sha256_RsaPss
};

const SECURITY_MODE_MAP = {
    None: MessageSecurityMode.None,
    Sign: MessageSecurityMode.Sign,
    SignAndEncrypt: MessageSecurityMode.SignAndEncrypt
};

const DATA_TYPE_MAP = {
    Int16: DataType.Int16,
    UInt16: DataType.UInt16,
    Int32: DataType.Int32,
    UInt32: DataType.UInt32,
    Int64: DataType.Int64,
    Float: DataType.Float,
    Boolean: DataType.Boolean,
    String: DataType.String,
    ByteString : DataType.ByteString,
    LocalizedText : DataType.LocalizedText
};

function normalizePort(port) {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return DEFAULT_PORT;
    }

    return parsed;
}

function buildApplicationUri(serverName) {
    const host = os.hostname() || "localhost";
    return "urn:" + host + ":node-red:" + sanitizeUriSegment(serverName);
}

function sanitizeUriSegment(value) {
    return String(value || "opc-ua-server")
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9:_-]/g, "")
        .toLowerCase();
}

function sanitizeNodeIdPath(path) {
    return String(path || "")
        .split(".")
        .map((segment) => sanitizeNodeIdSegment(segment))
        .filter((segment) => segment !== "")
        .join(".");
}

function sanitizeNodeIdSegment(segment) {
    const normalized = String(segment || "")
        .trim()
        .replace(/\s+/g, "_")
        .replace(/[^a-zA-Z0-9._-]/g, "_");

    return normalized || "item";
}

module.exports = {
    OPCUAServer,
    Variant,
    DataType,
    OPCUACertificateManager,
    StatusCodes,
    VariantArrayType,
    SecurityPolicy,
    MessageSecurityMode,
    UserTokenType,
    coerceNodeId,
    resolveNodeId,
    PermissionType,
    makeRoles,
    WellKnownRoles,
    DEFAULT_PORT,
    DEFAULT_SERVER_NAME,
    DEFAULT_NAMESPACE_URI,
    DEFAULT_RESOURCE_PATH,
    SECURITY_POLICY_MAP,
    SECURITY_MODE_MAP,
    DATA_TYPE_MAP,
    normalizePort,
    buildApplicationUri,
    sanitizeNodeIdPath
};
