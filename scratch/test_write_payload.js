const assert = require("assert");

// Mocking required modules
const mockOpcua = {
    OPCUAServer: class {},
    Variant: class {
        constructor(opts) {
            this.dataType = opts.dataType;
            this.value = opts.value;
            this.arrayType = opts.arrayType;
        }
    },
    DataType: {
        Int32: "Int32",
        Int64: "Int64",
        Boolean: "Boolean",
        String: "String"
    },
    StatusCodes: {
        Good: "Good",
        BadTypeMismatch: "BadTypeMismatch"
    },
    SecurityPolicy: {},
    VariantArrayType: {
        Scalar: "Scalar",
        Array: "Array"
    },
    MessageSecurityMode: {},
    UserTokenType: {},
    coerceNodeId: () => {},
    resolveNodeId: () => {},
    PermissionType: {},
    makeRoles: () => {},
    WellKnownRoles: {},
    OPCUACertificateManager: class {},
};

require.cache[require.resolve("node-opcua")] = { exports: mockOpcua };
require.cache[require.resolve("../opcua-server-registry")] = { exports: {} };

const AddressSpaceBuilder = require("../server/lib/opcua-address-space-builder");
const builder = new AddressSpaceBuilder(null);

// Populate variables in variableStore
const variables = [
    { name: "variableLevelAlarm", type: "Int32", value: 50, access: "readwrite" },
    { name: "variableArray", type: "Int32", value: [10, 20, 30], access: "readwrite" },
    { name: "variableString", type: "String", value: "aaaa", access: "readwrite" },
    { name: "variableStringArray", type: "String", value: ["aaaa", "bbbb"], access: "readwrite" },
    { name: "variableInt64", type: "Int64", value: 0, access: "readwrite" }
];

const mockNamespace = {
    addVariable: (config) => {
        // Mock variable node
        return {
            getPropertyByName: () => ({
                readValue: () => ({ value: { value: 0 } })
            }),
            activeState: {
                id: {
                    readValue: () => ({ value: { value: false } })
                }
            }
        };
    }
};

builder.namespaces = new Map([[2, mockNamespace]]);

variables.forEach(v => {
    // Mimic the path creation in builder
    const path = "myServer1." + v.name;
    const nodeId = "ns=2;s=" + path;
    const state = {
        type: v.type,
        access: v.access,
        isArray: Array.isArray(v.value),
        currentValue: builder.coerceValue(v.value, v.type, Array.isArray(v.value))
    };
    
    const record = {
        node: mockNamespace.addVariable(),
        path: path,
        nodeId: nodeId,
        type: state.type,
        isArray: state.isArray,
        getValue: () => state.currentValue,
        setValue: (nextValue) => {
            state.currentValue = builder.coerceValue(nextValue, state.type, state.isArray);
            return state.currentValue;
        }
    };
    builder.variableStore.set(path, record);
});

// Mock alarm management
builder.addressSpaceAlarm = {
    checkAlarm: () => {}
};

console.log("Mock Address Space Builder setup completed.");

// Payload to test write
const payload = [
    {
        "name": "variableLevelAlarm",
        "path": "myServer1.variableLevelAlarm",
        "value": 55
    },
    {
        "name": "variableLevelAlarm",
        "path": "myServer1.variableArray",
        "value": [11,22,33]
    },
    {
        "name": "variableString",
        "path": "myServer1.variableString",
        "value": "aaaa"
    },
    {
        "name": "variableStringArray",
        "path": "myServer1.variableStringArray",
        "value": ["aaaa" , "bbbb"]
    },
    {
        "name": "variableInt64",
        "path": "myServer1.variableInt64",
        "value": 9223372036854776000
    }
];

try {
    payload.forEach(item => {
        const record = builder.variableStore.get(item.path);
        if (!record) {
            throw new Error("Unknown path: " + item.path);
        }
        record.setValue(item.value);
    });
    console.log("Successfully wrote all items in payload.");
    
    // Verify variableInt64 value
    const int64Record = builder.variableStore.get("myServer1.variableInt64");
    console.log("Int64 stored value:", int64Record.getValue());
    assert.strictEqual(int64Record.getValue(), "9223372036854775807");
    
    // Test readValue conversion
    const readVal = builder.readValue("path", "myServer1.variableInt64");
    console.log("readValue returned:", readVal);
    assert.strictEqual(readVal, 9223372036854776000);
    
    console.log("Test execution successful - no errors thrown!");
} catch (e) {
    console.error("Test execution failed with error:", e);
}
