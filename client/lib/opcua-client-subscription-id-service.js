"use strict";

const { ClientSubscription } = require("node-opcua");

class OpcUaClientSubscriptionIdService {
    async execute(node) {
        const session = await node.connection.getSession();
        const subscription = ClientSubscription.create(session, {
            requestedPublishingInterval: 1000,
            requestedLifetimeCount: 100,
            requestedMaxKeepAliveCount: 10,
            maxNotificationsPerPublish: 100,
            publishingEnabled: true,
            priority: 10
        });

        const subscriptionId = subscription.subscriptionId;
        await subscription.terminate();
        return subscriptionId;
    }
}

module.exports = {
    OpcUaClientSubscriptionIdService
};
