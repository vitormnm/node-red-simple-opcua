# AGENTS.MD — Workspace Addendum

This file extends the global AGENTS.md with project-specific additions made to this workspace.

---

## Session Management — `opcua-server-io`

Two new modes were added to `opcua-server-io` for inspecting and force-closing active OPC UA sessions on the server.

### New IPC Message Types

The following entries extend the IPC message contract table in the global AGENTS.md.

| Direction      | `type`                  | Payload fields              | Purpose                                        |
|----------------|-------------------------|-----------------------------|------------------------------------------------|
| parent → child | `readActiveSessions`    | `msg`, `nodeId`             | Return snapshot of all active sessions         |
| parent → child | `deleteActiveSessions`  | `msg` (with `payload` array of `{ sessionId }`), `nodeId` | Force-close one or more sessions by `sessionId` |

> **Rule:** Both `readActiveSessions` and `deleteActiveSessions` are handled in the `process.on("message", ...)` switch block in `opcua-server-runtime-child.js` and wired in `opcua-server-io.js` via `requestSessions` / `handleDeleteSessions`.

---

### New `opcua-server-io` Modes

The following entries extend the mode table in the global AGENTS.md for `opcua-server-io`.

| Mode             | On input                                                    | On start              |
|------------------|-------------------------------------------------------------|-----------------------|
| `getSessions`    | Sends `readActiveSessions` to child; outputs session array  | Sends `readActiveSessions` (auto-fetch, same as `status` mode) |
| `deleteSessions` | Sends `deleteActiveSessions` to child; outputs result array | —                     |

---

### `readActiveSessions` — Child Process Method

**File:** `server/lib/opcua-server-runtime-child.js` — `OpcUaServerProcess.readActiveSessions(msg, nodeId)`

- Reads `server.engine._sessions` (a plain object keyed by `authenticationToken.toString()`).
- Maps each `ServerSession` through the module-level `buildSessionSnapshot()` helper.
- Sends `{ type: "send", data: outMsg }` with `outMsg.payload` as a JSON array of session snapshots.
- Updates node status badge: `"N sessions"`.

**Session snapshot shape** (produced by `buildSessionSnapshot(session)`):

```js
{
  sessionId:                  String,   // session.nodeId.toString() — the GUID used as the public identifier
  sessionName:                String,   // client-supplied session name
  status:                     String,   // "new" | "active" | "screwed" | "disposed" | "closed"
  creationDate:               String,   // ISO 8601 date string (session.creationDate)
  sessionTimeout:             Number,   // negotiated timeout in ms
  clientLastContactTime:      Number,   // ms since epoch of last client contact
  channelId:                  Number | null,
  clientDescription: {
    applicationUri:           String | null,
    productUri:               String | null,
    applicationName:          String | null,
    applicationType:          String | null
  } | null,
  userIdentityToken: {
    policyId:                 String | null,
    userName:                 String | null,  // only present for UserName tokens
    tokenType:                String | null   // schema name, e.g. "AnonymousIdentityToken"
    // passwords / credential bytes are NEVER exposed
  } | null,
  channel: {
    channelId:                Number | null,
    remoteAddress:            String | null,
    remotePort:               Number | null,
    bytesRead:                Number | null,
    bytesWritten:             Number | null,
    transactionsCount:        Number | null,
    securityMode:             String | null,
    securityPolicy:           String | null
  } | null,
  currentSubscriptionCount:   Number | null,
  cumulatedSubscriptionCount: Number | null,
  currentMonitoredItemCount:  Number | null,
  aborted:                    Boolean
}
```

---

### `deleteActiveSessions` — Child Process Method

**File:** `server/lib/opcua-server-runtime-child.js` — `OpcUaServerProcess.deleteActiveSessions(msg, nodeId)`

**Input contract:** `msg.payload` must be a non-empty array of objects with a `sessionId` field:

```js
[
  { sessionId: "ns=1;g=F4F511E2-664B-2191-89A7-46EE461DB86C" },
  { sessionId: "ns=1;g=A1B2C3D4-1234-5678-ABCD-EF0123456789" }
]
```

**Algorithm:**

1. Validates the payload is a non-empty array; throws otherwise (caught → `error` IPC).
2. For each item, looks up a matching session by comparing `session.nodeId.toString() === item.sessionId` across all values of `engine._sessions`.
   - Sessions are internally keyed by `authenticationToken.toString()` (a ByteString NodeId), which is **not** the same as `sessionId`. The lookup must iterate `Object.values(engine._sessions)`.
