(function () {
    var selectedItemsState = [];
    var selectedNodeIdSet = {};
    var browseState = null;
    var expansionState = {};
    var browseSearchValue = "";
    var browseSearchTerm = "";
    var contextMenuPath = "";
    var browseSelectedPath = "";
    var renderPending = false;

    function isActiveNodeOpcua() {
        if (typeof RED !== "undefined" && RED.editor && typeof RED.editor.getSelectedNode === "function") {
            var node = RED.editor.getSelectedNode();
            return node && node.type === "opcua-client";
        }
        return false;
    }

    function debounce(fn, delay) {
        var timer;
        return function () {
            var ctx = this, args = arguments;
            clearTimeout(timer);
            timer = setTimeout(function () { fn.apply(ctx, args); }, delay);
        };
    }

    function rebuildNodeIdIndex() {
        selectedNodeIdSet = {};
        selectedItemsState.forEach(function (item, i) {
            if (item.nodeID) selectedNodeIdSet[item.nodeID] = i;
        });
    }

    function openBrowseModal() { $("#node-input-browse-modal").show(); $("body").addClass("opcua-tree-modal-open"); }
    function closeBrowseModal() {
        hideTreeContextMenu();
        $("#node-input-browse-modal").hide();
        $("body").removeClass("opcua-tree-modal-open");
    }

    function getBrowseCacheKey() {
        var connectionId = $("#node-input-connection").val() || "";
        if (!connectionId) return "";
        return "opcua-client-browse-cache:" + connectionId;
    }

    function saveBrowseSession() {
        var key = getBrowseCacheKey();
        if (!key || !window.sessionStorage) return;
        try {
            sessionStorage.setItem(key, JSON.stringify({
                browseState: browseState,
                expansionState: expansionState
            }));
        } catch (error) { }
    }

    function loadBrowseSession() {
        var key = getBrowseCacheKey();
        if (!key || !window.sessionStorage) return false;
        try {
            var raw = sessionStorage.getItem(key);
            if (!raw) return false;
            var parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object") return false;
            browseState = parsed.browseState && typeof parsed.browseState === "object" ? parsed.browseState : null;
            expansionState = parsed.expansionState && typeof parsed.expansionState === "object" ? parsed.expansionState : {};
            return !!browseState;
        } catch (error) {
            return false;
        }
    }

    function parseSelectedItems(rawValue) {
        if (!rawValue) return [];

        try {
            var parsed = JSON.parse(rawValue);
            if (!Array.isArray(parsed)) return [];

            return parsed
                .filter(function (item) {
                    return item && typeof item === "object" && !Array.isArray(item);
                })
                .map(function (item) {
                    var res = {
                        name: typeof item.name === "string" ? item.name.trim() : "",
                        nodeID: typeof (item.nodeID || item.nodeId) === "string" ? String(item.nodeID || item.nodeId).trim() : "",
                        type: typeof (item.type || item.dataType) === "string" ? String(item.type || item.dataType).trim() : "",
                        nodeClass: typeof item.nodeClass === "string" ? item.nodeClass.trim() : "",
                        typeDefinition: typeof (item.typeDefinition || item.typeDefinitionName) === "string" ? String(item.typeDefinition || item.typeDefinitionName).trim() : "",
                        hasTypeDefinition: item.hasTypeDefinition && typeof item.hasTypeDefinition === "object" ? item.hasTypeDefinition : null,
                        valueProperty: typeof item.valueProperty === "string" && item.valueProperty.trim() ? item.valueProperty.trim() : "payload",
                        valuePropertyType: (item.valuePropertyType === "msg" || item.valuePropertyType === "flow" || item.valuePropertyType === "global") ? item.valuePropertyType : "msg"
                    };

                    if (item.objectId) res.objectId = item.objectId;
                    if (Array.isArray(item.inputs)) res.inputs = item.inputs;
                    if (Array.isArray(item.outputs)) res.outputs = item.outputs;

                    return res;
                })
                .filter(function (item) {
                    return !!item.nodeID;
                });
        } catch (error) {
            return [];
        }
    }

    function serializeSelectedItems(items) {
        return JSON.stringify(items.map(function (item) {
            var result = {
                name: item.name || item.nodeID,
                nodeID: item.nodeID
            };

            if (item.type) result.type = item.type;
            if (item.nodeClass) result.nodeClass = item.nodeClass;
            if (item.typeDefinition) result.typeDefinition = item.typeDefinition;
            if (item.hasTypeDefinition) result.hasTypeDefinition = item.hasTypeDefinition;

            if (item.valueProperty && item.nodeClass !== "Method") result.valueProperty = item.valueProperty;
            if (item.valuePropertyType && item.nodeClass !== "Method") result.valuePropertyType = item.valuePropertyType;

            if (item.objectId) result.objectId = item.objectId;
            if (item.inputs) result.inputs = item.inputs;
            if (item.outputs) result.outputs = item.outputs;

            return result;
        }), null, 2);
    }

    function escapeHtml(value) {
        return String(value || "").replace(/[&<>"']/g, function (char) {
            return {
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;"
            }[char];
        });
    }

    function updateSelectedItemsField() {
        $("#node-input-selectedItems").val(serializeSelectedItems(selectedItemsState));
    }

    function normalizeSearchTerm(value) {
        return String(value || "").trim().toLowerCase();
    }

    function textForSearch(item) {
        if (!item || typeof item !== "object") return "";
        return [
            item.name,
            item.displayName,
            item.browseName,
            item.nodeID,
            item.nodeClass,
            item.dataType,
            item.description
        ].filter(Boolean).join(" ").toLowerCase();
    }

    function nodeMatchesSearch(item, term) {
        if (!term) return true;
        return textForSearch(item).indexOf(term) >= 0;
    }

    function branchHasSearchMatch(item, term) {
        if (nodeMatchesSearch(item, term)) return true;
        if (!item || !Array.isArray(item.browse)) return false;
        for (var i = 0; i < item.browse.length; i += 1) {
            if (branchHasSearchMatch(item.browse[i], term)) return true;
        }
        return false;
    }

    function renderSelectedItems() {
        var container = $("#node-input-selected-tags");
        if (!container.length) return;
        container.empty();

        if (!selectedItemsState.length) {
            container.append('<div class="opcua-tree-empty">No items selected.</div>');
            return;
        }

        var writeMode = $("#node-input-mode").val() === "write";

        selectedItemsState.forEach(function (item, index) {
            if (item.nodeClass === "Method") {
                // Renderiza o item do tipo Method estruturado na mesma lista
                var chip = $('<div class="opcua-client-method-chip" style="margin-bottom:12px; border: 1px solid #ccc; padding: 10px; background: #fff; border-radius: 4px;"></div>');
                var header = $('<div class="opcua-client-method-header" style="display:flex; align-items:center; margin-bottom:8px;"></div>');
                header.append('<span class="opcua-tree-icon" style="margin-right:6px;"><i class="fa fa-cog"></i></span>');
                header.append('<span class="opcua-client-method-title" style="font-weight:bold; flex-grow:1;">' + escapeHtml(item.name || item.nodeID) + '</span>');

                var nodeLabel = escapeHtml(item.nodeID);
                if (item.objectId) nodeLabel += ' · <span style="color:#aaa;font-weight:400;">obj: ' + escapeHtml(item.objectId) + '</span>';
                header.append('<span class="opcua-client-nodeid-label" style="font-size:11px; color:#666; margin-right:10px;">' + nodeLabel + '</span>');
                header.append('<div class="opcua-tree-actions" style="margin:0;"><a href="#" class="editor-button editor-button-small opcua-method-remove" data-mindex="' + index + '"><i class="fa fa-trash"></i></a></div>');
                chip.append(header);

                chip.append('<div class="opcua-client-method-section-label" style="font-size:12px; font-weight:bold; margin-top:6px; margin-bottom:4px;"><i class="fa fa-arrow-right" style="font-size:10px;margin-right:3px;"></i>Input arguments</div>');

                if (!item.inputs || !item.inputs.length) {
                    chip.append('<div style="font-size:11px;color:#aaa;padding:1px 0 3px 26px;">No input arguments</div>');
                } else {
                    item.inputs.forEach(function (inp, iIndex) {
                        var propId = "opcua-method-inp-prop-" + index + "-" + iIndex;
                        var typeId = "opcua-method-inp-type-" + index + "-" + iIndex;
                        var type = (inp.valuePropertyType === "flow" || inp.valuePropertyType === "global") ? inp.valuePropertyType : "msg";
                        var prop = inp.valueProperty || "payload";

                        var row = $('<div class="opcua-client-tag-chip opcua-client-method-inp-chip" style="margin-bottom:4px;"></div>');
                        row.append('<div class="opcua-tree-icon"><i class="fa fa-tag"></i></div>');
                        row.append('<div class="opcua-tree-title" title="' + escapeHtml(inp.dataType || "") + '">'
                            + escapeHtml(inp.name)
                            + '<span style="color:#aaa;font-size:11px;font-weight:400;margin-left:4px;">(' + escapeHtml(inp.dataType || "?") + ')</span>'
                            + '</div>');
                        row.append('<div class="opcua-client-tag-write">'
                            + '<input type="text" class="opcua-method-inp-prop" id="' + propId + '" data-mindex="' + index + '" data-iindex="' + iIndex + '" value="' + escapeHtml(prop) + '" placeholder="payload">'
                            + '<input type="hidden" class="opcua-method-inp-type" id="' + typeId + '" data-mindex="' + index + '" data-iindex="' + iIndex + '" value="' + escapeHtml(type) + '">'
                            + '</div>');
                        row.append('<div class="opcua-client-tag-right">'
                            + '<div class="opcua-tree-actions"><a href="#" class="editor-button editor-button-small opcua-method-remove-input" data-mindex="' + index + '" data-iindex="' + iIndex + '"><i class="fa fa-times"></i></a></div>'
                            + '</div>');
                        chip.append(row);
                    });
                }

                chip.append('<div class="opcua-method-section-row" style="margin-top:6px;"><a href="#" class="editor-button editor-button-small opcua-method-add-input" data-mindex="' + index + '"><i class="fa fa-plus"></i> Add input</a></div>');

                var outputs = item.outputs || [];
                chip.append('<div class="opcua-client-method-section-label" style="font-size:12px; font-weight:bold; margin-top:10px; margin-bottom:4px;"><i class="fa fa-arrow-left" style="font-size:10px;margin-right:3px;"></i>Output arguments</div>');

                if (!outputs.length) {
                    chip.append('<div style="font-size:11px;color:#aaa;padding:1px 0 3px 26px;">No output arguments</div>');
                } else {
                    outputs.forEach(function (out) {
                        var row = $('<div class="opcua-client-tag-chip" style="margin-bottom:4px;background:#f3f3f3;border-color:#e8e8e8;"></div>');
                        row.append('<div class="opcua-tree-icon" style="color:#bbb;"><i class="fa fa-tag"></i></div>');
                        row.append('<div class="opcua-tree-title" style="color:#888;" title="' + escapeHtml(out.dataType || "") + '">'
                            + escapeHtml(out.name)
                            + '<span style="color:#bbb;font-size:11px;font-weight:400;margin-left:4px;">(' + escapeHtml(out.dataType || "?") + ')</span>'
                            + '</div>');
                        row.append('<div class="opcua-client-tag-right"><span style="font-size:11px;color:#bbb;font-style:italic;">read-only</span></div>');
                        chip.append(row);
                    });
                }
                container.append(chip);
            } else {
                // Renderiza as Tags / Variáveis normais
                var row = $('<div class="opcua-client-tag-chip" style="margin-bottom:4px;"></div>');
                var icon = browseIconFor(item);
                row.append('<div class="opcua-tree-icon"><i class="fa ' + icon + '"></i></div>');
                row.append('<div class="opcua-tree-title">' + escapeHtml(item.name || item.nodeID) + '</div>');
                if (writeMode) {
                    var type = (item.valuePropertyType === "flow" || item.valuePropertyType === "global") ? item.valuePropertyType : "msg";
                    var prop = item.valueProperty || "payload";
                    row.append('<div class="opcua-client-tag-write">'
                        + '<input type="text" class="opcua-client-item-value-prop" id="opcua-client-item-value-prop-' + index + '" data-index="' + index + '" value="' + escapeHtml(prop) + '" placeholder="payload">'
                        + '<input type="hidden" class="opcua-client-item-value-type" id="opcua-client-item-value-type-' + index + '" data-index="' + index + '" value="' + escapeHtml(type) + '">'
                        + "</div>");
                }

                row.append('<div class="opcua-client-tag-right">'
                    + '<div class="opcua-client-nodeid-label">' + escapeHtml(item.nodeID) + '</div>'
                    + '<div class="opcua-tree-actions"><a href="#" class="editor-button editor-button-small opcua-client-remove-tag" data-index="' + index + '"><i class="fa fa-trash"></i></a></div>'
                    + "</div>");
                container.append(row);
            }
        });

        initializeSelectedItemTypedInputs();

        // Inicializa dinamicamente os typedInputs dos parâmetros dos Métodos inseridos na lista unificada
        $(".opcua-method-inp-prop").each(function () {
            var input = $(this);
            if (input.data("typedInputInitialized")) {
                input.typedInput("types", ["msg", "flow", "global"]);
                return;
            }
            var mindex = input.attr("data-mindex");
            var iindex = input.attr("data-iindex");
            var typeField = "#opcua-method-inp-type-" + mindex + "-" + iindex;
            input.typedInput({ type: $(typeField).val() || "msg", types: ["msg", "flow", "global"], typeField: typeField });
            input.data("typedInputInitialized", true);
        });
    }

    function initializeSelectedItemTypedInputs() {
        $(".opcua-client-item-value-prop").each(function () {
            var input = $(this);
            var index = Number(input.attr("data-index"));
            var typeField = "#opcua-client-item-value-type-" + index;
            if (input.data("typedInputInitialized")) {
                input.typedInput("types", ["msg", "flow", "global"]);
                return;
            }

            input.typedInput({
                type: $(typeField).val() || "msg",
                types: ["msg", "flow", "global"],
                typeField: typeField
            });
            input.data("typedInputInitialized", true);
        });

    }

    function syncSelectedItems() {
        rebuildNodeIdIndex();
        updateSelectedItemsField();
        renderSelectedItems();
        renderBrowseTree();
    }

    function isExpanded(path, defaultValue) {
        if (expansionState[path] === undefined) {
            expansionState[path] = !!defaultValue;
        }
        return expansionState[path];
    }

    function selectedIndexByNodeId(nodeId) {
        var idx = selectedNodeIdSet[nodeId];
        return (idx !== undefined) ? idx : -1;
    }

    function canExpand(item) {
        return item && item.nodeClass !== "Variable"
    }

    function isVariable(item) {
        return String(item && item.nodeClass || "").toLowerCase() === "variable";
    }

    function nodeIdOf(item) {
        return item && (item.nodeID || item.nodeId) ? String(item.nodeID || item.nodeId) : "";
    }

    function loadBrowse(nodeId) {

        var connectionId = $("#node-input-connection").val();
        if (!connectionId) {
            RED.notify("Select an OPC UA connection before browsing.", "warning");
            return $.Deferred().reject().promise();
        }

        return $.getJSON("opcua-client-config/" + encodeURIComponent(connectionId) + "/browse", {
            nodeId: nodeId || "i=84"
        });
    }

    function renderBrowseTree() {
        if (renderPending) return;
        renderPending = true;
        setTimeout(function () {
            renderPending = false;
            _doRenderBrowseTree();
        }, 0);
    }

    function _doRenderBrowseTree() {
        var container = $("#node-input-browse-tree");
        var frag = document.createDocumentFragment();

        if (!browseState) {
            var empty = document.createElement("div");
            empty.className = "opcua-tree-empty";
            empty.textContent = "Click Browse to load the server tree.";
            frag.appendChild(empty);
            container[0].innerHTML = "";
            container[0].appendChild(frag);
            return;
        }

        if (browseSearchTerm) {
            if (!branchHasSearchMatch(browseState, browseSearchTerm)) {
                var noMatch = document.createElement("div");
                noMatch.className = "opcua-tree-empty";
                noMatch.textContent = "No items found in the already explored items.";
                frag.appendChild(noMatch);
                container[0].innerHTML = "";
                container[0].appendChild(frag);
                return;
            }
            renderBrowseRootFiltered(browseState, "root", 0, frag, browseSearchTerm);
            container[0].innerHTML = "";
            container[0].appendChild(frag);
            return;
        }

        renderBrowseRoot(browseState, "root", 0, frag);
        container[0].innerHTML = "";
        container[0].appendChild(frag);
    }

    function isFolderNode(item) {
        if (!item) return false;
        var nodeClass = String(item.nodeClass || "");
        var typeDefinition = String(item.typeDefinition || item.typeDefinitionName || "").toLowerCase();
        var hasTypeDefinitionBrowseName = String(
            item.hasTypeDefinition && item.hasTypeDefinition.browseName || ""
        ).toLowerCase();
        var explicitType = String(item.type || item.kind || "").toLowerCase();
        if (nodeClass === "Folder") return true;
        if (hasTypeDefinitionBrowseName === "foldertype") return true;
        if (typeDefinition.indexOf("folder") >= 0) return true;
        if (explicitType === "folder") return true;
        return false;
    }

    function browseIconFor(item) {
        var nodeClass = String((item && item.nodeClass) || "");
        if (isFolderNode(item)) return "fa-folder";
        if (nodeClass === "Object") return "fa-cube";
        if (nodeClass === "Method") return "fa-cog";
        if (nodeClass === "Variable") return "fa-tag";
        if (nodeClass === "ObjectType") return "fa-cubes";
        if (nodeClass === "View") return "fa-eye";
        if (nodeClass === "DataType") return "fa-database";
        if (nodeClass === "ReferenceType") return "fa-random";
        return "fa-tag";
    }

    function makeEl(tag, className, html) {
        var el = document.createElement(tag);
        if (className) el.className = className;
        if (html !== undefined) el.innerHTML = html;
        return el;
    }

    function makeTreeRow(path, extraClass) {
        var row = document.createElement("div");
        row.className = "opcua-tree-row" + (extraClass ? " " + extraClass : "");
        row.setAttribute("data-path", path);
        return row;
    }

    function renderBrowseRoot(root, path, depth, frag) {
        var expanded = isExpanded(path, true);
        var row = makeTreeRow(path);
        row.innerHTML = '<span class="opcua-tree-indent"></span>'
            + '<span class="opcua-tree-twisty opcua-client-toggle-tree" data-path="' + escapeHtml(path) + '">'
            + (expanded ? '<i class="fa fa-caret-down"></i>' : '<i class="fa fa-caret-right"></i>') + '</span>'
            + '<span class="opcua-tree-icon"><i class="fa fa-sitemap"></i></span>'
            + '<span class="opcua-tree-label">' + escapeHtml(root.name || root.nodeID || "RootFolder") + '</span>'
            + '<span class="opcua-tree-type">' + escapeHtml(root.nodeID || "") + '</span>';
        frag.appendChild(row);

        if (!expanded) return;

        if (!Array.isArray(root.browse) || !root.browse.length) {
            frag.appendChild(makeEl("div", "opcua-tree-empty", "No items found.."));
        } else {
            root.browse.forEach(function (item, index) {
                renderBrowseItem(item, path + ".browse." + index, depth + 1, frag);
            });
        }
    }

    function renderBrowseItem(item, path, depth, frag) {
        var expanded = isExpanded(path, false);
        var nodeId = nodeIdOf(item);
        var selectedIndex = selectedIndexByNodeId(nodeId);
        var hasChildren = canExpand(item);
        var row = makeTreeRow(path, selectedIndex >= 0 ? "is-selected" : "");

        var indents = "";
        for (var i = 0; i < depth; i += 1) indents += '<span class="opcua-tree-indent"></span>';

        var twisty = '<span class="opcua-tree-twisty' + (hasChildren ? ' opcua-client-toggle-tree' : '') + '" data-path="' + escapeHtml(path) + '">'
            + (hasChildren ? '<i class="fa ' + (expanded ? 'fa-caret-down' : 'fa-caret-right') + '"></i>' : '') + '</span>';

        var actions = nodeId
            ? '<div class="opcua-tree-actions"><a href="#" class="editor-button editor-button-small opcua-client-toggle-tag" data-nodeid="' + escapeHtml(nodeId) + '" data-path="' + escapeHtml(path) + '"><i class="fa ' + (selectedIndex >= 0 ? 'fa-minus' : 'fa-plus') + '"></i> ' + (selectedIndex >= 0 ? 'Remove' : 'Add') + '</a></div>'
            : '';

        row.innerHTML = indents + twisty
            + '<span class="opcua-tree-icon"><i class="fa ' + browseIconFor(item) + '"></i></span>'
            + '<span class="opcua-tree-label">' + escapeHtml(item.displayName || item.browseName || item.nodeID) + '</span>'
            + '<span class="opcua-tree-type">' + escapeHtml(item.nodeClass || "") + (item.dataType ? " | " + escapeHtml(item.dataType) : "") + '</span>'
            + '<span class="opcua-client-nodeid-label">' + escapeHtml(nodeId) + '</span>'
            + actions;
        frag.appendChild(row);

        if (item.description) {
            var desc = makeEl("div", "opcua-client-description");
            desc.style.padding = "0 10px 8px " + String((depth + 2) * 14) + "px";
            desc.textContent = item.description;
            frag.appendChild(desc);
        }

        if (expanded && hasChildren) {
            if (Array.isArray(item.browse)) {
                if (!item.browse.length) {
                    frag.appendChild(makeEl("div", "opcua-tree-empty", "No children found.."));
                } else {
                    item.browse.forEach(function (child, index) {
                        renderBrowseItem(child, path + ".browse." + index, depth + 1, frag);
                    });
                }
            } else {
                frag.appendChild(makeEl("div", "opcua-tree-empty", "Searching for items..."));
            }
        }
    }

    function renderBrowseRootFiltered(root, path, depth, frag, term) {
        var row = makeTreeRow(path);
        row.innerHTML = '<span class="opcua-tree-indent"></span>'
            + '<span class="opcua-tree-twisty"><i class="fa fa-caret-down"></i></span>'
            + '<span class="opcua-tree-icon"><i class="fa fa-sitemap"></i></span>'
            + '<span class="opcua-tree-label">' + escapeHtml(root.name || root.nodeID || "RootFolder") + '</span>'
            + '<span class="opcua-tree-type">' + escapeHtml(root.nodeID || "") + '</span>';
        frag.appendChild(row);

        if (!Array.isArray(root.browse) || !root.browse.length) {
            frag.appendChild(makeEl("div", "opcua-tree-empty", "Nenhum item encontrado."));
            return;
        }

        root.browse.forEach(function (item, index) {
            if (branchHasSearchMatch(item, term)) {
                renderBrowseItemFiltered(item, path + ".browse." + index, depth + 1, frag, term, false);
            }
        });
    }

    function renderBrowseItemFiltered(item, path, depth, frag, term, ancestorMatched) {
        if (!branchHasSearchMatch(item, term)) return;

        var nodeId = nodeIdOf(item);
        var selectedIndex = selectedIndexByNodeId(nodeId);
        var hasChildren = canExpand(item);
        var subtreeVisible = !!ancestorMatched || nodeMatchesSearch(item, term);
        var hasMatchingLoadedChild = hasChildren && Array.isArray(item.browse) && item.browse.some(function (child) {
            return branchHasSearchMatch(child, term);
        });
        var hasExplicitExpansion = expansionState[path] !== undefined;
        var expanded = hasChildren && (hasExplicitExpansion
            ? !!expansionState[path]
            : ((subtreeVisible && Array.isArray(item.browse)) || hasMatchingLoadedChild));

        var row = makeTreeRow(path, selectedIndex >= 0 ? "is-selected" : "");

        var indents = "";
        for (var i = 0; i < depth; i += 1) indents += '<span class="opcua-tree-indent"></span>';

        var twisty = '<span class="opcua-tree-twisty' + (hasChildren ? ' opcua-client-toggle-tree' : '') + '" data-path="' + escapeHtml(path) + '">'
            + (hasChildren ? '<i class="fa ' + (expanded ? 'fa-caret-down' : 'fa-caret-right') + '"></i>' : '') + '</span>';

        var actions = nodeId
            ? '<div class="opcua-tree-actions"><a href="#" class="editor-button editor-button-small opcua-client-toggle-tag" data-nodeid="' + escapeHtml(nodeId) + '" data-path="' + escapeHtml(path) + '"><i class="fa ' + (selectedIndex >= 0 ? 'fa-minus' : 'fa-plus') + '"></i> ' + (selectedIndex >= 0 ? 'Remove' : 'Add') + '</a></div>'
            : '';

        row.innerHTML = indents + twisty
            + '<span class="opcua-tree-icon"><i class="fa ' + browseIconFor(item) + '"></i></span>'
            + '<span class="opcua-tree-label">' + escapeHtml(item.displayName || item.browseName || item.nodeID) + '</span>'
            + '<span class="opcua-tree-type">' + escapeHtml(item.nodeClass || "") + (item.dataType ? " | " + escapeHtml(item.dataType) : "") + '</span>'
            + '<span class="opcua-client-nodeid-label">' + escapeHtml(nodeId) + '</span>'
            + actions;
        frag.appendChild(row);

        if (item.description) {
            var desc = makeEl("div", "opcua-client-description");
            desc.style.padding = "0 10px 8px " + String((depth + 2) * 14) + "px";
            desc.textContent = item.description;
            frag.appendChild(desc);
        }

        if (expanded && hasChildren) {
            if (Array.isArray(item.browse)) {
                if (!item.browse.length) {
                    frag.appendChild(makeEl("div", "opcua-tree-empty", "Nenhum filho encontrado."));
                } else {
                    item.browse.forEach(function (child, index) {
                        if (subtreeVisible || branchHasSearchMatch(child, term)) {
                            renderBrowseItemFiltered(child, path + ".browse." + index, depth + 1, frag, term, subtreeVisible);
                        }
                    });
                }
            } else {
                frag.appendChild(makeEl("div", "opcua-tree-empty", "Expandindo..."));
            }
        }
    }

    function getItemAtPath(path) {
        var tokens = String(path || "").split(".");
        var current = browseState;

        for (var index = 0; index < tokens.length; index += 1) {
            var token = tokens[index];
            if (!token || token === "root") continue;
            if (!current) return null;
            if (/^\d+$/.test(token)) {
                current = current[Number(token)];
            } else {
                current = current[token];
            }
        }

        return current || null;
    }

    function addSelectedItem(item) {
        var normalized = {
            name: item.displayName || item.browseName || item.name || item.nodeID,
            nodeID: item.nodeID || item.nodeId,
            type: item.dataType || item.type || "",
            nodeClass: item.nodeClass || "",
            typeDefinition: item.typeDefinition || item.typeDefinitionName || "",
            hasTypeDefinition: item.hasTypeDefinition || null,
            valueProperty: item.valueProperty || "payload",
            valuePropertyType: item.valuePropertyType || "msg"
        };
        var currentIndex = selectedIndexByNodeId(normalized.nodeID);

        if (currentIndex >= 0) {
            selectedItemsState[currentIndex] = normalized;
        } else {
            selectedItemsState.push(normalized);
        }

        syncSelectedItems();
    }

    function removeSelectedItemByIndex(index) {
        selectedItemsState.splice(index, 1);
        syncSelectedItems();
    }

    function toggleSelectedNode(path) {
        var item = getItemAtPath(path);
        var nodeId = nodeIdOf(item);
        if (!item || !nodeId) return;

        var currentIndex = selectedIndexByNodeId(nodeId);
        if (currentIndex >= 0) {
            selectedItemsState.splice(currentIndex, 1);
        } else {
            addSelectedItem(item);
            return;
        }

        syncSelectedItems();
    }

    function refreshBrowseRoot() {
        var rootNodeId = "i=84";
        var container = $("#node-input-browse-tree");
        container.html('<div class="opcua-tree-empty">Carregando...</div>');

        loadBrowse(rootNodeId).done(function (payload) {
            browseState = payload;
            expansionState = { root: true };
            saveBrowseSession();
            renderBrowseTree();
        }).fail(function (xhr) {
            var message = xhr && xhr.responseJSON && xhr.responseJSON.error
                ? xhr.responseJSON.error
                : "Failed to browse the OPC UA server.";
            browseState = null;
            container.html('<div class="opcua-tree-empty">' + escapeHtml(message) + '</div>');
            RED.notify(message, "error");
        });
    }

    function hideTreeContextMenu() {
        contextMenuPath = "";
        $("#node-input-browse-context-menu").hide();
    }

    function showTreeContextMenu(x, y, path) {
        var menu = $("#node-input-browse-context-menu");
        var item = getItemAtPath(path);
        contextMenuPath = path || "";
        $("#node-input-browse-context-refresh").toggle(!!item && !isVariable(item));
        $("#node-input-browse-context-copy-nodeid").toggle(!!nodeIdOf(item));
        $("#node-input-browse-context-read-value").toggle(!!item && isVariable(item) && !!nodeIdOf(item));
        menu.css({ left: x + "px", top: y + "px" }).show();
    }

    function copyNodeIdFromPath(path) {
        var item = getItemAtPath(path);
        var nodeId = nodeIdOf(item);
        if (!nodeId) {
            RED.notify("NodeID not found for the selected item.", "warning");
            return;
        }

        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            navigator.clipboard.writeText(nodeId).then(function () {
                RED.notify("NodeID copied.", "success");
            }).catch(function () {
                RED.notify("Failed to copy NodeID.", "error");
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
            RED.notify("NodeID copied.", "success");
        } catch (error) {
            RED.notify("Failed to copy NodeID.", "error");
        }
        input.remove();
    }

    function readValueFromPath(path) {
        var item = getItemAtPath(path);
        var nodeId = nodeIdOf(item);
        if (!nodeId) {
            RED.notify("NodeID not found for the selected item.", "warning");
            return;
        }

        var connectionId = $("#node-input-connection").val();
        if (!connectionId) {
            RED.notify("Select an OPC UA connection before reading.", "warning");
            return;
        }

        $.getJSON("opcua-client-config/" + encodeURIComponent(connectionId) + "/read", {
            nodeId: nodeId
        }).done(function (payload) {
            if (payload && payload.error) {
                RED.notify("Read failed: " + payload.error, "error");
            } else if (payload) {
                var valueText = (payload.valueEnumeration !== undefined && payload.valueEnumeration !== null)
                    ? payload.valueEnumeration + " (" + payload.value + ")"
                    : (payload.value !== undefined ? String(payload.value) : "undefined");
                RED.notify("Variable value: " + valueText, "success");
            } else {
                RED.notify("No value returned from the server.", "warning");
            }
        }).fail(function (xhr) {
            var message = xhr && xhr.responseJSON && xhr.responseJSON.error
                ? xhr.responseJSON.error
                : "Failed to read variable value.";
            RED.notify(message, "error");
        });
    }

    function setBrowseSelectedPath(path) {
        browseSelectedPath = path || "";
        $(".opcua-tree-row").removeClass("is-selected");
        if (browseSelectedPath) {
            $('.opcua-tree-row[data-path="' + browseSelectedPath + '"]').addClass("is-selected");
        }
    }

    function refreshNode(path) {
        if (!path) return;
        if (path === "root") {
            refreshBrowseRoot();
            return;
        }

        var item = getItemAtPath(path);
        if (!item || isVariable(item)) return;

        item.browse = undefined;
        expansionState[path] = true;
        saveBrowseSession();
        renderBrowseTree();
        expandNode(path);
    }

    function expandNode(path) {
        var item = getItemAtPath(path);
        if (!item || !canExpand(item)) return;

        if (isExpanded(path, false) && !Array.isArray(item.browse)) {
            renderBrowseTree();
        } else {
            expansionState[path] = !isExpanded(path, false);
            saveBrowseSession();
            if (!expansionState[path]) {
                renderBrowseTree();
                return;
            }
        }

        if (Array.isArray(item.browse)) {
            renderBrowseTree();
            return;
        }

        renderBrowseTree();
        var browseNodeId = item.nodeID || item.nodeId;
        loadBrowse(browseNodeId).done(function (payload) {
            try {
                if (!payload) {
                    console.error("Browse returned empty payload for node " + browseNodeId);
                    RED.notify("Browse returned empty payload.", "error");
                    item.browse = [];
                } else if (payload.error) {
                    console.error("Browse returned error for node " + browseNodeId + ":", payload.error);
                    RED.notify(payload.error, "error");
                    item.browse = [];
                } else {
                    item.browse = Array.isArray(payload.browse) ? payload.browse : [];
                }
                saveBrowseSession();
                renderBrowseTree();
                triggerChildrenExpansion(item.browse, path);
            } catch (err) {
                console.error("Error handling browse payload for node " + browseNodeId + ":", err);
                RED.notify("Error handling browse response: " + err.message, "error");
                expansionState[path] = false;
                saveBrowseSession();
                renderBrowseTree();
            }
        }).fail(function (xhr) {
            expansionState[path] = false;
            saveBrowseSession();
            renderBrowseTree();
            var message = xhr && xhr.responseJSON && xhr.responseJSON.error
                ? xhr.responseJSON.error
                : "Failed to expand the node.";
            RED.notify(message, "error");
            console.error("Browse request failed for node " + browseNodeId + ":", xhr);
        });
    }

    function triggerChildrenExpansion(children, parentPath) {
        if (!Array.isArray(children)) return;
        children.forEach(function (child, index) {
            var childPath = parentPath + ".browse." + index;
            if (isExpanded(childPath, false)) {
                if (!Array.isArray(child.browse)) {
                    expandNode(childPath);
                } else {
                    triggerChildrenExpansion(child.browse, childPath);
                }
            }
        });
    }

    function methodNodeIdOf(item) {
        return item && (item.nodeID || item.nodeId) ? String(item.nodeID || item.nodeId) : "";
    }

    function addMethodFromTree(item, parentItem) {
        var nodeID = methodNodeIdOf(item);
        var objectId = parentItem ? methodNodeIdOf(parentItem) : "";
        var methodName = item.displayName || item.browseName || item.name || nodeID;

        for (var i = 0; i < selectedItemsState.length; i++) {
            if (selectedItemsState[i].nodeID === nodeID && selectedItemsState[i].nodeClass === "Method") {
                RED.notify("Method already added.", "warning");
                return;
            }
        }

        var connectionId = $("#node-input-connection").val();

        $.getJSON(
            "opcua-client-config/" + encodeURIComponent(connectionId) + "/browse",
            { nodeId: nodeID }
        )
            .done(function (payload) {
                var browseItems = Array.isArray(payload.browse) ? payload.browse : [];
                var inputArgs = [];
                var outputArgs = [];

                browseItems.forEach(function (child) {
                    var name = String(child.displayName || child.browseName || "").toLowerCase();

                    if ((name === "inputarguments" || name === "inputargument") && Array.isArray(child.value)) {
                        inputArgs = child.value;
                    }

                    if ((name === "outputarguments" || name === "outputargument") && Array.isArray(child.value)) {
                        outputArgs = child.value;
                    }
                });

                var inputs = inputArgs.map(function (arg, idx) {
                    return {
                        name: arg.name || ("arg" + idx),
                        dataType: opcuaDataTypeName(arg.dataType),
                        valueProperty: "payload",
                        valuePropertyType: "msg"
                    };
                });

                var outputs = outputArgs.map(function (arg, idx) {
                    return {
                        name: arg.name || ("out" + idx),
                        dataType: opcuaDataTypeName(arg.dataType)
                    };
                });

                pushMethodItem(nodeID, objectId, methodName, inputs, outputs);
            })
            .fail(function () {
                pushMethodItem(nodeID, objectId, methodName, [], []);
            });
    }

    function opcuaDataTypeName(dataType) {
        switch (String(dataType || "")) {
            case "ns=0;i=1": return "Boolean";
            case "ns=0;i=2": return "SByte";
            case "ns=0;i=3": return "Byte";
            case "ns=0;i=4": return "Int16";
            case "ns=0;i=5": return "UInt16";
            case "ns=0;i=6": return "Int32";
            case "ns=0;i=7": return "UInt32";
            case "ns=0;i=8": return "Int64";
            case "ns=0;i=9": return "UInt64";
            case "ns=0;i=10": return "Float";
            case "ns=0;i=11": return "Double";
            case "ns=0;i=12": return "String";
            case "ns=0;i=13": return "DateTime";
            case "ns=0;i=14": return "Guid";
            case "ns=0;i=15": return "ByteString";
            case "ns=0;i=16": return "XmlElement";
            case "ns=0;i=17": return "NodeId";
            case "ns=0;i=18": return "ExpandedNodeId";
            case "ns=0;i=19": return "StatusCode";
            case "ns=0;i=20": return "QualifiedName";
            case "ns=0;i=21": return "LocalizedText";
            case "ns=0;i=22": return "ExtensionObject";
            case "ns=0;i=26": return "Number";
            case "ns=0;i=27": return "Integer";
            case "ns=0;i=28": return "UInteger";
            default: return String(dataType || "");
        }
    }

    function pushMethodItem(nodeID, objectId, name, inputs, outputs) {
        selectedItemsState.push({
            nodeID: nodeID,
            objectId: objectId,
            name: name,
            inputs: inputs || [],
            outputs: outputs || [],
            nodeClass: "Method"
        });
        syncSelectedItems();
    }

    function toggleModeFields() {
        var mode = $("#node-input-mode").val();

        var isSubscription = mode === "subscription" || mode === "events";
        var isHistory = mode === "readHistory";
        var supportsSelection = mode !== "getSubscriptionId";

        $(".opcua-client-subscription-row").toggle(isSubscription);
        $(".opcua-client-history-row").toggle(isHistory);
        $(".opcua-client-selection-row").toggle(supportsSelection);

        // Esconde permanentemente a linha de métodos antiga caso ainda exista no DOM
        $(".opcua-client-method-row").hide();

        renderSelectedItems();
    }

    RED.nodes.registerType("opcua-client", {
        category: "network",
        color: "#d9edf7",
        defaults: {
            name: { value: "" },
            connection: { value: "", type: "opcua-client-config", required: true },
            mode: { value: "read", required: true },
            selectedItems: {
                value: "[]",
                validate: function (value) {
                    try {
                        return Array.isArray(JSON.parse(value || "[]"));
                    } catch (error) {
                        return false;
                    }
                }
            },
            samplingInterval: {
                value: 250,
                validate: RED.validators.number()
            },
            publishingInterval: {
                value: 250,
                validate: RED.validators.number()
            },
            subscriptionMode: { value: "replace" },
            historyStartTime: { value: "startTime" },
            historyStartTimeType: { value: "msg" },
            historyEndTime: { value: "endTime" },
            historyEndTimeType: { value: "msg" }
        },
        inputs: 1,
        outputs: 1,
        icon: "opcua.svg",
        label: function () {
            if (this.name) {
                return this.name;
            }
            var modeLabels = {
                "read": "Read",
                "write": "Write",
                "browse": "Browse",
                "browseRecursive": "Browse Recursive",
                "method": "Method",
                "getSubscriptionId": "getSubscriptionId",
                "subscription": "Subscription",
                "events": "Events",
                "readHistory": "Read History"
            };
            var modeName = modeLabels[this.mode] || this.mode || "Read";
            return "client(" + modeName + ")";
        },
        oneditprepare: function () {
            $("#node-input-subscriptionMode").val(this.subscriptionMode || "replace");

            // Ensure history times have default values pre-populated on DOM inputs if empty
            if (!$("#node-input-historyStartTime").val()) {
                $("#node-input-historyStartTime").val(this.historyStartTime || "startTime");
            }
            if (!$("#node-input-historyStartTimeType").val()) {
                $("#node-input-historyStartTimeType").val(this.historyStartTimeType || "msg");
            }
            if (!$("#node-input-historyEndTime").val()) {
                $("#node-input-historyEndTime").val(this.historyEndTime || "endTime");
            }
            if (!$("#node-input-historyEndTimeType").val()) {
                $("#node-input-historyEndTimeType").val(this.historyEndTimeType || "msg");
            }

            $("#node-input-selectedItems").typedInput({
                type: "json",
                types: ["json"]
            });

            selectedItemsState = parseSelectedItems(this.selectedItems);

            $("#node-input-historyStartTime").typedInput({
                default: "msg",
                types: ["msg", "flow", "global", "str", "date"],
                typeField: $("#node-input-historyStartTimeType")
            });
            $("#node-input-historyEndTime").typedInput({
                default: "msg",
                types: ["msg", "flow", "global", "str", "date"],
                typeField: $("#node-input-historyEndTimeType")
            });
            rebuildNodeIdIndex();

            browseState = null;
            expansionState = {};
            browseSelectedPath = "";
            browseSearchValue = "";
            browseSearchTerm = "";
            $("#node-input-browse-search").val("");
            $("#node-input-browse-search-clear").hide();
            loadBrowseSession();
            syncSelectedItems();
            renderBrowseTree();

            $("#node-input-mode").off("change").on("change", toggleModeFields);
            $("#node-input-browse-root").off("click").on("click", function (event) {
                event.preventDefault();
                refreshBrowseRoot();
            });
            $("#node-input-open-browse-modal").off("click").on("click", function (event) {
                event.preventDefault();
                openBrowseModal();
            });
            $("#node-input-close-browse-modal").off("click").on("click", function (event) {
                event.preventDefault();
                closeBrowseModal();
            });
            $("#node-input-browse-modal").off("click").on("click", function (event) {
                hideTreeContextMenu();
                if (event.target === this) closeBrowseModal();
            });
            $("#node-input-browse-search").off("input").on("input", debounce(function () {
                browseSearchValue = $(this).val();
                browseSearchTerm = normalizeSearchTerm(browseSearchValue);
                $("#node-input-browse-search-clear").toggle(!!browseSearchTerm);
                renderBrowseTree();
            }, 200));
            $("#node-input-browse-search-clear").off("click").on("click", function (event) {
                event.preventDefault();
                browseSearchValue = "";
                browseSearchTerm = "";
                $("#node-input-browse-search").val("");
                $(this).hide();
                renderBrowseTree();
            });
            $("#node-input-connection").off("change.opcuaClientBrowse").on("change.opcuaClientBrowse", function () {
                browseState = null;
                expansionState = {};
                browseSelectedPath = "";
                loadBrowseSession();
                renderBrowseTree();
            });
            $(document).off("keydown.opcuaClientBrowseModal").on("keydown.opcuaClientBrowseModal", function (event) {
                hideTreeContextMenu();
                if (event.key === "Escape") closeBrowseModal();
            });

            toggleModeFields();
        },
        oneditsave: function () {
            updateSelectedItemsField();
            saveBrowseSession();
            closeBrowseModal();
            $(document).off("keydown.opcuaClientBrowseModal");
        },
        oneditcancel: function () {
            closeBrowseModal();
            $(document).off("keydown.opcuaClientBrowseModal");
        }
    });

    $(document).on("change", "#node-input-selectedItems", function () {
        if (!isActiveNodeOpcua()) return;
        selectedItemsState = parseSelectedItems($(this).val());
        renderSelectedItems();
        renderBrowseTree();
    });

    $(document).on("click", ".opcua-client-remove-tag", function (event) {
        event.preventDefault();
        removeSelectedItemByIndex(Number($(this).attr("data-index")));
    });

    $(document).on("click", ".opcua-client-toggle-tag", function (event) {
        event.preventDefault();
        var path = $(this).attr("data-path");

        if ($("#node-input-mode").val() === "method") {
            var item = getItemAtPath(path);
            if (item && item.nodeClass === "Method") {
                var parentPath = path.split(".");
                parentPath.splice(parentPath.length - 2, 2);
                parentPath = parentPath.join(".");
                var parentItem = getItemAtPath(parentPath);
                addMethodFromTree(item, parentItem);
                return;
            }
        }
        toggleSelectedNode(path);
    });

    $(document).on("click", ".opcua-client-toggle-tree", function (event) {
        event.preventDefault();
        expandNode($(this).attr("data-path"));
    });
    $(document).on("change", ".opcua-client-item-value-type", function () {
        var index = Number($(this).attr("data-index"));
        if (!selectedItemsState[index]) return;
        selectedItemsState[index].valuePropertyType = $(this).val();
        updateSelectedItemsField();
    });
    $(document).on("change input", ".opcua-client-item-value-prop", function () {
        var index = Number($(this).attr("data-index"));
        if (!selectedItemsState[index]) return;
        selectedItemsState[index].valueProperty = $(this).typedInput ? $(this).typedInput("value") : $(this).val();
        var typeField = $("#opcua-client-item-value-type-" + index);
        selectedItemsState[index].valuePropertyType = (typeField.val() || "msg");
        updateSelectedItemsField();
    });



    $(document).on("click", ".opcua-tree-row", function (event) {
        if ($(event.target).closest(".opcua-client-toggle-tree, .opcua-client-toggle-tag, .opcua-tree-actions, #node-input-browse-context-menu").length) {
            return;
        }
        var path = $(this).attr("data-path");
        setBrowseSelectedPath(path);

        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            if ($("#node-input-mode").val() === "method") {
                var item = getItemAtPath(path);
                if (item && item.nodeClass === "Method") {
                    var parentPath = path.split(".");
                    parentPath.splice(parentPath.length - 2, 2);
                    parentPath = parentPath.join(".");
                    var parentItem = getItemAtPath(parentPath);
                    addMethodFromTree(item, parentItem);
                    return;
                }
            }
            toggleSelectedNode(path);
        }
    });

    $(document).on("contextmenu", ".opcua-tree-row", function (event) {
        var clickedPath = $(this).attr("data-path");
        if (clickedPath) {
            setBrowseSelectedPath(clickedPath);
        }
        var path = browseSelectedPath || clickedPath;
        var item = getItemAtPath(path);
        if (!item) {
            hideTreeContextMenu();
            return;
        }
        event.preventDefault();
        showTreeContextMenu(event.clientX, event.clientY, path);
    });

    $(document).on("click", "#node-input-browse-context-refresh", function (event) {
        event.preventDefault();
        var highlightedPath = $(".opcua-tree-row.is-selected").first().attr("data-path") || "";
        var path = contextMenuPath || browseSelectedPath || highlightedPath || "";
        hideTreeContextMenu();
        refreshNode(path);
    });

    $(document).on("click", "#node-input-browse-context-copy-nodeid", function (event) {
        event.preventDefault();
        var highlightedPath = $(".opcua-tree-row.is-selected").first().attr("data-path") || "";
        var path = contextMenuPath || browseSelectedPath || highlightedPath || "";
        hideTreeContextMenu();
        copyNodeIdFromPath(path);
    });

    $(document).on("click", "#node-input-browse-context-read-value", function (event) {
        event.preventDefault();
        var highlightedPath = $(".opcua-tree-row.is-selected").first().attr("data-path") || "";
        var path = contextMenuPath || browseSelectedPath || highlightedPath || "";
        hideTreeContextMenu();
        readValueFromPath(path);
    });

    $(document).on("click", function (event) {
        if (!$(event.target).closest("#node-input-browse-context-menu").length) {
            hideTreeContextMenu();
        }
    });

    // ── Method browse tree events ──────────────────────────────────────

    $(document).on("click", ".opcua-method-remove", function (event) {
        event.preventDefault();
        var idx = Number($(this).attr("data-mindex"));
        selectedItemsState.splice(idx, 1);
        syncSelectedItems();
    });

    $(document).on("click", ".opcua-method-add-input", function (event) {
        event.preventDefault();
        var idx = Number($(this).attr("data-mindex"));
        if (!selectedItemsState[idx]) return;
        selectedItemsState[idx].inputs = selectedItemsState[idx].inputs || [];
        selectedItemsState[idx].inputs.push({ name: "arg" + selectedItemsState[idx].inputs.length, dataType: "String", valueProperty: "payload", valuePropertyType: "msg" });
        syncSelectedItems();
    });

    $(document).on("click", ".opcua-method-remove-input", function (event) {
        event.preventDefault();
        var mi = Number($(this).attr("data-mindex"));
        var ii = Number($(this).attr("data-iindex"));
        if (!selectedItemsState[mi]) return;
        selectedItemsState[mi].inputs.splice(ii, 1);
        syncSelectedItems();
    });

    $(document).on("change input", ".opcua-method-inp-prop", function () {
        var mi = Number($(this).attr("data-mindex"));
        var ii = Number($(this).attr("data-iindex"));
        if (!selectedItemsState[mi] || !selectedItemsState[mi].inputs[ii]) return;
        selectedItemsState[mi].inputs[ii].valueProperty = $(this).typedInput ? $(this).typedInput("value") : $(this).val();
        var typeField = $("#opcua-method-inp-type-" + mi + "-" + ii);
        selectedItemsState[mi].inputs[ii].valuePropertyType = typeField.val() || "msg";
        updateSelectedItemsField();
    });

    $(document).on("change", ".opcua-method-inp-type", function () {
        var mi = Number($(this).attr("data-mindex"));
        var ii = Number($(this).attr("data-iindex"));
        if (!selectedItemsState[mi] || !selectedItemsState[mi].inputs[ii]) return;
        selectedItemsState[mi].inputs[ii].valuePropertyType = $(this).val();
        updateSelectedItemsField();
    });

})();