"use strict";

const {
    ClientMonitoredItem,
    ClientSubscription,
    TimestampsToReturn,
    AttributeIds,
    constructEventFilter
} = require("node-opcua");

const {
    dataValueToItemResult,
    dataValueToItemResultEvent,
    enrichItemResultWithEnumeration,
    resolveName,
    resolveNodeId,
    statusCodeToString
} = require("../opcua-client-utils");

class OpcUaClientSubscriptionService {
    async startDataSubscription(node, msg, itemsResolver) {
        const items = itemsResolver.ensureClientItems(node, msg, "OPC UA subscription");
        await this.stop(node);

        const session = await node.connection.getSession();
        const subscription = ClientSubscription.create(session, {
            requestedPublishingInterval: node.publishingInterval,
            requestedLifetimeCount: 60,
            requestedMaxKeepAliveCount: 10,
            maxNotificationsPerPublish: 100,
            publishingEnabled: true,
            priority: 1
        });

        subscription.on("error", (error) => {
            node.status({ fill: "red", shape: "ring", text: "subscription error" });
            node.error(error);
        });

        node.subscription = subscription;
        node.monitoredItems = items.map((item) => {
            const monitoredItem = ClientMonitoredItem.create(
                subscription,
                { nodeId: resolveNodeId(item) },
                {
                    samplingInterval: node.samplingInterval,
                    discardOldest: true,
                    queueSize: 1
                },
                TimestampsToReturn.Both
            );

            const cache = new Map();
            monitoredItem.on("changed", async (dataValue) => {
                let payload = dataValueToItemResult(item, dataValue);
                payload = await enrichItemResultWithEnumeration(payload, session, cache, resolveNodeId(item));
                
                node.status({
                    fill: "blue",
                    shape: "dot",
                    text: resolveName(item, payload.nodeID) + " changed"
                });
                node.send({
                    topic: payload.name,
                    payload,
                    opcua: {
                        mode: "subscription",
                        nodeID: payload.nodeID,
                        status: payload.status
                    }
                });
            });

            monitoredItem.on("err", (message) => {
                node.status({ fill: "red", shape: "ring", text: statusCodeToString(message) });
            });

            return monitoredItem;
        });

        return items;
    }

    async startEventSubscription(node, msg, itemsResolver) {
        const items = itemsResolver.ensureClientItems(node, msg, "OPC UA subscription");
        await this.stop(node);

        const session = await node.connection.getSession();
        const subscription = ClientSubscription.create(session, {
            requestedPublishingInterval: node.publishingInterval,
            requestedLifetimeCount: 60,
            requestedMaxKeepAliveCount: 10,
            maxNotificationsPerPublish: 100,
            publishingEnabled: true,
            priority: 2
        });

        subscription.on("error", (error) => {
            node.status({ fill: "red", shape: "ring", text: "subscription error" });
            node.error(error);
        });

        node.subscription = subscription;

        const eventFilter = constructEventFilter([
            "EventId",
            "EventType",
            "SourceName",
            "SourceNode",
            "Message",
            "Severity",
            "ActiveState",
            "AckedState",
            "ConfirmedState",
            "Time",
            "ConditionId"
        ]);

        node.monitoredItems = items.map((item) => {
            const monitoredItem = ClientMonitoredItem.create(
                subscription,
                {
                    nodeId: resolveNodeId(item),
                    attributeId: AttributeIds.EventNotifier
                },
                {
                    samplingInterval: 0,
                    queueSize: 100,
                    discardOldest: true,
                    filter: eventFilter
                },
                TimestampsToReturn.Both
            );

            monitoredItem.on("changed", async (eventFields) => {
                const payload = await dataValueToItemResultEvent(item, eventFields, session);
                node.status({
                    fill: "blue",
                    shape: "dot",
                    text: resolveName(item, payload.nodeID) + " changed"
                });
                node.send({
                    topic: payload.name,
                    payload,
                    opcua: {
                        mode: "subscription",
                        nodeID: payload.nodeID,
                        status: payload.status
                    }
                });
            });

            monitoredItem.on("err", (message) => {
                node.status({ fill: "red", shape: "ring", text: statusCodeToString(message) });
            });

            return monitoredItem;
        });

        return items;
    }

    async stop(node) {
        const subscription = node.subscription;
        node.monitoredItems = [];
        node.subscription = null;

        if (subscription) {
            await subscription.terminate();
        }
    }
}

module.exports = {
    OpcUaClientSubscriptionService
};