3. If not found → result `{ sessionId, status: "not_found" }`.
4. If found → calls `engine.closeSession(found.authenticationToken, true, "Forcing")`.
   - `deleteSubscriptions = true` — subscriptions are cleaned up immediately.
   - `reason = "Forcing"` — the only valid reason for a forceful server-initiated termination (the engine validates this; allowed values are `"Timeout"`, `"Terminated"`, `"CloseSession"`, `"Forcing"`).
   - On success → result `{ sessionId, status: "deleted" }`.
   - On `closeSession` error → result `{ sessionId, status: "error", error: errorMessage }`.

**Output contract:** `msg.payload` is an array of per-item result objects, one for each input item, in the same order.

**Node status badge logic:**

| Condition              | Color     | Text example                       |
|------------------------|-----------|------------------------------------|
| All deleted            | green     | `"deleted 2"`                      |
| Some not found         | yellow    | `"deleted 1, not found 1"`         |
| Any error              | red       | `"deleted 1, error 1"`             |
| Empty input (throws)   | red       | `"failed deleteSessions"`          |

---

### Module-Level Helper Functions

These functions live at module scope in `opcua-server-runtime-child.js` (below the class) and are shared by both `readActiveSessions` and `deleteActiveSessions`.

| Function                        | Purpose                                                                                 |
|---------------------------------|-----------------------------------------------------------------------------------------|
| `buildSessionSnapshot(session)` | Maps a `ServerSession` instance to a plain IPC-safe object (see schema above).          |
| `safeToString(value)`           | Returns `String(value)` or `null`; never throws.                                        |
| `safeNumber(value)`             | Returns `Number(value)` if finite, else `null`.                                         |
| `buildClientDescription(desc)`  | Extracts `applicationUri`, `productUri`, `applicationName`, `applicationType` from a `ApplicationDescription` object. |
| `buildUserIdentityToken(token)` | Extracts `policyId`, `userName`, `tokenType` from a `UserIdentityToken` object. Passwords are **never** included. |
| `buildChannelInfo(channel)`     | Extracts `channelId`, `remoteAddress`, `remotePort`, `bytesRead`, `bytesWritten`, `transactionsCount`, `securityMode`, `securityPolicy` from a `ServerSecureChannelLayer`. |

> **Note on `session.nodeId` vs `session.authenticationToken`:** The `nodeId` (GUID) is the public session identifier shown to OPC UA clients and exposed in `msg.payload`. The `authenticationToken` (ByteString NodeId) is the internal key used by `engine._sessions` and required for `engine.closeSession()`. Always use `nodeId` in user-facing APIs and `authenticationToken` for engine calls.

---

## Editor Form & CSS Style Guidelines

When creating or modifying editor forms for Node-RED nodes, adhere to the following styling and structure guidelines to maintain consistency with Node-RED standards and custom CSS extensions:

1. **Standard Node-RED Form Styling**:
   - Standard forms and styles in Node-RED must be used to ensure native look-and-feel.
   - Use standard Node-RED classes (e.g., `.form-row`) for default settings inputs.
   - Align labels and inputs consistently. Standard labels should typically use standard layouts or flexbox to avoid layout breakages.

2. **Configuration Card Styling (CSS Classes)**:
   - For secondary modal configuration forms (e.g., Server Settings, Security Settings), use the standardized configuration card CSS classes defined in `server/view/opcua-server.css` (and mirrored in `server/opcua-server.css`).
   - Do **NOT** use inline styling for colors, padding, borders, shadows, and spacing. Use the following classes instead:
     - `.opcua-config-card`: Outer card container (sets background, padding, border, border radius, and shadow).
     - `.opcua-card-title`: Header/title of the configuration card (sets margin, bold text, border bottom, and padding bottom).
     - `.opcua-config-form`: Form layout container (sets display flex, vertical flex direction, and vertical gap).
     - `.opcua-config-row`: Individual row wrapper (overrides default `.form-row` margins and aligns items in center using flex). Use `.opcua-config-row--checkbox` for checkable fields.
     - `.opcua-config-label`: Label style (sets width to 240px, font weight, flex-shrink, and inline-block display).
     - `.opcua-config-input`: Input field style (sets width to 300px and removes default margins). Checkboxes should specify type explicitly (`type="checkbox"`) to reset the width to auto.

3. **CSS File Locations**:
   - The primary served stylesheet for the server node editor is `server/view/opcua-server.css`. Changes to settings styles must be made there.
   - For consistency and to prevent drifting, also mirror the settings stylesheet changes in the root file `server/opcua-server.css`.

