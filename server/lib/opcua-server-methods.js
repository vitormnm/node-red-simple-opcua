"use strict";

const {
    DATA_TYPE_MAP,
    StatusCodes,
    Variant,
    VariantArrayType,
    sanitizeNodeIdPath,
    DataType,
    coerceNodeId
} = require("./opcua-constants");


const { OpcUaAddressSpaceAlarm } = require("./opcua-address-space-alarm")


class OpcUaServerMethods {

    constructor(options) {
        this.addressSpace = options.addressSpace
        this.node = options.addressSpace
        this.registry = options.registry


        //Use OpcUaAddressSpaceAlarm to set an alarm message to be stored in the history.
        this.addressSpaceAlarm = new OpcUaAddressSpaceAlarm({
            registry: this.registry,
            node: this.node
        })


    }


    start() {
        this.acknowledgeTypeMethod()
        this.confirmTypeMethod()
        this.conditionRefreshMethod()
        this.addCommentMethod()
    }

    confirmTypeMethod() {
        const confirmTypeMethod = this.addressSpace.findNode("ns=0;i=9113");
        confirmTypeMethod.bindMethod(
            (inputArguments, context, callback) => {
                const eventId = inputArguments[0].value;
                const comment = inputArguments[1].value;
                const alarm = context.object;

                // severity atual
                const severity = alarm.severity.readValue().value.value;

                // message atual
                const message = alarm.message.readValue().value.value.text;


                if (alarm.activeState.getValue()) {

                    alarm.confirmedState.setValue(true);


                    this.addressSpaceAlarm.raiseNewConditionAlarm(alarm, message, severity, true)
                    alarm.raiseNewCondition({
                        message: message,
                        severity: severity,
                        retain: true
                    });


                } else {
                    alarm.confirmedState.setValue(true);
                    this.addressSpaceAlarm.raiseNewConditionAlarm(alarm, message, severity, false)
                }




                callback(null, {
                    statusCode: StatusCodes.Good,
                    outputArguments: []
                });
            }
        );

    }

    addCommentMethod() {
        const addCommentMethod = this.addressSpace.findNode("ns=0;i=9029");
        addCommentMethod.bindMethod(
            (inputArguments, context, callback) => {
                const eventId = inputArguments[0].value;
                const comment = inputArguments[1].value;
                const alarm = context.object;

                // alarm.addComment(eventId, comment, context.session);
                alarm.comment.setValueFromSource({
                    value: comment,
                    dataType: DataType.LocalizedText
                });
                callback(null, {
                    statusCode: StatusCodes.Good,
                    outputArguments: []
                });
            }
        );
    }

    acknowledgeTypeMethod() {
        const acknowledgeTypeMethod = this.addressSpace.findNode("ns=0;i=9111");

        acknowledgeTypeMethod.bindMethod(
            (inputArguments, context, callback) => {
                const eventId = inputArguments[0].value;
                const comment = inputArguments[1].value;
                
                const alarm = context.object;
                // severity atual
                const severity = alarm.severity.readValue().value.value;

                // message atual
                const message = alarm.message.readValue().value.value.text;

                alarm.ackedState.setValue(true);


                alarm.confirmedState.setValue(false);
                // IMPORTANTE: Para o cliente "ver", o alarme precisa gerar um evento de mudança




                this.addressSpaceAlarm.raiseNewConditionAlarm(alarm, message, severity, true)

                callback(null, {
                    statusCode: StatusCodes.Good,
                    outputArguments: []
                });
            }
        );

    }


    conditionRefreshMethod() {
        const conditionType = this.addressSpace.findObjectType("ConditionType");

        const conditionRefreshMethod = conditionType.getMethodByName("ConditionRefresh");

        conditionRefreshMethod.bindMethod(
            (inputArguments, context, callback) => {

                const subscriptionId = inputArguments[0].value;

                var ActiveAlarms = this.registry.getActiveAlarms(this.node)


                ActiveAlarms.forEach(element => {
                    const alarmNode = element.alarmNode

                    alarmNode.raiseNewCondition({
                        message: element.message,
                        severity: element.severity,
                        retain: element.retain
                    });

                });
                

                // for (const [, state] of retainedAlarms) {
                //     const alarm = state.alarm;

                //     alarm.raiseNewCondition({
                //         message: state.message,
                //         severity: state.severity,
                //         retain: state.retain
                //     });
                // }

                callback(null, {
                    statusCode: StatusCodes.Good,
                    outputArguments: [{
                        dataType: DataType.String,
                        value: JSON.stringify(ActiveAlarms)
                    }]
                });


                // reenviar alarmes ativos
                // aqui você percorre seus alarmes e dispara eventos novamente

            }
        );
    }


}

module.exports = { OpcUaServerMethods } 