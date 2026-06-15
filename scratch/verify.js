const assert = require("assert");

// Mocking required modules for importing server-side files
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
        Int64: "Int64",
        UInt64: "UInt64",
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

// Mock Node-RED RED object and registry
require.cache[require.resolve("node-opcua")] = { exports: mockOpcua };
require.cache[require.resolve("../opcua-server-registry")] = { exports: {} };

const configParserClass = require("../server/lib/opcua-config");
const configParser = new configParserClass(null);

console.log("Config parser imported successfully.");

// Test config parser coercion
const clampedInt64Str = configParser.coerceValue(9223372036854775807, "Int64");
console.log("Coerced 9223372036854775807 Int64:", clampedInt64Str);
assert.strictEqual(clampedInt64Str, "9223372036854775807");

const negativeInt64Str = configParser.coerceValue(-9223372036854775808, "Int64");
console.log("Coerced -9223372036854775808 Int64:", negativeInt64Str);
assert.strictEqual(negativeInt64Str, "-9223372036854775808");

const overflowInt64Str = configParser.coerceValue(9223372036854776000, "Int64");
console.log("Coerced overflow 9223372036854776000 Int64 (should clamp):", overflowInt64Str);
assert.strictEqual(overflowInt64Str, "9223372036854775807");

// Test client utils coercion & decoding
const clientUtils = require("../client/opcua-client-utils");
console.log("Client utils imported successfully.");

const coercedValClient = clientUtils.coerceValue(9223372036854775807, "Int64");
console.log("Client coerced 9223372036854775807:", coercedValClient);
// It should return [high, low] array of numbers: 9223372036854775807n -> [2147483647, 4294967295]
assert.deepStrictEqual(coercedValClient, [2147483647, 4294967295]);

const decodedValClient = clientUtils.resolve64BitValue(coercedValClient, false);
console.log("Client decoded value:", decodedValClient);
// Since it decodes it as a JS float Number, 9223372036854775807 decodes to 9223372036854776000
assert.strictEqual(decodedValClient, 9223372036854776000);

console.log("All verify script assertions passed!");
