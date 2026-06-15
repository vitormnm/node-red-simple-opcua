const { Variant, DataType } = require("node-opcua");

try {
    const v1 = new Variant({
        dataType: DataType.Int64,
        value: [0, 5] // wait, what format?
    });
    console.log("Variant created successfully with array [0, 5]:", v1);
} catch (e) {
    console.error("Failed array [0, 5]:", e.message);
}

try {
    // node-opcua Int64 can also be represented as an array of two 32-bit integers: [high, low] or [low, high]?
    // Let's test what node-opcua Variant accepts for Int64.
    const v2 = new Variant({
        dataType: DataType.Int64,
        value: 12345678
    });
    console.log("Variant with number:", v2);
} catch (e) {
    console.error("Failed number:", e.message);
}
