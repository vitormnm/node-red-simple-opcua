
(function () {
    var editorState = { objects: [], folders: [], objectsTypes: [], enumerations: [], nameSpaces: [] };
    var expansionState = {};
    var selectedPath = "";
    var pendingCreate = null;
    var pendingPasswordHashes = 0;
    var authGroups = [];
    var authUsers = [];
    var treeSearchValue = "";
    var treeSearchTerm = "";
    var isSyncing = false;
    var DEFAULT_NAMESPACE_ID = 2;

    var selectedCertFolder = "rejected";
    var selectedCertName = "";
    var certificatesData = { trusted: [], rejected: [] };

    function syncModalBodyClass() {
        $("body").toggleClass("opcua-tree-modal-open", 
            $("#node-input-tree-modal").is(":visible") || 
            $("#node-input-auth-modal").is(":visible") ||
            $("#node-input-cert-modal").is(":visible") ||
            $("#node-input-settings-modal").is(":visible")
        );
    }
    function openTreeModal() { $("#node-input-tree-modal").show(); syncModalBodyClass(); }
    function closeTreeModal() { $("#node-input-tree-modal").hide(); syncModalBodyClass(); }
    function openAuthModal() { $("#node-input-auth-modal").show(); syncModalBodyClass(); renderAuthEditor(); }
    function closeAuthModal() { $("#node-input-auth-modal").hide(); syncModalBodyClass(); }
    function openCertModal() { $("#node-input-cert-modal").show(); syncModalBodyClass(); initCertEditor(); }
    function closeCertModal() { $("#node-input-cert-modal").hide(); syncModalBodyClass(); }
    function openSettingsModal() { $("#node-input-settings-modal").show(); syncModalBodyClass(); }
    function closeSettingsModal() { $("#node-input-settings-modal").hide(); syncModalBodyClass(); }

    function initCertEditor() {
        selectedCertFolder = "rejected";
        selectedCertName = "";
        $("#opcua-cert-details").hide();
        $("#opcua-cert-folders .opcua-cert-item").removeClass("is-selected");
        $('#opcua-cert-folders .opcua-cert-item[data-folder="rejected"]').addClass("is-selected");
        fetchCertificates();
    }

    function fetchCertificates() {
        var filesContainer = $("#opcua-cert-files");
        filesContainer.empty().append('<div class="opcua-tree-empty"><i class="fa fa-spinner fa-spin"></i> Loading certificates...</div>');
        
        var currentServerName = $("#node-input-serverName").val() || "";

        $.ajax({
            url: "opc-ua-server/certificates",
            type: "GET",
            data: {
                serverName: currentServerName
            },
            dataType: "json",
            success: function (data) {
                certificatesData = data || { trusted: [], rejected: [] };
                renderCertificatesList();
            },
            error: function (xhr, textStatus, errorThrown) {
                filesContainer.empty().append('<div class="opcua-tree-empty" style="color: #d9534f;"><i class="fa fa-exclamation-triangle"></i> Failed to load certificates.</div>');
            }
        });
    }

    function renderCertificatesList() {
        var filesContainer = $("#opcua-cert-files");
        filesContainer.empty();
        
        var list = certificatesData[selectedCertFolder] || [];
        if (list.length === 0) {
            filesContainer.append('<div class="opcua-tree-empty">No certificates found in this folder.</div>');
            $("#opcua-cert-details").hide();
            return;
        }

        list.forEach(function (filename) {
            var item = $('<div class="opcua-cert-item"></div>');
            item.attr("data-name", filename);
            item.append('<i class="fa fa-certificate"></i> ' + escapeHtml(filename));
            if (filename === selectedCertName) {
                item.addClass("is-selected");
            }
            filesContainer.append(item);
        });

        // If previously selected cert is not in the list, hide details
        if (selectedCertName && list.indexOf(selectedCertName) === -1) {
            selectedCertName = "";
            $("#opcua-cert-details").hide();
        } else if (selectedCertName) {
            showCertificateDetails();
        }
    }

    function showCertificateDetails() {
        $("#opcua-selected-cert-name").text(selectedCertName);
        var targetSelect = $("#opcua-cert-target-folder");
        targetSelect.empty();
        
        if (selectedCertFolder === "rejected") {
            targetSelect.append('<option value="trusted">Trusted Certificates</option>');
        } else {
            targetSelect.append('<option value="rejected">Rejected Certificates</option>');
        }
        
        $("#opcua-cert-details").show();
    }

    function moveCertificate() {
        if (!selectedCertName) return;
        var targetFolder = $("#opcua-cert-target-folder").val();
        if (!targetFolder) return;

        var currentServerName = $("#node-input-serverName").val() || "";
        var moveBtn = $("#opcua-cert-move-btn");
        moveBtn.addClass("disabled").append(' <i class="fa fa-spinner fa-spin"></i>');

        $.ajax({
            url: "opc-ua-server/certificates/move",
            type: "POST",
            contentType: "application/json",
            data: JSON.stringify({
                serverName: currentServerName,
                filename: selectedCertName,
                fromFolder: selectedCertFolder,
                toFolder: targetFolder
            }),
            success: function (res) {
                moveBtn.removeClass("disabled").find("i.fa-spin").remove();
                selectedCertName = "";
                $("#opcua-cert-details").hide();
                RED.notify("Certificate moved successfully.", "success");
                fetchCertificates();
            },
            error: function (xhr, textStatus, errorThrown) {
                moveBtn.removeClass("disabled").find("i.fa-spin").remove();
                var errMsg = xhr.responseJSON && xhr.responseJSON.error ? xhr.responseJSON.error : "Failed to move certificate.";
                RED.notify(errMsg, "error");
            }
        });
    }

    function parseTree(rawValue, strict) {
        if (!rawValue) return { objects: [], folders: [], objectsTypes: [], enumerations: [], nameSpaces: [] };
        if (typeof rawValue === "object") return rawValue;
        try { var parsed = JSON.parse(rawValue); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed; }
        catch (error) { if (strict) throw error; }
        return { objects: [], folders: [], objectsTypes: [], enumerations: [], nameSpaces: [] };
    }

    function parseCredentialArray(rawValue) {
        if (!rawValue) return [];
        if (typeof rawValue === "object") return Array.isArray(rawValue) ? rawValue : [];
        try {
            var parsed = JSON.parse(rawValue);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    }

    function normalizeAuthGroup(group) {
        if (typeof group === "string") {
            return group.trim();
        }
        if (group && typeof group.name === "string") {
            return group.name.trim();
        }
        return "";
    }

    function normalizeAuthGroups(groups) {
        var seen = {};
        return parseCredentialArray(groups).map(normalizeAuthGroup).filter(function (groupName) {
            if (!groupName || seen[groupName]) return false;
            seen[groupName] = true;
            return true;
        });
    }

    function normalizeAuthUser(user) {
        user = user || {};
        return {
            username: user.username ? String(user.username).trim() : "",
            password: user.password ? String(user.password) : "",
            passwordHash: user.passwordHash ? String(user.passwordHash) : "",
            group: user.group ? String(user.group).trim() : (user.role ? String(user.role).trim() : "")
        };
    }

    function normalizeAuthUsers(users) {
        return parseCredentialArray(users).map(normalizeAuthUser);
    }

    function reconcileAuthGroupsFromUsers() {
        authUsers.forEach(function (user) {
            if (user && user.group) {
                var groups = String(user.group).split(",").map(function (g) { return g.trim(); }).filter(Boolean);
                groups.forEach(function (groupName) {
                    if (authGroups.indexOf(groupName) === -1) {
                        authGroups.push(groupName);
                    }
                });
            }
        });
    }



    function syncAuthCredentialFields() {
        reconcileAuthGroupsFromUsers();
        $("#node-input-groups").val(JSON.stringify(authGroups));
        $("#node-input-users").val(JSON.stringify(authUsers.map(function (user) {
            return {
                username: user.username,
                password: user.password,
                passwordHash: user.passwordHash,
                group: user.group
            };
        })));
    }



    function normalizeNamespaceId(value) {
        var parsed = Number(value);
        return Number.isInteger(parsed) && parsed >= DEFAULT_NAMESPACE_ID ? parsed : DEFAULT_NAMESPACE_ID;
    }

    function normalizeNamespaceDefinition(namespaceItem) {
        namespaceItem = namespaceItem || {};
        return {
            id: normalizeNamespaceId(namespaceItem.id),
            name: namespaceItem.name ? String(namespaceItem.name) : ""
        };
    }

    function normalizeAccessPermissionValues(values) {
        if (values === undefined || values === null || values === "") {
            values = ["public"];
        }
        if (typeof values === "string") {
            values = values.indexOf(",") >= 0 ? values.split(",") : [values];
        }
        if (!Array.isArray(values)) {
            values = ["public"];
        }
        var seen = {};
        var normalized = values.map(function (value) {
            return String(value || "").trim().toLowerCase();
        }).filter(function (value) {
            if (!value || seen[value]) return false;
            seen[value] = true;
            return true;
        });
        return normalized.length ? normalized : ["public"];
    }

    function ensureNamespaces(tree) {
        if (!Array.isArray(tree.nameSpaces)) tree.nameSpaces = [];
        var hasDefaultNamespace = tree.nameSpaces.some(function (item) { return normalizeNamespaceId(item.id) === DEFAULT_NAMESPACE_ID; });
        if (!hasDefaultNamespace) {
            tree.nameSpaces.unshift(normalizeNamespaceDefinition({
                id: DEFAULT_NAMESPACE_ID,
                name: $("#node-input-namespaceUri").val() || "urn:node-red:opc-ua-server"
            }));
        }

        tree.nameSpaces = tree.nameSpaces
            .map(normalizeNamespaceDefinition)
            .sort(function (left, right) { return left.id - right.id; });

        return tree;
    }

    function normalizeVariable(variable) {
        return {
            name: variable && variable.name ? String(variable.name) : "",
            type: variable && variable.type ? String(variable.type) : "Int32",
            value: variable && variable.value !== undefined ? variable.value : "",
            access: variable && variable.access ? String(variable.access).toLowerCase() : "readwrite",
            description: variable && variable.description ? String(variable.description) : "",
            displayName: variable && variable.displayName ? String(variable.displayName) : "",
            nodeId: variable && variable.nodeId ? String(variable.nodeId) : "",
            namespaceId: normalizeNamespaceId(variable && variable.namespaceId),
            accessPermission: normalizeAccessPermissionValues(variable && (variable.accessPermission || variable.accessPermissions))
        };
    }
    function normalizeAlarm(alarm) {
        alarm = alarm || {};
        var type = alarm.type ? String(alarm.type) : "levelAlarm";
        return {
            name: alarm.name ? String(alarm.name) : "",
            variableNodeId: alarm.variableNodeId ? String(alarm.variableNodeId) : "",
            type: type,
            enabled: alarm.enabled !== undefined ? !!alarm.enabled : true,
            sendValue: alarm.sendValue !== undefined ? !!alarm.sendValue : true,
            severity: alarm.severity !== undefined ? alarm.severity : 500,
            description: alarm.description ? String(alarm.description) : "",
            displayName: alarm.displayName ? String(alarm.displayName) : "",
            nodeId: alarm.nodeId ? String(alarm.nodeId) : "",
            namespaceId: normalizeNamespaceId(alarm.namespaceId),
            accessPermission: normalizeAccessPermissionValues(alarm.accessPermission || alarm.accessPermissions),
            highHighLimit: alarm.highHighLimit !== undefined ? alarm.highHighLimit : 90,
            highHighMessage: alarm.highHighMessage ? String(alarm.highHighMessage) : "High High alarm",
            highLimit: alarm.highLimit !== undefined ? alarm.highLimit : 80,
            highMessage: alarm.highMessage ? String(alarm.highMessage) : "High alarm",
            lowLimit: alarm.lowLimit !== undefined ? alarm.lowLimit : 20,
            lowMessage: alarm.lowMessage ? String(alarm.lowMessage) : "Low alarm",
            lowLowLimit: alarm.lowLowLimit !== undefined ? alarm.lowLowLimit : 10,
            lowLowMessage: alarm.lowLowMessage ? String(alarm.lowLowMessage) : "Low Low alarm",
            normalStateValue: alarm.normalStateValue !== undefined ? alarm.normalStateValue : 0,
            digitalMessage: alarm.digitalMessage ? String(alarm.digitalMessage) : "Digital alarm"
        };
    }

    function normalizeMethodArg(arg) {
        arg = arg || {};
        return {
            name: arg.name ? String(arg.name) : "",
            type: arg.type ? String(arg.type) : "Float",
            displayName: arg.displayName ? String(arg.displayName) : "",
            description: arg.description ? String(arg.description) : ""
        };
    }

    function normalizeMethod(method) {
        method = method || {};
        return {
            name: method.name ? String(method.name) : "",
            description: method.description ? String(method.description) : "",
            displayName: method.displayName ? String(method.displayName) : "",
            nodeId: method.nodeId ? String(method.nodeId) : "",
            namespaceId: normalizeNamespaceId(method.namespaceId),
            accessPermission: normalizeAccessPermissionValues(method.accessPermission || method.accessPermissions),
            inputs: Array.isArray(method.inputs)
                ? method.inputs.map(normalizeMethodArg)
                : Array.isArray(method.inputArguments)
                    ? method.inputArguments.map(normalizeMethodArg)
                    : [],
            outputs: Array.isArray(method.outputs)
                ? method.outputs.map(normalizeMethodArg)
                : Array.isArray(method.outputArguments)
                    ? method.outputArguments.map(normalizeMethodArg)
                    : []
        };
    }

    function normalizeEnumerationState(state) {
        state = state || {};
        return {
            value: state.value !== undefined ? Number(state.value) : 0,
            displayName: state.displayName ? String(state.displayName) : ""
        };
    }

    function normalizeEnumeration(enumeration) {
        enumeration = enumeration || {};
        return {
            name: enumeration.name ? String(enumeration.name) : "",
            description: enumeration.description ? String(enumeration.description) : "",
            displayName: enumeration.displayName ? String(enumeration.displayName) : "",
            nodeId: enumeration.nodeId ? String(enumeration.nodeId) : "",
            namespaceId: normalizeNamespaceId(enumeration.namespaceId),
            accessPermission: normalizeAccessPermissionValues(enumeration.accessPermission || enumeration.accessPermissions),
            enumeration: Array.isArray(enumeration.enumeration)
                ? enumeration.enumeration.map(normalizeEnumerationState)
                : []
        };
    }

    function normalizeBranch(branch) {
        branch = branch || {};
        return {
            name: branch.name ? String(branch.name) : "",
            displayName: branch.displayName ? String(branch.displayName) : "",
            description: branch.description ? String(branch.description) : "",
            nodeId: branch.nodeId ? String(branch.nodeId) : "",
            namespaceId: normalizeNamespaceId(branch.namespaceId),
            accessPermission: normalizeAccessPermissionValues(branch.accessPermission || branch.accessPermissions),
            objectsType: branch.objectsType ? String(branch.objectsType) : (branch.objectType ? String(branch.objectType) : ""),
            folders: Array.isArray(branch.folders) ? branch.folders.map(normalizeBranch) : [],
            objects: Array.isArray(branch.objects) ? branch.objects.map(normalizeBranch) : [],
            variables: Array.isArray(branch.variables) ? branch.variables.map(normalizeVariable) : [],
            alarms: Array.isArray(branch.alarms) ? branch.alarms.map(normalizeAlarm) : [],
            methods: Array.isArray(branch.methods) ? branch.methods.map(normalizeMethod) : (Array.isArray(branch.method) ? branch.method.map(normalizeMethod) : []),
            objectsTypes: Array.isArray(branch.objectsTypes) ? branch.objectsTypes.map(normalizeBranch) : []
        };
    }

    function normalizeTree(tree) {
        tree = ensureNamespaces(tree || {});
        return ensureNamespaces({
            objects: Array.isArray(tree.objects) ? tree.objects.map(normalizeBranch) : [],
            folders: Array.isArray(tree.folders) ? tree.folders.map(normalizeBranch) : [],
            objectsTypes: Array.isArray(tree.objectsTypes) ? tree.objectsTypes.map(normalizeBranch) : (Array.isArray(tree.objectTypes) ? tree.objectTypes.map(normalizeBranch) : []),
            enumerations: Array.isArray(tree.enumerations) ? tree.enumerations.map(normalizeEnumeration) : (Array.isArray(tree.enumeration) ? tree.enumeration.map(normalizeEnumeration) : []),
            nameSpaces: Array.isArray(tree.nameSpaces) ? tree.nameSpaces.map(normalizeNamespaceDefinition) : (Array.isArray(tree.namespaces) ? tree.namespaces.map(normalizeNamespaceDefinition) : [])
        });
    }

    function prettyTree(tree) { return JSON.stringify(normalizeTree(tree), null, 2); }
    function cloneTree(tree) { return JSON.parse(prettyTree(tree)); }
    function pathToTokens(path) { return String(path || "").split(".").filter(function (t) { return t !== ""; }); }

    function getAtPath(tree, path) {
        return pathToTokens(path).reduce(function (current, token) {
            if (current === undefined || current === null) return undefined;
            if (/^\d+$/.test(token)) return current[Number(token)];
            return current[token];
        }, tree);
    }

    function removeAtPath(tree, path) {
        var tokens = pathToTokens(path);
        var lastToken = tokens.pop();
        var parent = getAtPath(tree, tokens.join("."));
        if (parent === undefined || parent === null || lastToken === undefined) return;
        if (/^\d+$/.test(lastToken) && Array.isArray(parent)) parent.splice(Number(lastToken), 1);
        else delete parent[lastToken];
    }

    function updateTreeField(serializedTree, notifyChange) {
        var field = $("#node-input-tree");
        var previousValue = field.val();
        field.val(serializedTree);
        if (notifyChange && previousValue !== serializedTree) field.trigger("change");
    }

    function syncStateToJson(notifyChange) {
        if (isSyncing) return;
        isSyncing = true;
        enforceFixedNodeIdsInObjectTypeModels(editorState);
        var json = prettyTree(editorState);
        updateTreeField(json, false);
        $("#node-input-tree-editor").typedInput("value", json);
        if (notifyChange) $("#node-input-tree").trigger("change");
        isSyncing = false;
    }

    function normalizeSearchTerm(value) { return String(value || "").trim().toLowerCase(); }
    function isExpanded(path, defaultValue) { if (expansionState[path] === undefined) expansionState[path] = !!defaultValue; return expansionState[path]; }
    function nodeClassFromPath(path) {
        if (path && path.indexOf("virtual:") === 0) return "VisualFolder";
        var tokens = pathToTokens(path);
        if (!tokens.length) return "Object";

        var collectionToken = tokens.length > 1 ? tokens[tokens.length - 2] : tokens[0];
        if (collectionToken === "variables") return "Variable";
        if (collectionToken === "methods") return "Method";
        if (collectionToken === "alarms") return "Alarm";
        if (collectionToken === "objectsTypes" || collectionToken === "objectTypes") return "ObjectType";
        if (collectionToken === "enumerations" || collectionToken === "enumeration") return "Enumeration";
        if (collectionToken === "nameSpaces" || collectionToken === "namespaces") return "Namespace";
        if (collectionToken === "folders") return "Folder";
        return "Object";
    }
    function getVirtualNodeName(path) {
        if (path === "virtual:Objects") return "Objects";
        if (path === "virtual:Types") return "Types";
        if (path === "virtual:Types.ObjectTypes") return "ObjectTypes";
        if (path === "virtual:Types.DataTypes") return "DataTypes";
        return "";
    }
    function getNodeDisplayName(path) {
        if (path && path.indexOf("virtual:") === 0) return getVirtualNodeName(path);
        var item = getAtPath(editorState, path);
        return item ? (item.name || "(unnamed)") : "";
    }
    function getNamespaceOptions() {
        return Array.isArray(editorState.nameSpaces) ? editorState.nameSpaces.slice().sort(function (left, right) { return left.id - right.id; }) : [];
    }

    function getDefinedObjectTypeNames() {
        var names = [];
        (editorState.objectsTypes || []).forEach(function (ot) {
            if (ot && ot.name) names.push(String(ot.name));
        });
        return names;
    }


    function buildObjectTypeSelect(id, currentValue) {
        var names = getDefinedObjectTypeNames();
        var cv = String(currentValue || "");
        var opts = "";
        var noneSelected = (cv === "") ? " selected" : "";
        opts += "<option value=\"\"" + noneSelected + ">\u2014 none \u2014</option>";
        names.forEach(function (n) {
            var esc = n.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            var sel = (n === cv) ? " selected" : "";
            opts += "<option value=\"" + esc + "\"" + sel + ">" + esc + "</option>";
        });
        return "<select id=\"" + id + "\">" + opts + "</select>";
    }

    function getDefinedEnumerationNames() {
        var names = [];
        (editorState.enumerations || []).forEach(function (e) {
            if (e && e.name) names.push(String(e.name));
        });
        return names;
    }

    function buildEnumerationSelect(id, currentValue) {
        var names = getDefinedEnumerationNames();
        var cv = String(currentValue || "");
        var opts = "";
        var noneSelected = (cv === "") ? " selected" : "";
        opts += "<option value=\"\"" + noneSelected + ">\u2014 none \u2014</option>";
        names.forEach(function (n) {
            var esc = n.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            var sel = (n === cv) ? " selected" : "";
            opts += "<option value=\"" + esc + "\"" + sel + ">" + esc + "</option>";
        });
        return "<select id=\"" + id + "\">" + opts + "</select>";
    }

    function getAvailableAccessPermissionOptions() {
        var values = ["public"].concat(authGroups || []);
        return normalizeAccessPermissionValues(values);
    }

    function buildAccessPermissionSelect(id, currentValues) {
        var values = normalizeAccessPermissionValues(currentValues);
        var currentValue = values.length ? values[0] : "public";
        var options = getAvailableAccessPermissionOptions();

        if (options.indexOf(currentValue) === -1) {
            options.push(currentValue);
        }

        var html = '<select id="' + id + '">';
        options.forEach(function (value) {
            var escaped = escapeHtml(value);
            var selected = value === currentValue ? " selected" : "";
            html += '<option value="' + escaped + '"' + selected + '>' + escaped + "</option>";
        });
        html += "</select>";
        return html;
    }

    function getNamespaceLabel(namespaceId) {
        var match = getNamespaceOptions().find(function (item) { return item.id === normalizeNamespaceId(namespaceId); });
        return match ? String(match.id) + " - " + match.name : String(normalizeNamespaceId(namespaceId));
    }
    function getNodeNamespaceId(path) {
        var item = getAtPath(editorState, path);
        return normalizeNamespaceId(item && item.namespaceId);
    }
    function getNodeIdPrefix(namespaceId) {
        return "ns=" + normalizeNamespaceId(namespaceId) + ";s=";
    }

    function buildDefaultNodeIdSuffixFromEditorPath(path) {
        var tokens = pathToTokens(path);
        var current = editorState;
        var parts = [];
        //  var preservedCollections = { alarms: true, methods: true, objectsTypes: true };
        var preservedCollections = { alarms: true, methods: true };

        tokens.forEach(function (token) {
            if (/^\d+$/.test(token)) {
                current = current ? current[Number(token)] : null;
                if (current && current.name) parts.push(current.name);
                return;
            }

            current = current ? current[token] : null;
            if (preservedCollections[token]) parts.push(token);
        });

        return parts.join(".");
    }


    function nodeIdSuffixFromValue(nodeId, defaultSuffix) {
        var raw = String(nodeId || "").trim();
        if (!raw) return defaultSuffix;
        var match = /^ns=\d+;[si]=(.*)$/.exec(raw);
        if (match) return match[1];
        return raw;
    }
    function isObjectTypeModelPath(path) {
        var tokens = pathToTokens(path);
        return tokens.length > 0 && tokens[0] === "objectsTypes";
    }
    function buildGeneratedNodeIdForPath(path) {
        return getNodeIdPrefix(getNodeNamespaceId(path)) + buildDefaultNodeIdSuffixFromEditorPath(path);
    }
    function assignFixedNodeIdsToBranch(path) {
        var branch = getAtPath(editorState, path);
        if (!branch || typeof branch !== "object") return;
        branch.nodeId = buildGeneratedNodeIdForPath(path);
        (branch.folders || []).forEach(function (_, index) { assignFixedNodeIdsToBranch(path + ".folders." + index); });
        (branch.objects || []).forEach(function (_, index) { assignFixedNodeIdsToBranch(path + ".objects." + index); });
        (branch.variables || []).forEach(function (item, index) {
            if (!item) return;
            item.nodeId = buildGeneratedNodeIdForPath(path + ".variables." + index);
        });
        (branch.methods || []).forEach(function (item, index) {
            if (!item) return;
            item.nodeId = buildGeneratedNodeIdForPath(path + ".methods." + index);
        });
        (branch.alarms || []).forEach(function (item, index) {
            if (!item) return;
            item.nodeId = buildGeneratedNodeIdForPath(path + ".alarms." + index);
        });
        (branch.objectsTypes || []).forEach(function (_, index) { assignFixedNodeIdsToBranch(path + ".objectsTypes." + index); });
    }
    function enforceFixedNodeIdsInObjectTypeModels(tree) {
        (tree.objectsTypes || []).forEach(function (_, index) {
            assignFixedNodeIdsToBranch("objectsTypes." + index);
        });
        return tree;
    }
    function buildDisplayNodeIdFromEditorPath(path) {
        var item = getAtPath(editorState, path);
        if (isObjectTypeModelPath(path)) return buildGeneratedNodeIdForPath(path);
        var customNodeId = item && item.nodeId ? String(item.nodeId).trim() : "";
        if (customNodeId) {
            if (/^ns=\d+;[si]=/.test(customNodeId)) {
                return customNodeId;
            }
            return getNodeIdPrefix(getNodeNamespaceId(path)) + customNodeId;
        }
        return buildGeneratedNodeIdForPath(path);
    }
    function parseNodeId(nodeId, defaultSuffix) {
        var raw = String(nodeId || "").trim();
        if (!raw) {
            return { type: "s", value: defaultSuffix };
        }
        var match = /^ns=\d+;([si])=(.*)$/.exec(raw);
        if (match) {
            return { type: match[1], value: match[2] };
        }
        return { type: "s", value: raw };
    }
    function updateNodeIdValueInputState(mode, type) {
        var inputId = "#opcua-" + mode + "-nodeid-value";
        var labelId = "#opcua-" + mode + "-nodeid-value-label";
        var input = $(inputId);
        var label = $(labelId);

        if (type === "i") {
            if (label.length) label.text("nodeId Value (Numeric)");
            input.attr("type", "number");
            input.attr("step", "1");
            input.attr("placeholder", "Enter a number");
        } else {
            if (label.length) label.text("nodeId Value (String)");
            input.attr("type", "text");
            input.removeAttr("step");
            if (mode === "create") {
                input.attr("placeholder", "Leave blank for default (s)");
            } else {
                input.attr("placeholder", "Enter a string");
            }
        }
    }
    function saveDetailNodeId(path) {
        if (!path) return;
        var type = $("#opcua-detail-nodeid-type").val();
        var rawVal = $("#opcua-detail-nodeid-value").val();
        var nsId = getNodeNamespaceId(path);
        
        var customNodeId = "";
        if (rawVal) {
            if (type === "i") {
                var numVal = parseInt(rawVal, 10);
                if (!isNaN(numVal)) {
                    customNodeId = "ns=" + nsId + ";i=" + numVal;
                }
            } else {
                var defaultSuffix = buildDefaultNodeIdSuffixFromEditorPath(path);
                var nextSuffix = String(rawVal).trim();
                if (nextSuffix && nextSuffix !== defaultSuffix) {
                    customNodeId = "ns=" + nsId + ";s=" + nextSuffix;
                }
            }
        }
        updateNode(path, { nodeId: customNodeId });
    }
    function normalizeCustomNodeIdFromSuffix(path, suffix) {
        if (isObjectTypeModelPath(path)) return "";
        var nextSuffix = String(suffix || "").trim();
        var defaultSuffix = buildDefaultNodeIdSuffixFromEditorPath(path);
        if (!nextSuffix || nextSuffix === defaultSuffix) return "";
        return getNodeIdPrefix(getNodeNamespaceId(path)) + nextSuffix;
    }
    function copyNodeIdValue(nodeId) {
        if (!nodeId) {
            RED.notify("NodeId not found for the selected item.", "warning");
            return;
        }

        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            navigator.clipboard.writeText(nodeId).then(function () {
                RED.notify("NodeId copied.", "success");
            }).catch(function () {
                RED.notify("Failed to copy NodeId.", "error");
            });
            return;
        }

        var input = $("<textarea readonly></textarea>").val(nodeId).css({
            position: "fixed",
            left: "-9999px",
            top: "0"
        });
        $("body").append(input);
        input[0].select();
        try {
            document.execCommand("copy");
            RED.notify("NodeId copied.", "success");
        } catch (error) {
            RED.notify("Failed to copy NodeId.", "error");
        }
        input.remove();
    }

    function getChildrenByPath(path) {
        if (path === "virtual:Objects") {
            var children = [];
            (editorState.folders || []).forEach(function (_, i) { children.push("folders." + i); });
            (editorState.objects || []).forEach(function (_, i) { children.push("objects." + i); });
            return children;
        }
        if (path === "virtual:Types") {
            return ["virtual:Types.ObjectTypes", "virtual:Types.DataTypes"];
        }
        if (path === "virtual:Types.ObjectTypes") {
            var children = [];
            (editorState.objectsTypes || []).forEach(function (_, i) { children.push("objectsTypes." + i); });
            return children;
        }
        if (path === "virtual:Types.DataTypes") {
            var children = [];
            (editorState.enumerations || []).forEach(function (_, i) { children.push("enumerations." + i); });
            return children;
        }
        var item = getAtPath(editorState, path);
        if (!item) return [];
        var children = [];
        (item.folders || []).forEach(function (_, i) { children.push(path + ".folders." + i); });
        (item.objects || []).forEach(function (_, i) { children.push(path + ".objects." + i); });
        (item.variables || []).forEach(function (_, i) { children.push(path + ".variables." + i); });
        (item.methods || []).forEach(function (_, i) { children.push(path + ".methods." + i); });
        (item.alarms || []).forEach(function (_, i) { children.push(path + ".alarms." + i); });
        (item.objectsTypes || []).forEach(function (_, i) { children.push(path + ".objectsTypes." + i); });
        return children;
    }

    function getTopLevelPaths() {
        var paths = ["virtual:Objects", "virtual:Types"];
        (editorState.nameSpaces || []).forEach(function (_, i) { paths.push("nameSpaces." + i); });
        return paths;
    }

    function selectNode(path) {
        selectedPath = path || "";
        renderVisualEditor();
    }

    function nodeMatchesSearch(path) {
        if (!treeSearchTerm) return true;
        if (path && path.indexOf("virtual:") === 0) {
            return getVirtualNodeName(path).toLowerCase().indexOf(treeSearchTerm) !== -1;
        }
        var item = getAtPath(editorState, path);
        if (!item) return false;
        var values = [path, item.name, item.displayName, item.description, nodeClassFromPath(path), item.type, item.value, item.id, item.namespaceId];
        return values.some(function (x) { return String(x || "").toLowerCase().indexOf(treeSearchTerm) !== -1; });
    }

    function branchHasSearchMatch(path) {
        if (nodeMatchesSearch(path)) return true;
        return getChildrenByPath(path).some(branchHasSearchMatch);
    }

    function iconForNodeClass(nodeClass) {
        if (nodeClass === "Folder" || nodeClass === "VisualFolder") return "fa-folder";
        if (nodeClass === "Object") return "fa-cube";
        if (nodeClass === "Variable") return "fa-tag";
        if (nodeClass === "ObjectType") return "fa-cubes";
        if (nodeClass === "Enumeration") return "fa-list-ol";
        if (nodeClass === "Namespace") return "fa-sitemap";
        if (nodeClass === "Alarm") return "fa-bell";
        if (nodeClass === "Method") return "fa-cog";
        return "fa-tag";
    }

    // ── performance helpers ───────────────────────────────────────────
    var _renderTreePending = false;

    function debounce(fn, delay) {
        var timer;
        return function () { var ctx = this, args = arguments; clearTimeout(timer); timer = setTimeout(function () { fn.apply(ctx, args); }, delay); };
    }

    function escapeHtml(v) {
        return String(v || "").replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    function appendNodeToFrag(frag, path, depth, ancestorMatched) {
        var item = (path && path.indexOf("virtual:") === 0) ? {} : getAtPath(editorState, path);
        if (!item) return;
        var nodeClass = nodeClassFromPath(path);
        var hasChildren = nodeClass !== "Variable" && nodeClass !== "Alarm" && nodeClass !== "Namespace" && getChildrenByPath(path).length > 0;
        var expanded = isExpanded(path, depth < 1 || !!treeSearchTerm);
        var subtreeVisible = !!ancestorMatched || nodeMatchesSearch(path);

        var indents = "";
        for (var i = 0; i < depth; i++) indents += '<span class="opcua-tree-indent"></span>';

        var row = document.createElement("div");
        row.className = "opcua-tree-row" + (path === selectedPath ? " is-selected" : "");
        row.setAttribute("data-path", path);
        var label = (path && path.indexOf("virtual:") === 0) ? getVirtualNodeName(path) : (item.name || "(unnamed)");
        var displayClass = (path && path.indexOf("virtual:") === 0) ? "Folder" : nodeClass;
        row.innerHTML = indents
            + '<span class="opcua-tree-twisty">' + (hasChildren ? '<i class="fa ' + (expanded ? "fa-caret-down" : "fa-caret-right") + '"></i>' : "") + "</span>"
            + '<span class="opcua-tree-icon"><i class="fa ' + iconForNodeClass(nodeClass) + '"></i></span>'
            + '<span class="opcua-tree-label">' + escapeHtml(label) + "</span>"
            + '<span class="opcua-tree-type">' + escapeHtml(displayClass) + "</span>";
        frag.appendChild(row);

        if (hasChildren && expanded) {
            getChildrenByPath(path).forEach(function (childPath) {
                if (!treeSearchTerm || subtreeVisible || branchHasSearchMatch(childPath)) {
                    appendNodeToFrag(frag, childPath, depth + 1, subtreeVisible);
                }
            });
        }
    }

    function renderTree() {
        if (_renderTreePending) return;
        _renderTreePending = true;
        setTimeout(function () {
            _renderTreePending = false;
            var list = document.getElementById("node-input-object-list");
            if (!list) return;
            var frag = document.createDocumentFragment();
            var roots = getTopLevelPaths();
            if (!roots.length) {
                var empty = document.createElement("div");
                empty.className = "opcua-tree-empty";
                empty.textContent = "No OPC UA items. Use Add folder, Add object, or Add namespace.";
                frag.appendChild(empty);
            } else {
                roots.forEach(function (path) {
                    if (!treeSearchTerm || branchHasSearchMatch(path)) appendNodeToFrag(frag, path, 0, false);
                });
            }
            list.innerHTML = "";
            list.appendChild(frag);
        }, 0);
    }

    function renderBreadcrumbs() {
        var el = $("#opcua-tree-breadcrumbs");
        if (!selectedPath) { el.text("No selection"); return; }
        if (selectedPath.indexOf("virtual:") === 0) {
            var parts = [];
            if (selectedPath === "virtual:Objects") parts = ["Objects"];
            else if (selectedPath === "virtual:Types") parts = ["Types"];
            else if (selectedPath === "virtual:Types.ObjectTypes") parts = ["Types", "ObjectTypes"];
            else if (selectedPath === "virtual:Types.DataTypes") parts = ["Types", "DataTypes"];
            el.text(parts.join("."));
            return;
        }
        var tokens = pathToTokens(selectedPath);
        var cursor = [];
        var parts = [];
        var rootToken = tokens[0];
        if (rootToken === "folders" || rootToken === "objects") {
            parts.push("Objects");
        } else if (rootToken === "objectsTypes") {
            parts.push("Types");
            parts.push("ObjectTypes");
        } else if (rootToken === "enumerations") {
            parts.push("Types");
            parts.push("DataTypes");
        }
        tokens.forEach(function (token) {
            cursor.push(token);
            if (/^\d+$/.test(token)) parts.push(getNodeDisplayName(cursor.join(".")) || ("#" + token));
        });
        el.text(parts.join("."));
    }

    function updateNode(path, patch) {
        var item = getAtPath(editorState, path);
        if (!item) return;
        Object.keys(patch || {}).forEach(function (k) { item[k] = patch[k]; });
        syncStateToJson(false);
        // Avoid rebuilding the details form on every keystroke to preserve input focus.
        renderTree();
        renderBreadcrumbs();
    }

    function openCreateForm(path, kind) {
        if (!path) return;
        if (path.indexOf("virtual:") === 0) {
            if (path === "virtual:Objects") {
                if (kind !== "folder" && kind !== "object") {
                    RED.notify("Only Folders and Objects can be added directly under Objects", "warning");
                    return;
                }
            } else if (path === "virtual:Types.ObjectTypes") {
                if (kind !== "objecttype") {
                    RED.notify("Only ObjectTypes can be added under ObjectTypes", "warning");
                    return;
                }
            } else if (path === "virtual:Types.DataTypes") {
                if (kind !== "enumeration") {
                    RED.notify("Only Enumerations can be added under DataTypes", "warning");
                    return;
                }
            } else {
                RED.notify("Cannot add children to this visual folder", "warning");
                return;
            }
        } else if (nodeClassFromPath(path) === "Variable" || nodeClassFromPath(path) === "Namespace") {
            RED.notify("Selected item cannot have children", "warning");
            return;
        }
        var parentSuffix = path.indexOf("virtual:") === 0 ? "" : buildDefaultNodeIdSuffixFromEditorPath(path);
        var defaultName = kind === "variable" ? "newVariable" : kind === "enum-variable" ? "newEnumVariable" : "newObject";
        var defaultSuffix = parentSuffix ? parentSuffix + "." + defaultName : defaultName;

        pendingCreate = {
            parentPath: path,
            kind: kind,
            name: defaultName,
            displayName: "",
            dataType: kind === "enum-variable" ? (getDefinedEnumerationNames()[0] || "") : "Int32",
            value: "",
            access: "readwrite",
            accessPermission: ["public"],
            objectsType: "",
            alarmType: "levelAlarm",
            variableNodeId: "",
            severity: 500,
            sendValue: true,
            highHighLimit: 90,
            highHighMessage: "High High alarm",
            highLimit: 80,
            highMessage: "High alarm",
            lowLimit: 20,
            lowMessage: "Low alarm",
            lowLowLimit: 10,
            lowLowMessage: "Low Low alarm",
            normalStateValue: 0,
            digitalMessage: "Digital alarm",
            nodeIdType: "s",
            nodeIdValue: (kind === "variable" || kind === "enum-variable") ? defaultSuffix : ""
        };
        renderDetails();
    }

    function saveCreateForm() {
        if (!pendingCreate) return;
        var parentPath = pendingCreate.parentPath;
        var kind = pendingCreate.kind;
        var branchTargetPath;
        if (parentPath.indexOf("virtual:") === 0) {
            if (parentPath === "virtual:Objects") {
                branchTargetPath = kind === "folder" ? "folders" : "objects";
            } else if (parentPath === "virtual:Types.ObjectTypes") {
                branchTargetPath = "objectsTypes";
            } else {
                return;
            }
        } else {
            branchTargetPath = (kind === "variable" || kind === "enum-variable")
                ? (parentPath + ".variables")
                : kind === "folder"
                    ? (parentPath + ".folders")
                    : kind === "objecttype"
                        ? (parentPath + ".objectsTypes")
                        : kind === "alarm"
                            ? (parentPath + ".alarms")
                            : kind === "method"
                                ? (parentPath + ".methods")
                                : (parentPath + ".objects");
        }
        var target = getAtPath(editorState, branchTargetPath);
        if (!Array.isArray(target)) return;
        if (kind === "variable" || kind === "enum-variable") {
            var customNodeId = "";
            var nsId = getNodeNamespaceId(parentPath);
            if (pendingCreate.nodeIdValue) {
                if (pendingCreate.nodeIdType === "i") {
                    var numVal = parseInt(pendingCreate.nodeIdValue, 10);
                    if (!isNaN(numVal)) {
                        customNodeId = "ns=" + nsId + ";i=" + numVal;
                    }
                } else {
                    customNodeId = "ns=" + nsId + ";s=" + pendingCreate.nodeIdValue.trim();
                }
            }
            target.push(normalizeVariable({
                name: pendingCreate.name,
                displayName: pendingCreate.displayName || "",
                type: pendingCreate.dataType,
                value: pendingCreate.value,
                access: pendingCreate.access || "readwrite",
                accessPermission: pendingCreate.accessPermission,
                nodeId: customNodeId
            }));
        } else if (kind === "folder") {
            target.push(normalizeBranch({ name: pendingCreate.name, displayName: pendingCreate.displayName || "", accessPermission: pendingCreate.accessPermission }));
        } else if (kind === "objecttype") {
            target.push(normalizeBranch({ name: pendingCreate.name, displayName: pendingCreate.displayName || "", objectsType: pendingCreate.objectsType || "", accessPermission: pendingCreate.accessPermission }));
            target[target.length - 1].nodeId = buildGeneratedNodeIdForPath(branchTargetPath + "." + (target.length - 1));
        } else if (kind === "alarm") {
            target.push(normalizeAlarm({
                displayName: pendingCreate.displayName || "",
                name: pendingCreate.name,
                accessPermission: pendingCreate.accessPermission,
                type: pendingCreate.alarmType,
                variableNodeId: pendingCreate.variableNodeId,
                severity: Number(pendingCreate.severity || 500),
                sendValue: pendingCreate.sendValue,
                highHighLimit: pendingCreate.highHighLimit,
                highHighMessage: pendingCreate.highHighMessage,
                highLimit: pendingCreate.highLimit,
                highMessage: pendingCreate.highMessage,
                lowLimit: pendingCreate.lowLimit,
                lowMessage: pendingCreate.lowMessage,
                lowLowLimit: pendingCreate.lowLowLimit,
                lowLowMessage: pendingCreate.lowLowMessage,
                normalStateValue: pendingCreate.normalStateValue,
                digitalMessage: pendingCreate.digitalMessage
            }));
        } else if (kind === "method") {
            target.push(normalizeMethod({ name: pendingCreate.name, displayName: pendingCreate.displayName || "", accessPermission: pendingCreate.accessPermission }));
        } else {
            target.push(normalizeBranch({ name: pendingCreate.name, displayName: pendingCreate.displayName || "", accessPermission: pendingCreate.accessPermission }));
        }
        expansionState[parentPath] = true;
        pendingCreate = null;
        syncStateToJson(true);
        renderVisualEditor();
    }

    function cancelCreateForm() {
        pendingCreate = null;
        renderDetails();
    }

    function renderDetails() {
        var panel = $("#opcua-tree-details");
        panel.empty();
        if (pendingCreate) {
            panel.append('<div class="form-row"><label>Parent</label><input type="text" id="opcua-create-parent" readonly></div>');
            panel.append('<div class="form-row"><label>Type</label><input type="text" id="opcua-create-kind" readonly></div>');
            panel.append('<div class="form-row"><label>Name</label><input type="text" id="opcua-create-name"></div>');
            panel.append('<div class="form-row"><label>displayName</label><input type="text" id="opcua-create-displayname" placeholder="Leave blank to use browseName"></div>');
            panel.append('<div class="form-row"><label>accessPermission</label>' + buildAccessPermissionSelect("opcua-create-accesspermission", pendingCreate.accessPermission || ["public"]) + '</div>');
            if (pendingCreate.kind === "variable" || pendingCreate.kind === "enum-variable") {
                var isEnum = pendingCreate.kind === "enum-variable";
                var typeHtml = isEnum ? buildEnumerationSelect("opcua-create-type", pendingCreate.dataType) : '<select id="opcua-create-type"><option value="Int16">Int16</option><option value="Int32">Int32</option><option value="Int64">Int64</option><option value="Float">Float</option><option value="Boolean">Boolean</option><option value="String">String</option></select>';
                panel.append('<div class="form-row"><label>dataType</label>' + typeHtml + '</div>');
                panel.append('<div class="form-row"><label>Value</label><input type="text" id="opcua-create-value"></div>');
                panel.append('<div class="form-row"><label>Access</label><select id="opcua-create-access"><option value="readwrite">readwrite</option><option value="readonly">readonly</option></select></div>');
                panel.append('<div class="form-row"><label>nodeId Type</label><select id="opcua-create-nodeid-type"><option value="s">s (String)</option><option value="i">i (Numeric)</option></select></div>');
                panel.append('<div class="form-row" id="opcua-create-nodeid-value-row"><label id="opcua-create-nodeid-value-label">nodeId Value</label><input type="text" id="opcua-create-nodeid-value" placeholder="Leave blank for default (s)"></div>');
            }
            if (pendingCreate.kind === "objecttype") {
                panel.append('<div class="form-row"><label>objectsType</label>' + buildObjectTypeSelect("opcua-create-objectstype", pendingCreate.objectsType || "") + '</div>');
            }
            if (pendingCreate.kind === "alarm") {
                panel.append('<div class="form-row"><label>alarmType</label><select id="opcua-create-alarm-type"><option value="levelAlarm">levelAlarm</option><option value="digitalAlarm">digitalAlarm</option></select></div>');
                panel.append('<div class="form-row"><label>variablePath</label><input type="text" id="opcua-create-variable-nodeid"></div>');
                panel.append('<div class="form-row"><label>severity</label><input type="number" id="opcua-create-severity"></div>');
                panel.append('<div class="form-row"><label for="opcua-create-sendvalue">Send alarm value</label><input type="checkbox" id="opcua-create-sendvalue" style="width: auto; flex: 0 0 auto; min-width: 0;"></div>');
                if (pendingCreate.alarmType === "levelAlarm") {
                    panel.append('<div class="form-row"><label>highHighLimit</label><input type="number" id="opcua-create-highhighlimit"></div>');
                    panel.append('<div class="form-row"><label>highHighMessage</label><input type="text" id="opcua-create-highhighmessage"></div>');
                    panel.append('<div class="form-row"><label>highLimit</label><input type="number" id="opcua-create-highlimit"></div>');
                    panel.append('<div class="form-row"><label>highMessage</label><input type="text" id="opcua-create-highmessage"></div>');
                    panel.append('<div class="form-row"><label>lowLimit</label><input type="number" id="opcua-create-lowlimit"></div>');
                    panel.append('<div class="form-row"><label>lowMessage</label><input type="text" id="opcua-create-lowmessage"></div>');
                    panel.append('<div class="form-row"><label>lowLowLimit</label><input type="number" id="opcua-create-lowlowlimit"></div>');
                    panel.append('<div class="form-row"><label>lowLowMessage</label><input type="text" id="opcua-create-lowlowmessage"></div>');
                } else {
                    panel.append('<div class="form-row"><label>normalStateValue</label><input type="number" id="opcua-create-normalstatevalue"></div>');
                    panel.append('<div class="form-row"><label>digitalMessage</label><input type="text" id="opcua-create-digitalmessage"></div>');
                }
            }
            panel.append('<div class="form-row"><label style="width:90px;">Actions</label><div><a href="#" id="opcua-create-save" class="editor-button editor-button-small"><i class="fa fa-save"></i> Save</a> <a href="#" id="opcua-create-cancel" class="editor-button editor-button-small"><i class="fa fa-times"></i> Cancel</a></div></div>');
            $("#opcua-create-parent").val(pendingCreate.parentPath);
            $("#opcua-create-kind").val(pendingCreate.kind);
            $("#opcua-create-name").val(pendingCreate.name);
            $("#opcua-create-displayname").val(pendingCreate.displayName || "");
            $("#opcua-create-accesspermission").val(normalizeAccessPermissionValues(pendingCreate.accessPermission));
            if (pendingCreate.kind === "variable" || pendingCreate.kind === "enum-variable") {
                $("#opcua-create-nodeid-type").val(pendingCreate.nodeIdType || "s");
                $("#opcua-create-nodeid-value").val(pendingCreate.nodeIdValue || "");
                updateNodeIdValueInputState("create", pendingCreate.nodeIdType || "s");
            }
            $("#opcua-create-type").val(pendingCreate.dataType);
            $("#opcua-create-value").val(pendingCreate.value);
            $("#opcua-create-objectstype").val(pendingCreate.objectsType);
            $("#opcua-create-access").val(pendingCreate.access || "readwrite");
            $("#opcua-create-alarm-type").val(pendingCreate.alarmType);
            $("#opcua-create-variable-nodeid").val(pendingCreate.variableNodeId);
            $("#opcua-create-severity").val(pendingCreate.severity);
            $("#opcua-create-sendvalue").prop("checked", pendingCreate.sendValue !== false);
            $("#opcua-create-highhighlimit").val(pendingCreate.highHighLimit);
            $("#opcua-create-highhighmessage").val(pendingCreate.highHighMessage);
            $("#opcua-create-highlimit").val(pendingCreate.highLimit);
            $("#opcua-create-highmessage").val(pendingCreate.highMessage);
            $("#opcua-create-lowlimit").val(pendingCreate.lowLimit);
            $("#opcua-create-lowmessage").val(pendingCreate.lowMessage);
            $("#opcua-create-lowlowlimit").val(pendingCreate.lowLowLimit);
            $("#opcua-create-lowlowmessage").val(pendingCreate.lowLowMessage);
            $("#opcua-create-normalstatevalue").val(pendingCreate.normalStateValue);
            $("#opcua-create-digitalmessage").val(pendingCreate.digitalMessage);
            return;
        }
        if (!selectedPath) { panel.append('<div class="opcua-tree-empty">Select a node to edit browseName, namespace, nodeId, and description.</div>'); return; }
        if (selectedPath.indexOf("virtual:") === 0) {
            var visualName = getVirtualNodeName(selectedPath);
            panel.append('<div class="opcua-tree-empty">Visual folder: <strong>' + escapeHtml(visualName) + '</strong><br><span style="font-size: 11px; color: #666;">This folder is used strictly for visual organization within the modal.</span></div>');
            return;
        }
        var item = getAtPath(editorState, selectedPath);
        if (!item) { panel.append('<div class="opcua-tree-empty">Selected node not found.</div>'); return; }
        var nodeClass = nodeClassFromPath(selectedPath);
        var nodeId = buildDisplayNodeIdFromEditorPath(selectedPath);
        var nodeIdSuffix = nodeIdSuffixFromValue(item.nodeId, buildDefaultNodeIdSuffixFromEditorPath(selectedPath));
        var nodeIdLocked = isObjectTypeModelPath(selectedPath);
        var namespaceId = getNodeNamespaceId(selectedPath);
        var namespaceOptions = getNamespaceOptions();
        if (nodeClass === "Namespace") {
            panel.append('<div class="form-row"><label>namespaceId</label><input type="number" id="opcua-detail-namespace-entry-id" min="2"></div>');
            panel.append('<div class="form-row"><label>name</label><input type="text" id="opcua-detail-namespace-entry-name"></div>');
            panel.append('<div class="form-row"><label style="width:90px;">Actions</label><div>' + (normalizeNamespaceId(item.id) === DEFAULT_NAMESPACE_ID ? '' : '<a href="#" id="opcua-detail-remove" class="editor-button editor-button-small"><i class="fa fa-trash"></i> Remove</a>') + '</div></div>');
            $("#opcua-detail-namespace-entry-id").val(item.id !== undefined ? item.id : DEFAULT_NAMESPACE_ID);
            $("#opcua-detail-namespace-entry-name").val(item.name || "");
            if (normalizeNamespaceId(item.id) === DEFAULT_NAMESPACE_ID) $("#opcua-detail-namespace-entry-id").prop("disabled", true);
            return;
        }
        if (nodeClass === "Enumeration") {
            panel.append('<div class="form-row"><label>browseName</label><input type="text" id="opcua-detail-name"></div>');
            panel.append('<div class="form-row"><label>namespace</label><select id="opcua-detail-namespace"></select></div>');
            panel.append('<div class="form-row"><label>Description</label><input type="text" id="opcua-detail-description"></div>');
            panel.append('<div class="form-row"><label>displayName</label><input type="text" id="opcua-detail-displayname" placeholder="Leave blank to use browseName"></div>');
            panel.append('<hr style="margin:8px 0; border-color:#e3e3e3;">');
            panel.append('<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#666;margin-bottom:4px;">States</div>');
            var statesDiv = $('<div id="opcua-detail-states"></div>').appendTo(panel);
            (item.enumeration || []).forEach(function (state, idx) {
                var statePath = selectedPath + ".enumeration." + idx;
                var stateBlock = $('<div style="border:1px solid #e3e3e3;border-radius:4px;padding:6px;margin-bottom:4px;"></div>');
                stateBlock.append('<div class="form-row"><label>value</label><input type="number" class="opcua-enum-state-bind" data-state-path="' + statePath + '" data-field="value"></div>');
                stateBlock.append('<div class="form-row"><label>displayName</label><input type="text" class="opcua-enum-state-bind" data-state-path="' + statePath + '" data-field="displayName"></div>');
                stateBlock.append('<div class="form-row"><label></label><a href="#" class="editor-button editor-button-small opcua-enum-state-remove" data-state-path="' + statePath + '"><i class="fa fa-trash"></i> Remove</a></div>');
                stateBlock.find('[data-field="value"]').val(state.value !== undefined ? state.value : 0);
                stateBlock.find('[data-field="displayName"]').val(state.displayName || "");
                statesDiv.append(stateBlock);
            });
            panel.append('<div class="form-row"><label></label><a href="#" class="editor-button editor-button-small" id="opcua-enum-add-state"><i class="fa fa-plus"></i> Add state</a></div>');
            panel.append('<div class="form-row"><label style="width:90px;">Actions</label><div><a href="#" id="opcua-detail-edit" class="editor-button editor-button-small"><i class="fa fa-pencil"></i> Edit</a> <a href="#" id="opcua-detail-remove" class="editor-button editor-button-small"><i class="fa fa-trash"></i> Remove</a></div></div>');
            
            $("#opcua-detail-name").val(item.name || "");
            $("#opcua-detail-description").val(item.description || "");
            namespaceOptions.forEach(function (option) {
                $("#opcua-detail-namespace").append($("<option></option>").val(option.id).text(getNamespaceLabel(option.id)));
            });
            $("#opcua-detail-namespace").val(String(namespaceId));
            $("#opcua-detail-displayname").val(item.displayName || "");
            return;
        }

        panel.append('<div class="form-row"><label>browseName</label><input type="text" id="opcua-detail-name"></div>');
        panel.append('<div class="form-row"><label>nodeClass</label><input type="text" id="opcua-detail-class" readonly></div>');
        panel.append('<div class="form-row"><label>namespace</label><select id="opcua-detail-namespace"></select></div>');
        if (nodeClass === "Variable" && !nodeIdLocked) {
            panel.append('<div class="form-row"><label>nodeId</label>' +
                '<div class="opcua-nodeid-field">' +
                '<span class="opcua-nodeid-prefix">ns=' + namespaceId + ';</span>' +
                '<select id="opcua-detail-nodeid-type" style="width: 70px; flex: 0 0 auto;"><option value="s">s</option><option value="i">i</option></select>' +
                '<span style="padding: 0 4px; flex: 0 0 auto;">=</span>' +
                '<input type="text" id="opcua-detail-nodeid-value" style="flex: 1 1 auto; font-family: monospace;">' +
                '<a href="#" id="opcua-detail-copy-nodeid" class="editor-button editor-button-small"><i class="fa fa-copy"></i> Copy</a>' +
                '</div></div>');
        } else {
            panel.append('<div class="form-row"><label>nodeId</label><div class="opcua-nodeid-field"><span class="opcua-nodeid-prefix">' + getNodeIdPrefix(namespaceId) + '</span><input type="text" id="opcua-detail-nodeid"' + (nodeIdLocked ? ' readonly title="Generated automatically for object type models."' : '') + '><a href="#" id="opcua-detail-copy-nodeid" class="editor-button editor-button-small"><i class="fa fa-copy"></i> Copy</a></div></div>');
        }
        panel.append('<div class="form-row"><label>Description</label><input type="text" id="opcua-detail-description"></div>');
        panel.append('<div class="form-row"><label>displayName</label><input type="text" id="opcua-detail-displayname" placeholder="Leave blank to use browseName"></div>');
        panel.append('<div class="form-row"><label>accessPermission</label>' + buildAccessPermissionSelect("opcua-detail-accesspermission", item.accessPermission || ["public"]) + '</div>');
        if (nodeClass === "ObjectType") {
            panel.append('<div class="form-row"><label>objectsType</label>' + buildObjectTypeSelect("opcua-detail-objectstype", item.objectsType || "") + '</div>');
        }
        if (nodeClass === "Variable") {
            var enumNames = getDefinedEnumerationNames();
            if (enumNames.indexOf(item.type) !== -1) {
                panel.append('<div class="form-row"><label>dataType</label>' + buildEnumerationSelect("opcua-detail-type", item.type) + '</div>');
            } else {
                panel.append('<div class="form-row"><label>dataType</label><select id="opcua-detail-type"><option value="Int16">Int16</option><option value="Int32">Int32</option><option value="Int64">Int64</option><option value="Float">Float</option><option value="Boolean">Boolean</option><option value="String">String</option><option value="ByteString">ByteString</option></select></div>');
            }
            panel.append('<div class="form-row"><label>Value</label><input type="text" id="opcua-detail-value"></div>');
            panel.append('<div class="form-row"><label>Access</label><select id="opcua-detail-access"><option value="readwrite">readwrite</option><option value="readonly">readonly</option></select></div>');
        }
        if (nodeClass === "Method") {
            panel.append('<hr style="margin:8px 0; border-color:#e3e3e3;">');
            panel.append('<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#666;margin-bottom:4px;">Inputs</div>');
            var inputsDiv = $('<div id="opcua-detail-inputs"></div>').appendTo(panel);
            (item.inputs || []).forEach(function (arg, idx) {
                var argPath = selectedPath + ".inputs." + idx;
                var argBlock = $('<div style="border:1px solid #e3e3e3;border-radius:4px;padding:6px;margin-bottom:4px;"></div>');
                argBlock.append('<div class="form-row"><label>name</label><input type="text" class="opcua-method-arg-bind" data-arg-path="' + argPath + '" data-field="name"></div>');
                argBlock.append('<div class="form-row"><label>type</label><select class="opcua-method-arg-bind" data-arg-path="' + argPath + '" data-field="type"><option value="Int16">Int16</option><option value="Int32">Int32</option><option value="Int64">Int64</option><option value="Float">Float</option><option value="Boolean">Boolean</option><option value="String">String</option></select></div>');
                argBlock.append('<div class="form-row"><label>displayName</label><input type="text" class="opcua-method-arg-bind" data-arg-path="' + argPath + '" data-field="displayName"></div>');
                argBlock.append('<div class="form-row"><label>description</label><input type="text" class="opcua-method-arg-bind" data-arg-path="' + argPath + '" data-field="description"></div>');
                argBlock.append('<div class="form-row"><label></label><a href="#" class="editor-button editor-button-small opcua-method-arg-remove" data-arg-path="' + argPath + '"><i class="fa fa-trash"></i> Remove</a></div>');
                argBlock.find('[data-field="name"]').val(arg.name || "");
                argBlock.find('[data-field="type"]').val(arg.type || "Float");
                argBlock.find('[data-field="displayName"]').val(arg.displayName || "");
                argBlock.find('[data-field="description"]').val(arg.description || "");
                inputsDiv.append(argBlock);
            });
            panel.append('<div class="form-row"><label></label><a href="#" class="editor-button editor-button-small" id="opcua-method-add-input"><i class="fa fa-plus"></i> Add input</a></div>');
            panel.append('<hr style="margin:8px 0; border-color:#e3e3e3;">');
            panel.append('<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#666;margin-bottom:4px;">Outputs</div>');
            var outputsDiv = $('<div id="opcua-detail-outputs"></div>').appendTo(panel);
            (item.outputs || []).forEach(function (arg, idx) {
                var argPath = selectedPath + ".outputs." + idx;
                var argBlock = $('<div style="border:1px solid #e3e3e3;border-radius:4px;padding:6px;margin-bottom:4px;"></div>');
                argBlock.append('<div class="form-row"><label>name</label><input type="text" class="opcua-method-arg-bind" data-arg-path="' + argPath + '" data-field="name"></div>');
                argBlock.append('<div class="form-row"><label>type</label><select class="opcua-method-arg-bind" data-arg-path="' + argPath + '" data-field="type"><option value="Int16">Int16</option><option value="Int32">Int32</option><option value="Int64">Int64</option><option value="Float">Float</option><option value="Boolean">Boolean</option><option value="String">String</option></select></div>');
                argBlock.append('<div class="form-row"><label>displayName</label><input type="text" class="opcua-method-arg-bind" data-arg-path="' + argPath + '" data-field="displayName"></div>');
                argBlock.append('<div class="form-row"><label>description</label><input type="text" class="opcua-method-arg-bind" data-arg-path="' + argPath + '" data-field="description"></div>');
                argBlock.append('<div class="form-row"><label></label><a href="#" class="editor-button editor-button-small opcua-method-arg-remove" data-arg-path="' + argPath + '"><i class="fa fa-trash"></i> Remove</a></div>');
                argBlock.find('[data-field="name"]').val(arg.name || "");
                argBlock.find('[data-field="type"]').val(arg.type || "Float");
                argBlock.find('[data-field="displayName"]').val(arg.displayName || "");
                argBlock.find('[data-field="description"]').val(arg.description || "");
                outputsDiv.append(argBlock);
            });
            panel.append('<div class="form-row"><label></label><a href="#" class="editor-button editor-button-small" id="opcua-method-add-output"><i class="fa fa-plus"></i> Add output</a></div>');
        }
        if (nodeClass === "Alarm") {
            panel.append('<div class="form-row"><label>alarmType</label><select id="opcua-detail-alarm-type"><option value="levelAlarm">levelAlarm</option><option value="digitalAlarm">digitalAlarm</option></select></div>');
            panel.append('<div class="form-row"><label>variablePath</label><input type="text" id="opcua-detail-variable-nodeid"></div>');
            panel.append('<div class="form-row"><label>severity</label><input type="number" id="opcua-detail-severity"></div>');
            panel.append('<div class="form-row"><label for="opcua-detail-sendvalue">Send alarm value</label><input type="checkbox" id="opcua-detail-sendvalue" style="width: auto; flex: 0 0 auto; min-width: 0;"></div>');
            if ((item.type || "levelAlarm") === "levelAlarm") {
                panel.append('<div class="form-row"><label>highHighLimit</label><input type="number" id="opcua-detail-highhighlimit"></div>');
                panel.append('<div class="form-row"><label>highHighMessage</label><input type="text" id="opcua-detail-highhighmessage"></div>');
                panel.append('<div class="form-row"><label>highLimit</label><input type="number" id="opcua-detail-highlimit"></div>');
                panel.append('<div class="form-row"><label>highMessage</label><input type="text" id="opcua-detail-highmessage"></div>');
                panel.append('<div class="form-row"><label>lowLimit</label><input type="number" id="opcua-detail-lowlimit"></div>');
                panel.append('<div class="form-row"><label>lowMessage</label><input type="text" id="opcua-detail-lowmessage"></div>');
                panel.append('<div class="form-row"><label>lowLowLimit</label><input type="number" id="opcua-detail-lowlowlimit"></div>');
                panel.append('<div class="form-row"><label>lowLowMessage</label><input type="text" id="opcua-detail-lowlowmessage"></div>');
            } else {
                panel.append('<div class="form-row"><label>normalStateValue</label><input type="number" id="opcua-detail-normalstatevalue"></div>');
                panel.append('<div class="form-row"><label>digitalMessage</label><input type="text" id="opcua-detail-digitalmessage"></div>');
            }
        }
        panel.append('<div class="form-row"><label style="width:90px;">Actions</label><div><a href="#" id="opcua-detail-edit" class="editor-button editor-button-small"><i class="fa fa-pencil"></i> Edit</a> <a href="#" id="opcua-detail-remove" class="editor-button editor-button-small"><i class="fa fa-trash"></i> Remove</a></div></div>');
        $("#opcua-detail-name").val(item.name || "");
        $("#opcua-detail-class").val(nodeClass);
        if (nodeClass === "Variable" && !nodeIdLocked) {
            var parsed = parseNodeId(item.nodeId, buildDefaultNodeIdSuffixFromEditorPath(selectedPath));
            $("#opcua-detail-nodeid-type").val(parsed.type);
            $("#opcua-detail-nodeid-value").val(parsed.value);
            updateNodeIdValueInputState("detail", parsed.type);
        } else {
            $("#opcua-detail-nodeid").val(nodeIdLocked ? buildDefaultNodeIdSuffixFromEditorPath(selectedPath) : nodeIdSuffix);
        }
        $("#opcua-detail-description").val(item.description || "");
        namespaceOptions.forEach(function (option) {
            $("#opcua-detail-namespace").append($("<option></option>").val(option.id).text(getNamespaceLabel(option.id)));
        });
        $("#opcua-detail-namespace").val(String(namespaceId));
        $("#opcua-detail-displayname").val(item.displayName || "");
        $("#opcua-detail-accesspermission").val(normalizeAccessPermissionValues(item.accessPermission));
        if (nodeClass === "ObjectType") { $("#opcua-detail-objectstype").val(item.objectsType || ""); }
        if (nodeClass === "Variable") { $("#opcua-detail-type").val(item.type || "Int32"); $("#opcua-detail-value").val(item.value !== undefined ? item.value : ""); $("#opcua-detail-access").val(item.access || "readwrite"); }
        if (nodeClass === "Alarm") {
            $("#opcua-detail-alarm-type").val(item.type || "levelAlarm");
            $("#opcua-detail-variable-nodeid").val(item.variableNodeId || "");
            $("#opcua-detail-severity").val(item.severity !== undefined ? item.severity : 500);
            $("#opcua-detail-sendvalue").prop("checked", item.sendValue !== false);
            $("#opcua-detail-highhighlimit").val(item.highHighLimit !== undefined ? item.highHighLimit : 90);
            $("#opcua-detail-highhighmessage").val(item.highHighMessage || "High High alarm");
            $("#opcua-detail-highlimit").val(item.highLimit !== undefined ? item.highLimit : 80);
            $("#opcua-detail-highmessage").val(item.highMessage || "High alarm");
            $("#opcua-detail-lowlimit").val(item.lowLimit !== undefined ? item.lowLimit : 20);
            $("#opcua-detail-lowmessage").val(item.lowMessage || "Low alarm");
            $("#opcua-detail-lowlowlimit").val(item.lowLowLimit !== undefined ? item.lowLowLimit : 10);
            $("#opcua-detail-lowlowmessage").val(item.lowLowMessage || "Low Low alarm");
            $("#opcua-detail-normalstatevalue").val(item.normalStateValue !== undefined ? item.normalStateValue : 0);
            $("#opcua-detail-digitalmessage").val(item.digitalMessage || "Digital alarm");
        }
    }

    function addNode(path, explicitKind) {
        var kind = explicitKind || "object";
        openCreateForm(path, kind);
    }

    function removeNode(path) {
        if (!path) return;
        if (path.indexOf("virtual:") === 0) {
            RED.notify("Visual folders cannot be removed.", "warning");
            return;
        }
        if (nodeClassFromPath(path) === "Namespace") {
            var namespaceItem = getAtPath(editorState, path);
            if (normalizeNamespaceId(namespaceItem && namespaceItem.id) === DEFAULT_NAMESPACE_ID) {
                RED.notify("Namespace 2 is fixed and cannot be removed.", "warning");
                return;
            }
        }
        removeAtPath(editorState, path);
        if (selectedPath === path) selectedPath = "";
        syncStateToJson(true);
        renderVisualEditor();
    }

    function buildGroupOptions(selectedGroup) {
        var currentGroup = String(selectedGroup || "");
        var options = authGroups.map(function (groupName) {
            var selected = groupName === currentGroup ? " selected" : "";
            return '<option value="' + escapeHtml(groupName) + '"' + selected + '>' + escapeHtml(groupName) + "</option>";
        });
        if (currentGroup && authGroups.indexOf(currentGroup) === -1) {
            options.unshift('<option value="' + escapeHtml(currentGroup) + '" selected>' + escapeHtml(currentGroup) + "</option>");
        }
        if (!options.length) {
            options.push('<option value="">No groups available</option>');
        }
        return options.join("");
    }

    function ensureDefaultAuthGroup() {
        if (!authGroups.length) {
            authGroups.push("operator");
        }
    }

    function addAuthGroup() {
        var baseName = "group";
        var suffix = authGroups.length + 1;
        var candidate = baseName + suffix;
        while (authGroups.indexOf(candidate) !== -1) {
            suffix += 1;
            candidate = baseName + suffix;
        }
        authGroups.push(candidate);
        authUsers.forEach(function (user) {
            if (!user.group) {
                user.group = candidate;
            }
        });
        syncAuthCredentialFields();
        renderAuthEditor();
    }

    function addAuthUser() {
        ensureDefaultAuthGroup();
        authUsers.push({
            username: "",
            password: "",
            passwordHash: "",
            group: authGroups[0] || ""
        });
        syncAuthCredentialFields();
        renderAuthEditor();
    }

    function removeAuthGroup(index) {
        var groupName = authGroups[index];
        var inUse = authUsers.some(function (user) {
            if (!user.group) return false;
            var groups = String(user.group).split(",").map(function (g) { return g.trim(); });
            return groups.indexOf(groupName) !== -1;
        });
        if (inUse) {
            RED.notify("Reassign users before removing this group.", "warning");
            return;
        }
        authGroups.splice(index, 1);
        syncAuthCredentialFields();
        renderAuthEditor();
    }

    function removeAuthUser(index) {
        authUsers.splice(index, 1);
        syncAuthCredentialFields();
        renderAuthEditor();
    }

    function renderAuthGroups() {
        var container = $("#opcua-auth-groups");
        container.empty();
        if (!authGroups.length) {
            container.append('<div class="opcua-tree-empty">No groups configured.</div>');
            return;
        }

        authGroups.forEach(function (groupName, index) {
            var card = $('<div class="opcua-auth-card"></div>');
            card.append('<div class="form-row"><label>Name</label><input type="text" class="opcua-auth-group-name" data-index="' + index + '" data-previous="' + escapeHtml(groupName) + '"></div>');
            card.append('<div class="form-row"><label></label><a href="#" class="editor-button editor-button-small opcua-auth-group-remove" data-index="' + index + '"><i class="fa fa-trash"></i> Remove</a></div>');
            card.find(".opcua-auth-group-name").val(groupName);
            container.append(card);
        });
    }

    function renderAuthUsers() {
        var container = $("#opcua-auth-users");
        container.empty();
        if (!authUsers.length) {
            container.append('<div class="opcua-tree-empty">No users configured.</div>');
            return;
        }

        var groupOptions = authGroups.map(function (groupName) {
            return { value: groupName, label: groupName };
        });

        authUsers.forEach(function (user, index) {
            var card = $('<div class="opcua-auth-card"></div>');
            card.append('<div class="form-row"><label>Username</label><input type="text" class="opcua-auth-user-username" data-index="' + index + '"></div>');
            card.append('<div class="form-row"><label>Password</label><input type="password" class="opcua-auth-user-password" data-index="' + index + '" autocomplete="new-password"></div>');
            card.append('<div class="form-row"><label>Group</label><input type="text" class="opcua-auth-user-group" id="opcua-auth-user-group-' + index + '" data-index="' + index + '"></div>');
            card.append('<div class="form-row"><label></label><a href="#" class="editor-button editor-button-small opcua-auth-user-remove" data-index="' + index + '"><i class="fa fa-trash"></i> Remove</a></div>');
            card.find(".opcua-auth-user-username").val(user.username || "");
            card.find(".opcua-auth-user-password").val(user.password || "");
            container.append(card);

            $("#opcua-auth-user-group-" + index).typedInput({
                types: [
                    {
                        value: "groups",
                        multiple: "true",
                        options: groupOptions
                    }
                ]
            });
            $("#opcua-auth-user-group-" + index).typedInput("value", user.group || "");
            $("#opcua-auth-user-group-" + index).on("change", function () {
                var idx = Number($(this).attr("data-index"));
                authUsers[idx].group = $(this).typedInput("value");
                syncAuthCredentialFields();
            });
        });
    }

    function renderAuthEditor() {
        renderAuthGroups();
        renderAuthUsers();

    }

    function validateAuthState() {
        var seenUsers = {};
        var seenGroups = {};

        for (var i = 0; i < authGroups.length; i += 1) {
            var groupName = String(authGroups[i] || "").trim();
            if (!groupName) {
                RED.notify("Group names cannot be empty.", "warning");
                return false;
            }
            if (seenGroups[groupName]) {
                RED.notify("Group names must be unique.", "warning");
                return false;
            }
            seenGroups[groupName] = true;
        }

        for (var j = 0; j < authUsers.length; j += 1) {
            var user = authUsers[j] || {};
            var username = String(user.username || "").trim();
            if (!username) {
                RED.notify("Usernames cannot be empty.", "warning");
                return false;
            }
            if (seenUsers[username]) {
                RED.notify("Usernames must be unique.", "warning");
                return false;
            }
            if (!user.password && !user.passwordHash) {
                RED.notify("Each user requires a password.", "warning");
                return false;
            }
            if (!user.group) {
                RED.notify("Each user requires a group.", "warning");
                return false;
            }
            seenUsers[username] = true;
        }

        return true;
    }

    function renderVisualEditor() {
        renderTree();
        renderDetails();
        renderBreadcrumbs();

    }

    function getNextNamespaceId() {
        var ids = getNamespaceOptions().map(function (item) { return normalizeNamespaceId(item.id); });
        var nextId = DEFAULT_NAMESPACE_ID;
        while (ids.indexOf(nextId) !== -1) nextId += 1;
        return nextId;
    }

    function addItem(parentPath, kind) {
        var target = getAtPath(editorState, parentPath);
        if (!Array.isArray(target)) return;
        if (kind === "object" || kind === "folder" || kind === "objectTypeDefinition" || kind === "enumeration") {
            if (kind === "enumeration") {
                target.push(normalizeEnumeration({ name: "newEnumeration", enumeration: [{ value: 0, displayName: "State0" }] }));
            } else {
                target.push(normalizeBranch());
            }
            if (kind === "objectTypeDefinition") {
                target[target.length - 1].nodeId = buildGeneratedNodeIdForPath(parentPath + "." + (target.length - 1));
            }
        }
        if (kind === "namespace") {
            var namespaceId = getNextNamespaceId();
            target.push(normalizeNamespaceDefinition({
                id: namespaceId,
                name: "urn:namespace:" + namespaceId
            }));
        }
    }

    $(document).on("change", "#node-input-tree", function () {
        var jsonText = $(this).val();
        if (!jsonText) {
            editorState = normalizeTree({ objects: [], folders: [], objectsTypes: [], nameSpaces: [] });
            updateTreeField(prettyTree(editorState), true);
            renderVisualEditor();
            return;
        }
        try {
            editorState = cloneTree(normalizeTree(parseTree(jsonText, true)));
            renderVisualEditor();
        } catch (error) { RED.notify("Invalid JSON: " + error.message, "error"); }
    });

    $(document).on("click", ".opcua-tree-row", function (event) {
        var path = $(this).attr("data-path");
        if ($(event.target).closest(".opcua-tree-twisty").length) {
            expansionState[path] = !isExpanded(path, false);
            renderTree();
            return;
        }
        selectNode(path);
    });

    $(document).on("contextmenu", ".opcua-tree-row", function (event) {
        event.preventDefault();
        var path = $(this).attr("data-path");
        selectNode(path);
        
        var contextMenu = $("#opcua-tree-context-menu");
        contextMenu.find("a").hide();
        
        if (path.indexOf("virtual:") === 0) {
            if (path === "virtual:Objects") {
                contextMenu.find('[data-action="add-folder"]').show();
                contextMenu.find('[data-action="add-object"]').show();
            } else if (path === "virtual:Types.ObjectTypes") {
                contextMenu.find('[data-action="add-objecttype"]').show();
            } else if (path === "virtual:Types.DataTypes") {
                contextMenu.find('[data-action="add-enumeration"]').show();
            }
        } else {
            var nodeClass = nodeClassFromPath(path);
            if (nodeClass === "Folder" || nodeClass === "Object" || nodeClass === "ObjectType") {
                contextMenu.find('[data-action="add-folder"]').show();
                contextMenu.find('[data-action="add-object"]').show();
                contextMenu.find('[data-action="add-variable"]').show();
                contextMenu.find('[data-action="add-enum-variable"]').show();
                contextMenu.find('[data-action="add-alarm"]').show();
                contextMenu.find('[data-action="add-method"]').show();
                contextMenu.find('[data-action="edit"]').show();
                contextMenu.find('[data-action="remove"]').show();
            } else if (nodeClass === "Enumeration") {
                contextMenu.find('[data-action="edit"]').show();
                contextMenu.find('[data-action="remove"]').show();
            } else if (nodeClass === "Namespace") {
                contextMenu.find('[data-action="edit"]').show();
                var item = getAtPath(editorState, path);
                if (item && normalizeNamespaceId(item.id) !== DEFAULT_NAMESPACE_ID) {
                    contextMenu.find('[data-action="remove"]').show();
                }
            } else {
                contextMenu.find('[data-action="edit"]').show();
                contextMenu.find('[data-action="remove"]').show();
            }
        }
        
        contextMenu.css({ left: event.clientX + "px", top: event.clientY + "px" }).show();
    });

    $(document).on("click", function () { $("#opcua-tree-context-menu").hide(); });
    $(document).on("click", "#opcua-tree-context-menu a", function (event) {
        event.preventDefault();
        var action = $(this).attr("data-action");
        if (action === "add-folder") addNode(selectedPath, "folder");
        if (action === "add-object") addNode(selectedPath, "object");
        if (action === "add-variable") addNode(selectedPath, "variable");
        if (action === "add-objecttype") addNode(selectedPath, "objecttype");
        if (action === "add-enumeration") { addItem("enumerations", "enumeration"); syncStateToJson(true); renderVisualEditor(); }
        if (action === "add-enum-variable") addNode(selectedPath, "enum-variable");
        if (action === "add-alarm") addNode(selectedPath, "alarm");
        if (action === "add-method") addNode(selectedPath, "method");
        if (action === "add-method") addNode(selectedPath, "method");
        if (action === "remove") removeNode(selectedPath);
        if (action === "edit") renderDetails();
        $("#opcua-tree-context-menu").hide();
    });

    $(document).on("input change", ".opcua-method-arg-bind", function () {
        var el = $(this);
        var argPath = el.attr("data-arg-path");
        var field = el.attr("data-field");
        var arg = getAtPath(editorState, argPath);
        if (!arg) return;
        arg[field] = el.val();
        syncStateToJson(false);
    });

    $(document).on("click", ".opcua-method-arg-remove", function (e) {
        e.preventDefault();
        var argPath = $(this).attr("data-arg-path");
        removeAtPath(editorState, argPath);
        syncStateToJson(false);
        renderDetails();
    });

    $(document).on("click", "#opcua-method-add-input", function (e) {
        e.preventDefault();
        var item = getAtPath(editorState, selectedPath);
        if (!item) return;
        if (!Array.isArray(item.inputs)) item.inputs = [];
        item.inputs.push(normalizeMethodArg());
        syncStateToJson(false);
        renderDetails();
    });

    $(document).on("click", "#opcua-method-add-output", function (e) {
        e.preventDefault();
        var item = getAtPath(editorState, selectedPath);
        if (!item) return;
        if (!Array.isArray(item.outputs)) item.outputs = [];
        item.outputs.push(normalizeMethodArg());
        syncStateToJson(false);
        renderDetails();
    });

    $(document).on("input change", ".opcua-enum-state-bind", function () {
        var el = $(this);
        var statePath = el.attr("data-state-path");
        var field = el.attr("data-field");
        var state = getAtPath(editorState, statePath);
        if (!state) return;
        state[field] = field === "value" ? Number(el.val()) : el.val();
        syncStateToJson(false);
    });

    $(document).on("click", ".opcua-enum-state-remove", function (e) {
        e.preventDefault();
        var statePath = $(this).attr("data-state-path");
        removeAtPath(editorState, statePath);
        syncStateToJson(false);
        renderDetails();
    });

    $(document).on("click", "#opcua-enum-add-state", function (e) {
        e.preventDefault();
        var item = getAtPath(editorState, selectedPath);
        if (!item) return;
        if (!Array.isArray(item.enumeration)) item.enumeration = [];
        var maxValue = -1;
        item.enumeration.forEach(function (s) { if (s.value > maxValue) maxValue = s.value; });
        item.enumeration.push(normalizeEnumerationState({ value: maxValue + 1, displayName: "State" + (maxValue + 1) }));
        syncStateToJson(false);
        renderDetails();
    });

    $(document).on("input", "#opcua-detail-displayname", function () { updateNode(selectedPath, { displayName: $(this).val() }); });

    $(document).on("input", "#opcua-detail-name", function () { updateNode(selectedPath, { name: $(this).val() }); });
    $(document).on("change", "#opcua-detail-namespace", function () {
        var nextNamespaceId = normalizeNamespaceId($(this).val());
        var item = getAtPath(editorState, selectedPath);
        if (!item) return;
        item.namespaceId = nextNamespaceId;
        if (nodeClassFromPath(selectedPath) === "Variable" && !isObjectTypeModelPath(selectedPath)) {
            saveDetailNodeId(selectedPath);
        } else {
            item.nodeId = normalizeCustomNodeIdFromSuffix(selectedPath, $("#opcua-detail-nodeid").val());
        }
        syncStateToJson(false);
        renderTree();
        renderBreadcrumbs();
        renderDetails();
    });
    $(document).on("input", "#opcua-detail-nodeid", function () { updateNode(selectedPath, { nodeId: normalizeCustomNodeIdFromSuffix(selectedPath, $(this).val()) }); });
    $(document).on("change", "#opcua-detail-nodeid-type", function () {
        var type = $(this).val();
        updateNodeIdValueInputState("detail", type);
        saveDetailNodeId(selectedPath);
    });
    $(document).on("input", "#opcua-detail-nodeid-value", function () {
        saveDetailNodeId(selectedPath);
    });
    $(document).on("click", "#opcua-detail-copy-nodeid", function (event) {
        event.preventDefault();
        copyNodeIdValue(buildDisplayNodeIdFromEditorPath(selectedPath));
    });
    $(document).on("input", "#opcua-detail-namespace-entry-id", function () {
        var nextId = normalizeNamespaceId($(this).val());
        var currentPath = selectedPath;
        var duplicate = (editorState.nameSpaces || []).some(function (namespaceItem, index) {
            return currentPath !== ("nameSpaces." + index) && normalizeNamespaceId(namespaceItem.id) === nextId;
        });
        if (duplicate) {
            RED.notify("Namespace id must be unique.", "warning");
            return;
        }
        updateNode(selectedPath, { id: nextId });
    });
    $(document).on("input", "#opcua-detail-namespace-entry-name", function () {
        var nextName = $(this).val();
        updateNode(selectedPath, { name: nextName });
        var namespaceItem = getAtPath(editorState, selectedPath);
        if (normalizeNamespaceId(namespaceItem && namespaceItem.id) === DEFAULT_NAMESPACE_ID) {
            $("#node-input-namespaceUri").val(nextName);
        }
    });
    $(document).on("input", "#opcua-detail-description", function () { updateNode(selectedPath, { description: $(this).val() }); });
    $(document).on("change", "#opcua-detail-accesspermission", function () {
        updateNode(selectedPath, { accessPermission: normalizeAccessPermissionValues($(this).val()) });
    });
    $(document).on("change", "#opcua-detail-objectstype", function () { updateNode(selectedPath, { objectsType: $(this).val() }); });
    $(document).on("change", "#opcua-detail-type", function () { updateNode(selectedPath, { type: $(this).val() }); });
    $(document).on("change", "#opcua-detail-access", function () { updateNode(selectedPath, { access: $(this).val() }); });
    $(document).on("input", "#opcua-detail-value", function () { updateNode(selectedPath, { value: $(this).val() }); });
    $(document).on("change", "#opcua-detail-alarm-type", function () {
        updateNode(selectedPath, { type: $(this).val() });
        renderDetails();
    });
    $(document).on("input", "#opcua-detail-variable-nodeid", function () { updateNode(selectedPath, { variableNodeId: $(this).val() }); });
    $(document).on("input", "#opcua-detail-severity", function () { updateNode(selectedPath, { severity: Number($(this).val() || 0) }); });
    $(document).on("change", "#opcua-detail-sendvalue", function () { updateNode(selectedPath, { sendValue: $(this).is(":checked") }); });
    $(document).on("input", "#opcua-detail-highhighlimit", function () { updateNode(selectedPath, { highHighLimit: Number($(this).val() || 0) }); });
    $(document).on("input", "#opcua-detail-highhighmessage", function () { updateNode(selectedPath, { highHighMessage: $(this).val() }); });
    $(document).on("input", "#opcua-detail-highlimit", function () { updateNode(selectedPath, { highLimit: Number($(this).val() || 0) }); });
    $(document).on("input", "#opcua-detail-highmessage", function () { updateNode(selectedPath, { highMessage: $(this).val() }); });
    $(document).on("input", "#opcua-detail-lowlimit", function () { updateNode(selectedPath, { lowLimit: Number($(this).val() || 0) }); });
    $(document).on("input", "#opcua-detail-lowmessage", function () { updateNode(selectedPath, { lowMessage: $(this).val() }); });
    $(document).on("input", "#opcua-detail-lowlowlimit", function () { updateNode(selectedPath, { lowLowLimit: Number($(this).val() || 0) }); });
    $(document).on("input", "#opcua-detail-lowlowmessage", function () { updateNode(selectedPath, { lowLowMessage: $(this).val() }); });
    $(document).on("input", "#opcua-detail-normalstatevalue", function () { updateNode(selectedPath, { normalStateValue: Number($(this).val() || 0) }); });
    $(document).on("input", "#opcua-detail-digitalmessage", function () { updateNode(selectedPath, { digitalMessage: $(this).val() }); });
    $(document).on("input", "#opcua-create-name", function () {
        if (pendingCreate) {
            var oldName = pendingCreate.name;
            var nextName = $(this).val();
            pendingCreate.name = nextName;

            if (pendingCreate.kind === "variable" || pendingCreate.kind === "enum-variable") {
                if (pendingCreate.nodeIdType === "s") {
                    var parentSuffix = buildDefaultNodeIdSuffixFromEditorPath(pendingCreate.parentPath);
                    var oldAutoSuffix = parentSuffix ? parentSuffix + "." + oldName : oldName;
                    var nextAutoSuffix = parentSuffix ? parentSuffix + "." + nextName : nextName;

                    if (!pendingCreate.nodeIdValue || pendingCreate.nodeIdValue === oldAutoSuffix) {
                        pendingCreate.nodeIdValue = nextAutoSuffix;
                        $("#opcua-create-nodeid-value").val(nextAutoSuffix);
                    }
                }
            }
        }
    });
    $(document).on("input", "#opcua-create-displayname", function () { if (pendingCreate) pendingCreate.displayName = $(this).val(); });
    $(document).on("change", "#opcua-create-nodeid-type", function () {
        var type = $(this).val();
        if (pendingCreate) pendingCreate.nodeIdType = type;
        updateNodeIdValueInputState("create", type);
    });
    $(document).on("input", "#opcua-create-nodeid-value", function () {
        if (pendingCreate) pendingCreate.nodeIdValue = $(this).val();
    });
    $(document).on("change", "#opcua-create-accesspermission", function () { if (pendingCreate) pendingCreate.accessPermission = normalizeAccessPermissionValues($(this).val()); });
    $(document).on("change", "#opcua-create-type", function () { if (pendingCreate) pendingCreate.dataType = $(this).val(); });
    $(document).on("input", "#opcua-create-value", function () { if (pendingCreate) pendingCreate.value = $(this).val(); });
    $(document).on("change", "#opcua-create-objectstype", function () { if (pendingCreate) pendingCreate.objectsType = $(this).val(); });
    $(document).on("change", "#opcua-create-access", function () { if (pendingCreate) pendingCreate.access = $(this).val(); });
    $(document).on("change", "#opcua-create-alarm-type", function () {
        if (pendingCreate) {
            pendingCreate.alarmType = $(this).val();
            renderDetails();
        }
    });
    $(document).on("input", "#opcua-create-variable-nodeid", function () { if (pendingCreate) pendingCreate.variableNodeId = $(this).val(); });
    $(document).on("input", "#opcua-create-severity", function () { if (pendingCreate) pendingCreate.severity = Number($(this).val() || 0); });
    $(document).on("change", "#opcua-create-sendvalue", function () { if (pendingCreate) pendingCreate.sendValue = $(this).is(":checked"); });
    $(document).on("input", "#opcua-create-highhighlimit", function () { if (pendingCreate) pendingCreate.highHighLimit = Number($(this).val() || 0); });
    $(document).on("input", "#opcua-create-highhighmessage", function () { if (pendingCreate) pendingCreate.highHighMessage = $(this).val(); });
    $(document).on("input", "#opcua-create-highlimit", function () { if (pendingCreate) pendingCreate.highLimit = Number($(this).val() || 0); });
    $(document).on("input", "#opcua-create-highmessage", function () { if (pendingCreate) pendingCreate.highMessage = $(this).val(); });
    $(document).on("input", "#opcua-create-lowlimit", function () { if (pendingCreate) pendingCreate.lowLimit = Number($(this).val() || 0); });
    $(document).on("input", "#opcua-create-lowmessage", function () { if (pendingCreate) pendingCreate.lowMessage = $(this).val(); });
    $(document).on("input", "#opcua-create-lowlowlimit", function () { if (pendingCreate) pendingCreate.lowLowLimit = Number($(this).val() || 0); });
    $(document).on("input", "#opcua-create-lowlowmessage", function () { if (pendingCreate) pendingCreate.lowLowMessage = $(this).val(); });
    $(document).on("input", "#opcua-create-normalstatevalue", function () { if (pendingCreate) pendingCreate.normalStateValue = Number($(this).val() || 0); });
    $(document).on("input", "#opcua-create-digitalmessage", function () { if (pendingCreate) pendingCreate.digitalMessage = $(this).val(); });
    $(document).on("click", "#opcua-create-save", function (e) { e.preventDefault(); saveCreateForm(); });
    $(document).on("click", "#opcua-create-cancel", function (e) { e.preventDefault(); cancelCreateForm(); });
    $(document).on("click", "#opcua-detail-edit", function (e) { e.preventDefault(); renderDetails(); });
    $(document).on("click", "#opcua-detail-remove", function (e) { e.preventDefault(); removeNode(selectedPath); });
    $(document).on("input", ".opcua-auth-group-name", function () {
        var input = $(this);
        var index = Number(input.attr("data-index"));
        var previousGroup = String(input.attr("data-previous") || "");
        var nextGroup = String(input.val() || "").trim();
        authGroups[index] = nextGroup;
        authUsers.forEach(function (user) {
            if (user.group) {
                var groups = String(user.group).split(",").map(function (g) { return g.trim(); });
                var updated = groups.map(function (g) {
                    return g === previousGroup ? nextGroup : g;
                });
                user.group = updated.join(",");
            }
        });
        input.attr("data-previous", nextGroup);
        syncAuthCredentialFields();

        renderAuthUsers();
    });
    $(document).on("click", ".opcua-auth-group-remove", function (event) {
        event.preventDefault();
        removeAuthGroup(Number($(this).attr("data-index")));
    });
    $(document).on("input", ".opcua-auth-user-username", function () {
        var index = Number($(this).attr("data-index"));
        authUsers[index].username = $(this).val();
        syncAuthCredentialFields();

    });
    $(document).on("input", ".opcua-auth-user-password", function () {
        var index = Number($(this).attr("data-index"));
        authUsers[index].password = $(this).val();
        authUsers[index].passwordHash = "";
        syncAuthCredentialFields();
    });
    // The change handler is now dynamically bound inside renderAuthUsers, so we do not need a global listener for it here.
    $(document).on("click", ".opcua-auth-user-remove", function (event) {
        event.preventDefault();
        removeAuthUser(Number($(this).attr("data-index")));
    });

    RED.nodes.registerType("opc-ua-server", {
        category: "network",
        color: "#d9edf7",
        credentials: { username: { type: "text" }, password: { type: "password" }, users: { type: "text" }, groups: { type: "text" } },
        defaults: {
            name: { value: "" }, resourcePath: { value: "/" }, serverName: { value: "Node-RED OPC UA Server", required: true }, allowAnonymous: { value: true }, automaticallyAcceptUnknownCertificate: { value: true },
            port: { value: 4840, required: true, validate: function (value) { var port = Number(value); return Number.isInteger(port) && port > 0 && port < 65536; } },
            maxConnections: { value: 10, required: true, validate: function (value) { var n = Number(value); return Number.isInteger(n) && n > 0; } },
            minSessionTimeout: { value: 100, required: true, validate: function (value) { var n = Number(value); return Number.isInteger(n) && n >= 0; } },
            defaultSessionTimeout: { value: 30000, required: true, validate: function (value) { var n = Number(value); return Number.isInteger(n) && n >= 0; } },
            maxSessionTimeout: { value: 3000000, required: true, validate: function (value) { var n = Number(value); return Number.isInteger(n) && n >= 0; } },
            securityPolicy: { value: "None", required: true }, securityMode: { value: "None", required: true }, namespaceUri: { value: "urn:node-red:opc-ua-server", required: true },
            tree: {
                value: "{\n  \"folders\": [],\n  \"objects\": [],\n  \"objectsTypes\": [],\n  \"nameSpaces\": [\n    {\n      \"id\": 2,\n      \"name\": \"urn:node-red:opc-ua-server\"\n    }\n  ]\n}",
                validate: function (value) {
                    try { var parsed = parseTree(value, true); return Array.isArray(parsed.objects || []) && Array.isArray(parsed.folders || []) && Array.isArray(parsed.objectsTypes || parsed.objectTypes || []) && Array.isArray(parsed.nameSpaces || parsed.namespaces || []); }
                    catch (error) { return false; }
                }
            }
        },
        inputs: 1,
        outputs: 1,
        icon: "opcua.svg",
        label: function () { return this.name || this.serverName || "opc-ua-server"; },
        oneditprepare: function () {
            var node = this;
            if (!$("#node-input-minSessionTimeout").val()) {
                $("#node-input-minSessionTimeout").val(100);
            }
            if (!$("#node-input-defaultSessionTimeout").val()) {
                $("#node-input-defaultSessionTimeout").val(30000);
            }
            if (!$("#node-input-maxSessionTimeout").val()) {
                $("#node-input-maxSessionTimeout").val(3000000);
            }
            editorState = cloneTree(normalizeTree(parseTree(node.tree)));
            authGroups = normalizeAuthGroups($("#node-input-groups").val());
            authUsers = normalizeAuthUsers($("#node-input-users").val());
            var defaultNamespaceEntry = (editorState.nameSpaces || []).find(function (item) { return normalizeNamespaceId(item.id) === DEFAULT_NAMESPACE_ID; });
            if (defaultNamespaceEntry && defaultNamespaceEntry.name) {
                $("#node-input-namespaceUri").val(defaultNamespaceEntry.name);
            }
            syncAuthCredentialFields();
            $("#node-input-securityPolicy").typedInput({
                types: [
                    {
                        value: "securityPolicy",
                        multiple: "true",
                        options: [
                            { value: "None", label: "None" },
                            { value: "Basic128Rsa15", label: "Basic128Rsa15" },
                            { value: "Basic256", label: "Basic256" },
                            { value: "Basic256Sha256", label: "Basic256Sha256" },
                            { value: "Aes128_Sha256_RsaOaep", label: "Aes128_Sha256_RsaOaep" },
                            { value: "Aes256_Sha256_RsaPss", label: "Aes256_Sha256_RsaPss" }
                        ]
                    }
                ]
            });
            $("#node-input-securityMode").typedInput({
                types: [
                    {
                        value: "securityMode",
                        multiple: "true",
                        options: [
                            { value: "None", label: "None" },
                            { value: "Sign", label: "Sign" },
                            { value: "SignAndEncrypt", label: "SignAndEncrypt" }
                        ]
                    }
                ]
            });
            updateTreeField(prettyTree(editorState), false);
            $("#node-input-tree-editor").typedInput({ type: "json", types: ["json"] });
            $("#node-input-tree-editor").typedInput("value", prettyTree(editorState));
            $("#node-input-tree-editor").on("change", function () {
                if (isSyncing) return;
                var val = $(this).typedInput("value");
                $("#node-input-tree").val(val).trigger("change");
            });

            treeSearchValue = ""; treeSearchTerm = ""; selectedPath = "";
            $("#node-input-tree-search").val(""); $("#node-input-tree-search-clear").hide();
            renderVisualEditor();
            renderAuthEditor();

            $("#node-input-open-tree-modal").off("click").on("click", function (event) { event.preventDefault(); openTreeModal(); });
            $("#node-input-close-tree-modal").off("click").on("click", function (event) { event.preventDefault(); closeTreeModal(); });
            $("#node-input-tree-modal").off("click").on("click", function (event) { if (event.target === this) closeTreeModal(); });
            $("#node-input-open-auth-modal").off("click").on("click", function (event) { event.preventDefault(); openAuthModal(); });
            $("#node-input-close-auth-modal").off("click").on("click", function (event) { event.preventDefault(); closeAuthModal(); });
            $("#node-input-auth-modal").off("click").on("click", function (event) { if (event.target === this) closeAuthModal(); });
            $("#node-input-add-auth-group").off("click").on("click", function (event) { event.preventDefault(); addAuthGroup(); });
            $("#node-input-add-auth-user").off("click").on("click", function (event) { event.preventDefault(); addAuthUser(); });

            $("#node-input-open-cert-modal").off("click").on("click", function (event) { event.preventDefault(); openCertModal(); });
            $("#node-input-close-cert-modal").off("click").on("click", function (event) { event.preventDefault(); closeCertModal(); });
            $("#node-input-cert-modal").off("click").on("click", function (event) { if (event.target === this) closeCertModal(); });

            $("#node-input-open-settings-modal").off("click").on("click", function (event) { event.preventDefault(); openSettingsModal(); });
            $("#node-input-close-settings-modal").off("click").on("click", function (event) { event.preventDefault(); closeSettingsModal(); });
            $("#node-input-settings-modal").off("click").on("click", function (event) { if (event.target === this) closeSettingsModal(); });

            $("#opcua-cert-folders").off("click", ".opcua-cert-item").on("click", ".opcua-cert-item", function () {
                $("#opcua-cert-folders .opcua-cert-item").removeClass("is-selected");
                $(this).addClass("is-selected");
                selectedCertFolder = $(this).attr("data-folder");
                selectedCertName = "";
                $("#opcua-cert-details").hide();
                renderCertificatesList();
            });

            $("#opcua-cert-files").off("click", ".opcua-cert-item").on("click", ".opcua-cert-item", function () {
                $("#opcua-cert-files .opcua-cert-item").removeClass("is-selected");
                $(this).addClass("is-selected");
                selectedCertName = $(this).attr("data-name");
                showCertificateDetails();
            });

            $("#opcua-cert-move-btn").off("click").on("click", function (event) {
                event.preventDefault();
                moveCertificate();
            });

            $("#node-input-tree-search").off("input").on("input", debounce(function () {
                treeSearchValue = $(this).val(); treeSearchTerm = normalizeSearchTerm(treeSearchValue);
                $("#node-input-tree-search-clear").toggle(!!treeSearchTerm); renderTree();
            }, 200));
            $("#node-input-tree-search-clear").off("click").on("click", function (event) {
                event.preventDefault(); treeSearchValue = ""; treeSearchTerm = "";
                $("#node-input-tree-search").val(""); $(this).hide(); renderTree();
            });
            $("#node-input-namespaceUri").off("input.opcuaNamespaceDefault").on("input.opcuaNamespaceDefault", function () {
                var namespaceEntry = (editorState.nameSpaces || []).find(function (item) { return normalizeNamespaceId(item.id) === DEFAULT_NAMESPACE_ID; });
                if (!namespaceEntry) return;
                namespaceEntry.name = $(this).val() || "urn:node-red:opc-ua-server";
                syncStateToJson(false);
                if (selectedPath && nodeClassFromPath(selectedPath) === "Namespace") renderDetails();
                renderTree();
            });
            $(document).off("keydown.opcuaTreeModal").on("keydown.opcuaTreeModal", function (event) {
                if (event.key !== "Escape") return;
                if ($("#node-input-auth-modal").is(":visible")) {
                    closeAuthModal();
                    return;
                }
                if ($("#node-input-cert-modal").is(":visible")) {
                    closeCertModal();
                    return;
                }
                closeTreeModal();
            });

            $("#node-input-add-object").off("click").on("click", function (event) { event.preventDefault(); addItem("objects", "object"); syncStateToJson(true); renderVisualEditor(); });
            $("#node-input-add-folder").off("click").on("click", function (event) { event.preventDefault(); addItem("folders", "folder"); syncStateToJson(true); renderVisualEditor(); });
            $("#node-input-add-object-type").off("click").on("click", function (event) { event.preventDefault(); addItem("objectsTypes", "objectTypeDefinition"); syncStateToJson(true); renderVisualEditor(); });
            $("#node-input-add-enumeration").off("click").on("click", function (event) { event.preventDefault(); addItem("enumerations", "enumeration"); syncStateToJson(true); renderVisualEditor(); });
            $("#node-input-add-namespace").off("click").on("click", function (event) { event.preventDefault(); addItem("nameSpaces", "namespace"); syncStateToJson(true); renderVisualEditor(); });
            $("#node-input-expand-all").off("click").on("click", function (event) {
                event.preventDefault();
                function walk(path) { expansionState[path] = true; getChildrenByPath(path).forEach(walk); }
                getTopLevelPaths().forEach(walk); renderTree();
            });
            $("#node-input-collapse-all").off("click").on("click", function (event) { event.preventDefault(); expansionState = {}; renderTree(); });
            syncStateToJson(false);
        },
        oneditsave: function () {
            var editorValue = $("#node-input-tree-editor").typedInput("value");
            $("#node-input-tree").val(editorValue);
            var jsonText = $("#node-input-tree").val().trim();
            try { editorState = cloneTree(normalizeTree(parseTree(jsonText, true))); }
            catch (error) { RED.notify("Invalid OPC UA tree JSON: " + error.message, "error"); return; }
            if (pendingPasswordHashes > 0) { RED.notify("Wait for password hashing to finish before saving.", "warning"); return; }
            if (!validateAuthState()) { return; }
            syncAuthCredentialFields();
            updateTreeField(prettyTree(editorState), true);
            closeAuthModal();
            closeTreeModal();
            $(document).off("keydown.opcuaTreeModal");
        },
        oneditcancel: function () {
            closeAuthModal();
            closeTreeModal();
            $(document).off("keydown.opcuaTreeModal");
        }
    });
})();
