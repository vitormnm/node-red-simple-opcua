# @vitormnm/node-red-simple-opcua
OPC UA client and server with a simple graphical interface for Node-RED.
Fully parameterized in JSON.

It supports the following OPC UA items on only 3 nodes.

 - alarms
 - events
 - events read and write tags in server(See which tags are being written to or read from the client directly on the server in a simple workflow)
 - methods(write methods in node-red flow)
 - variables
 - variables arrays
 - description and displayname nodes
 - objects
 - simple objectsType
 - custom namespace
 - custom nodeID
 - Subscription Variables and events in client

**Server editor**
![node-red-si](/resources/editorServer.PNG) 

**Client editor**
![node-red-si](/resources/editorClient.PNG) 



example json server config
```
{
    "objects": [],
    "folders": [
        {
            "name": "MyServer",
            "displayName": "",
            "description": "",
            "nodeId": "",
            "namespaceId": 2,
            "objectsType": "",
            "folders": [
                {
                    "name": "newFolder",
                    "displayName": "",
                    "description": "",
                    "nodeId": "",
                    "namespaceId": 2,
                    "objectsType": "",
                    "folders": [],
                    "objects": [],
                    "variables": [
                        {
                            "name": "newVariable",
                            "type": "Int32",
                            "value": "",
                            "access": "readwrite",
                            "description": "",
                            "displayName": "",
                            "nodeId": "",
                            "namespaceId": 2
                        }
                    ],
                    "alarms": [],
                    "methods": [],
                    "objectsTypes": []
                }
            ],
            "objects": [
                {
                    "name": "newObject",
                    "displayName": "",
                    "description": "",
                    "nodeId": "",
                    "namespaceId": 2,
                    "objectsType": "",
                    "folders": [],
                    "objects": [],
                    "variables": [
                        {
                            "name": "newVariable",
                            "type": "Int32",
                            "value": "",
                            "access": "readwrite",
                            "description": "",
                            "displayName": "",
                            "nodeId": "",
                            "namespaceId": 2
                        }
                    ],
                    "alarms": [],
                    "methods": [],
                    "objectsTypes": []
                }
            ],
            "variables": [
                {
                    "name": "newVariable",
                    "type": "Int32",
                    "value": "",
                    "access": "readwrite",
                    "description": "",
                    "displayName": "",
                    "nodeId": "",
                    "namespaceId": 2
                }
            ],
            "alarms": [],
            "methods": [
                {
                    "name": "newMethod",
                    "description": "",
                    "displayName": "",
                    "nodeId": "",
                    "namespaceId": 2,
                    "inputs": [],
                    "outputs": []
                }
            ],
            "objectsTypes": []
        }
    ],
    "objectsTypes": [],
    "nameSpaces": [
        {
            "id": 2,
            "name": "urn:node-red:opc-ua-server"
        }
    ]
}
```
Disclaimer
This node was only used in simulation and testing environments.