---

## Recursive Browse and Type Resolution — `opcua-client`

A new mode `browseRecursive` was added to `opcua-client` for recursively traversing the OPC UA address space starting from a given `nodeId`. Additionally, both standard `browse` and `browseRecursive` modes were enhanced with type resolution and enumeration enrichment.

### New `opcua-client` Mode

The mode select dropdown in `opcua-client.html` supports a new mode:

| Mode              | Description |
|-------------------|-------------|
| `browseRecursive` | Performs a recursive, hierarchical search of the address space starting from the given `nodeId` |

### Key Enhancements

1. **Hierarchical Only Traversing:**
   - Both single-level `browse` and `browseRecursive` calls to `session.browse` now specifically restrict query scope using `referenceTypeId: makeNodeId(33, 0)` (i.e. `HierarchicalReferences`).
   - This prevents non-hierarchical type definition references (like `HasTypeDefinition` pointing to `FolderType` or `BaseObjectType`) from being incorrectly returned as child instances in the browse output.

2. **Children Key Renaming:**
   - The key name holding child references in the JSON payload outputs has been renamed from `browse` to `children` for both modes.
   - For backwards compatibility with the editor UI tree explorer, `browseForEditor` in `opcua-client-config.js` maps `children` back to `browse` before returning to the frontend.

3. **Type Definition Resolution:**
   - The NodeId of each node's type definition is captured (as `item.typeDefinition`).
   - The client performs a batched read of the `BrowseName` of all unique type definitions.
   - The resolved name is populated under `item.hasTypeDefinition` as an object:
     ```json
     {
       "nodeID": "ns=0;i=63",
       "browseName": "BaseDataVariableType",
       "displayName": "BaseDataVariableType"
     }
     ```

4. **Enumeration Variable Enrichment:**
   - For variables of type `DataType.Enumeration`, the client automatically overrides `item.dataType` to `"Enumeration"`.
   - The client invokes `enrichItemResultWithEnumeration` (which checks both `result.type` and `result.dataType` and supports direct lookup of custom dataType NodeIds) to query standard/custom enum properties (`EnumStrings` / `EnumValues`) and populate `item.valueEnumeration` with the resolved text representation (e.g. `"State1"`).

5. **Error Propagation & Catch Integration:**
   - Standard `browse` and `browseRecursive` modes validate the `statusCode` property of the `BrowseResult` returned from the OPC UA server.
   - If the starting node (root) fails to browse (e.g. due to connection issues or `BadNodeIdUnknown` status), an exception is thrown and caught in the client node's input handler.
   - To route the error to the Node-RED **Catch** node without generating large console stack traces, the client calls `node.error(error.message, msg)` directly and resolves the execution callback via `done()` with no arguments.

6. **Success Status Property:**
   - When a browse operation completes successfully, a `status: "Good"` property is appended to the root output object, mirroring the shape of error status payloads.

---

## Error Handling & Catch Integration — `opcua-server-io`

To ensure errors are routed correctly without flooding Node-RED's system console log or printouts:
1. **Child Process IPC Error Propagation**: Catch blocks in the child process (`readFromPayload`, `writeEventFromPayload`, `writeFromPayload`, `readActiveSessions`, `deleteActiveSessions` in `server/lib/opcua-server-runtime-child.js`) pass `originalMsg: msg` (the original incoming Node-RED message context) back to the parent process.
2. **Silent Catch Triggering**: In `server/opcua-server-io.js`, the IPC message receiver for `type === "error"` was updated from calling log-heavy `node.error(msg.error)` to routing the error with the message context:
   ```javascript
   const catchMsg = Object.assign({}, msg.originalMsg || {}, {
       error: msg.error
   });
   node.error(msg.error, catchMsg);
   ```
   This ensures the error is captured by the **Catch** node correctly without writing duplicate entries or stack traces to the Node-RED runtime console.

---

## General Node-RED Error Handling & Catch Integration Rules

