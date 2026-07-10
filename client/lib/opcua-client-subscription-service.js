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
        const session = await node.connection.getSession();

        let mode = node.subscriptionMode || "replace";
        let updateRate = Number(node.publishingInterval) || 250;

        if (msg.opcua) {
            if (msg.opcua.subscriptionMode) {
                mode = msg.opcua.subscriptionMode;
            } else if (msg.opcua.mode) {
                mode = msg.opcua.mode;
            }
            if (msg.opcua.updateRate !== undefined) {
                updateRate = Number(msg.opcua.updateRate) || 250;
            }
        }

        // Check if we should append to existing subscription
        if (mode === "append" && node.subscription) {
            const currentPublishingInterval = node.subscription.publishingInterval;
            const rateChanged = Math.abs(currentPublishingInterval - updateRate) > 10;

            if (rateChanged) {
                // Merge all items and recreate subscription
                const existingItems = node.subscribedItems || [];
                const mergedItems = [...existingItems];
                items.forEach(newItem => {
                    const newNodeId = resolveNodeId(newItem);
                    if (!mergedItems.some(oldItem => resolveNodeId(oldItem) === newNodeId)) {
                        mergedItems.push(newItem);
                    }
                });

                await this.stop(node);
                return this.createDataSubscription(node, session, mergedItems, updateRate);
            } else {
                // Filter out already subscribed items
                const existingItems = node.subscribedItems || [];
                const newItems = items.filter(newItem => {
                    const newNodeId = resolveNodeId(newItem);
                    return !existingItems.some(oldItem => resolveNodeId(oldItem) === newNodeId);
                });

                if (newItems.length > 0) {
                    this.addMonitoredItems(node, session, node.subscription, newItems);
                }
                return node.subscribedItems;
            }
        }

        // Replace mode (or first time)
        await this.stop(node);
        return this.createDataSubscription(node, session, items, updateRate);
    }

    async createDataSubscription(node, session, items, updateRate) {
        const subscription = ClientSubscription.create(session, {
            requestedPublishingInterval: updateRate,
            requestedLifetimeCount: 60,
            requestedMaxKeepAliveCount: 10,
            maxNotificationsPerPublish: 100,
            publishingEnabled: true,
            priority: 1
        });

        subscription.on("error", (error) => {
            node.status({ fill: "red", shape: "ring", text: "subscription error" });
        });

        node.subscription = subscription;
        node.subscribedItems = [];
        node.monitoredItems = [];

        this.addMonitoredItems(node, session, subscription, items);
        return items;
    }

    addMonitoredItems(node, session, subscription, items) {
        const cache = new Map();

        items.forEach((item) => {
            const monitoredItem = ClientMonitoredItem.create(
                subscription,
                { nodeId: resolveNodeId(item) },
                {
                    samplingInterval: Number(node.samplingInterval) || 250,
                    discardOldest: true,
                    queueSize: 1
                },
                TimestampsToReturn.Both
            );

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

            node.monitoredItems.push(monitoredItem);
            node.subscribedItems.push(item);
        });
    }

    async startEventSubscription(node, msg, itemsResolver) {
        const items = itemsResolver.ensureClientItems(node, msg, "OPC UA subscription");
        const session = await node.connection.getSession();

        let mode = node.subscriptionMode || "replace";
        let updateRate = Number(node.publishingInterval) || 250;

        if (msg.opcua) {
            if (msg.opcua.subscriptionMode) {
                mode = msg.opcua.subscriptionMode;
            } else if (msg.opcua.mode) {
                mode = msg.opcua.mode;
            }
            if (msg.opcua.updateRate !== undefined) {
                updateRate = Number(msg.opcua.updateRate) || 250;
            }
        }

        if (mode === "append" && node.subscription) {
            const currentPublishingInterval = node.subscription.publishingInterval;
            const rateChanged = Math.abs(currentPublishingInterval - updateRate) > 10;

            if (rateChanged) {
                const existingItems = node.subscribedItems || [];
                const mergedItems = [...existingItems];
                items.forEach(newItem => {
                    const newNodeId = resolveNodeId(newItem);
                    if (!mergedItems.some(oldItem => resolveNodeId(oldItem) === newNodeId)) {
                        mergedItems.push(newItem);
                    }
                });

                await this.stop(node);
                return this.createEventSubscription(node, session, mergedItems, updateRate);
            } else {
                const existingItems = node.subscribedItems || [];
                const newItems = items.filter(newItem => {
                    const newNodeId = resolveNodeId(newItem);
                    return !existingItems.some(oldItem => resolveNodeId(oldItem) === newNodeId);
                });

                if (newItems.length > 0) {
                    this.addEventMonitoredItems(node, session, node.subscription, newItems);
                }
                return node.subscribedItems;
            }
        }

        await this.stop(node);
        return this.createEventSubscription(node, session, items, updateRate);
    }

    async createEventSubscription(node, session, items, updateRate) {
        const subscription = ClientSubscription.create(session, {
            requestedPublishingInterval: updateRate,
            requestedLifetimeCount: 60,
            requestedMaxKeepAliveCount: 10,
            maxNotificationsPerPublish: 100,
            publishingEnabled: true,
            priority: 2
        });

        subscription.on("error", (error) => {
            node.status({ fill: "red", shape: "ring", text: "subscription error" });
        });

        node.subscription = subscription;
        node.subscribedItems = [];
        node.monitoredItems = [];

        this.addEventMonitoredItems(node, session, subscription, items);
        return items;
    }

    addEventMonitoredItems(node, session, subscription, items) {
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

        items.forEach((item) => {
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

            node.monitoredItems.push(monitoredItem);
            node.subscribedItems.push(item);
        });
    }

    async stop(node) {
        const subscription = node.subscription;
        node.monitoredItems = [];
        node.subscribedItems = [];
        node.subscription = null;

        if (subscription) {
            await subscription.terminate();
        }
    }
}

module.exports = {
    OpcUaClientSubscriptionService
};