When writing or modifying Node-RED nodes in this repository, follow these rules to handle errors without generating clutter in the console logs or Debug sidebar:
1. **No Standard Send on Failure**: When an input handler catches an error, it must **never** call `send(msg)` (or `node.send(msg)`) to send the failed message downstream. Doing so will make the error/status message appear in standard outputs (and any attached debug nodes), which clutters the Debug sidebar.
2. **Route via Catch Node Only**: To route the error exclusively to the **Catch** node, call `node.error(errMessage, msg)` where the second argument `msg` is the active Node-RED message context.
3. **Resolve Done Callback Cleanly**: Always call `done()` with **no arguments** (when `done` is defined). Do not call `done(error)` as the wrapper will automatically log a full stack trace to the console. Emitting the error via `node.error(errMessage, msg)` and then calling `done()` with no arguments ensures the error reaches the Catch block cleanly and silently.
4. **Errors Sent Only Within Catch Block on Client**: For the Node.js client (`opcua-client.js`), all node errors (`node.error`) must be emitted exclusively within the `catch` block of the input handler. Asynchronous background event listeners (like subscription error handlers) must not call `node.error(error)` directly to avoid cluttering the system logs without a message context; instead, they should update the node status badge to reflect the error state.

---

## Duplicate NodeId Detection and Resolution during Address Space Sync

To prevent `already registered` NodeId conflicts when starting the server or dynamically syncing the address space tree:
1. **Existing Node Detection**: Before creating any `Folder`, `Object`, `ObjectTypeInstance`, `Variable`, `Method`, or `Alarm` node in the address space builder, the builder calls `addressSpace.findNode(nodeId)` to verify if the node already exists.
2. **Node Reuse**: If the node already exists (for example, child nodes created automatically by `node-opcua`'s built-in `ObjectType` instantiation process), the builder registers it in the internal lookup tables (e.g. `nodeEntries`, `variableStore`, `variableNodeIdStore`) and configures/updates its properties (such as values, alarm limits, and role permissions) instead of attempting to recreate the node.
3. **Automatic Child Node Cleanup**: When creating a custom `ObjectType` instance, any default child nodes automatically instantiated by `node-opcua`'s `addObject` are deleted using `addressSpace.deleteNode` immediately after creation. This ensures that the builder's subsequent explicit instantiation loop can create the children using the correct rewritten custom NodeIds (e.g. `ns=2;s=server1.label1.label` instead of using the template's default child NodeId `ns=2;s=label.label`).
4. **Fallback Prefix Resolution**: When rewriting inherited child NodeIds, if the definition NodeId or the instance NodeId properties are empty in the JSON config, the builder falls back to using the definition name (e.g. `"ns=2;s=" + typeEntry.config.name`) and the actual instantiated node's NodeId string (e.g. `instanceNode.nodeId.toString()`) to perform prefix rewriting correctly.

---

## NodeId Type Selection in Editor UI

To allow full flexibility in NodeId naming (supporting both String `s` and Numeric `i` types) for all structural components on the server:
1. **Extended Editor Support**: The editor UI Details panel and Add Node modal allow selecting/editing NodeId types (String `s` / Numeric `i`) and specifying custom values for `Folder`, `Object`, `ObjectTypeInstance`, `Variable`, `Alarm`, and `Method` nodes.
2. **ObjectType Template Exclusion**: ObjectType definitions (nodes defined under `Types/ObjectTypes`) and their children in the template are restricted to String-only NodeIds. This ensures consistent parameter inheritance and predictable prefix rewriting when instantiating the types.
3. **Editor State Synchronization**: The `saveCreateForm`, `renderDetails`, and `saveDetailNodeId` functions in `server/view/opcua-server.js` handle parsing, populating, and persisting the selected NodeId type (`s` or `i`) and value for all supported node classes.

---

## Recursive Node Refreshing in Browse Tree

To prevent children of refreshed tree nodes from getting stuck on `"Searching for items..."`:
1. **Recursive Expansion Cascade**: When a node is expanded or refreshed via the frontend (`client/view/opcua-client.js`), the `.done()` handler invokes `triggerChildrenExpansion(children, parentPath)`.
2. **Expansion State Checking**: For each child node returned in the payload, the helper checks if it was previously marked as expanded in `expansionState`. If so, and the child's own sub-items are not yet loaded, it calls `expandNode(childPath)` automatically. This cascades down the tree, restoring the expanded state of all sub-nodes recursively.

---

## Selection Shortcut via Ctrl+Click in Browse Tree

To improve selection efficiency in the client browse tree dialog:
1. **Shortcut Listener**: Clicking on any `.opcua-tree-row` while holding down the `Ctrl` key (or `Cmd` key on macOS) bypasses the need to manually click the "+ Add" button.
2. **Auto-Selection Routing**: The click handler automatically intercepts the keyboard modifier (`event.ctrlKey || event.metaKey`) and routes the node to `toggleSelectedNode(path)` (or `addMethodFromTree` if in method mode). This toggles the selection state of the clicked node immediately.



