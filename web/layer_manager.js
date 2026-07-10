import { app } from "/scripts/app.js";

const NODE_CLASS = "Orion4D_LayerManager";
const MAX_LAYERS = 20;
const TECHNICAL_WIDGETS = [
    "canvas_width", "canvas_height", "bg_hex", "flatten_output",
    "invert_input_masks", "layer_config",
];

const DEFAULT_DOCUMENT = {
    canvas_width: 1024,
    canvas_height: 1024,
    bg_hex: "#FFFFFF",
    flatten_output: true,
    invert_input_masks: false,
};

window.__orion4dLayerManagerNodes = window.__orion4dLayerManagerNodes || new Map();

function defaultLayer(index) {
    return {
        name: `Layer ${index}`,
        x: 0,
        y: 0,
        scale: 100,
        scale_x: 100,
        scale_y: 100,
        constrain_homothety: true,
        collapsed: false,
        rot: 0,
        opacity: 1,
        visible: true,
        edit: false,
        anchor: "top_left",
        blend: "normal",
        locked: false,
    };
}

function setWidgetHidden(widget, hidden) {
    if (!widget) return;
    widget.hidden = hidden;
    widget.__orionOriginalComputeSize ??= widget.computeSize;
    widget.computeSize = hidden ? () => [0, -4] : widget.__orionOriginalComputeSize;
    if (widget.options) widget.options.hidden = hidden;
    if (widget.element) widget.element.style.display = hidden ? "none" : "";
    if (widget.inputEl) {
        const parent = widget.inputEl.closest(".comfy-multiline-input, .comfy-input, tr") || widget.inputEl;
        parent.style.display = hidden ? "none" : "";
    }
}

function widgetByName(node, name) {
    return node.widgets?.find(widget => widget.name === name);
}

function setWidgetValue(node, name, value) {
    const widget = widgetByName(node, name);
    if (!widget) return;
    widget.value = value;
    if (widget.inputEl) {
        if (widget.inputEl.type === "checkbox") widget.inputEl.checked = Boolean(value);
        else widget.inputEl.value = value;
    }
    widget.callback?.(value);
}

function clamp(value, min, max, fallback = min) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
}

function parseConfig(node) {
    const widget = widgetByName(node, "layer_config");
    let raw = widget?.value;
    if (!raw && node.properties?.orion4d_layer_manager_state?.config) {
        raw = node.properties.orion4d_layer_manager_state.config;
    }
    try {
        const parsed = typeof raw === "string" ? JSON.parse(raw || "{}") : raw;
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function connectedLayerIndices(node) {
    const indices = new Set();
    for (const input of node.inputs || []) {
        if (input?.link == null) continue;
        const match = String(input.name || "").match(/^L(\d+)_(?:image|mask)$/);
        if (match) indices.add(Number(match[1]));
    }
    return [...indices].filter(index => index >= 1 && index <= MAX_LAYERS).sort((a, b) => a - b);
}

function connectedImageIndices(node) {
    const indices = [];
    for (const input of node.inputs || []) {
        const match = String(input.name || "").match(/^L(\d+)_image$/);
        if (match && input.link != null) indices.push(Number(match[1]));
    }
    return indices.filter(index => index >= 1 && index <= MAX_LAYERS).sort((a, b) => a - b);
}

function normalizeConfig(raw, indices = []) {
    const input = raw && typeof raw === "object" ? raw : {};
    const maxIndex = Math.max(1, ...indices, Number(input.layer_count || 1));
    const layers = Array.isArray(input.layers) ? input.layers.map(layer => layer && typeof layer === "object" ? { ...layer } : layer) : [null];
    if (!layers.length) layers.push(null);
    layers[0] = null;
    while (layers.length <= Math.min(MAX_LAYERS, maxIndex)) layers.push(null);
    for (let index = 1; index < layers.length; index++) {
        layers[index] = { ...defaultLayer(index), ...(layers[index] || {}) };
        layers[index].name = String(layers[index].name || `Layer ${index}`);
    }
    for (const index of indices) {
        while (layers.length <= index) layers.push(null);
        layers[index] = { ...defaultLayer(index), ...(layers[index] || {}) };
    }

    const order = [];
    if (Array.isArray(input.order)) {
        for (const item of input.order) {
            const index = Number(item);
            if (Number.isInteger(index) && index >= 1 && index <= MAX_LAYERS && !order.includes(index)) order.push(index);
        }
    }
    for (let index = 1; index < layers.length; index++) if (!order.includes(index)) order.push(index);
    for (const index of indices) if (!order.includes(index)) order.push(index);

    const rawSolo = Number(input.solo_layer);
    const solo_layer = Number.isInteger(rawSolo) && rawSolo >= 1 && rawSolo <= MAX_LAYERS ? rawSolo : null;

    return {
        version: 31,
        layer_count: Math.min(MAX_LAYERS, Math.max(maxIndex, ...indices, 1)),
        order,
        solo_layer,
        layers,
    };
}

function readDocument(node) {
    return {
        canvas_width: Math.round(clamp(widgetByName(node, "canvas_width")?.value, 16, 8192, 1024)),
        canvas_height: Math.round(clamp(widgetByName(node, "canvas_height")?.value, 16, 8192, 1024)),
        bg_hex: String(widgetByName(node, "bg_hex")?.value || "#FFFFFF"),
        flatten_output: Boolean(widgetByName(node, "flatten_output")?.value ?? true),
        invert_input_masks: Boolean(widgetByName(node, "invert_input_masks")?.value ?? false),
    };
}

function readState(node) {
    const indices = connectedImageIndices(node);
    return {
        document: readDocument(node),
        config: normalizeConfig(parseConfig(node), indices),
    };
}

function markGraphChanged(node) {
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
    app.graph?.change?.();
}

function writeState(node, incoming = {}) {
    const document = { ...DEFAULT_DOCUMENT, ...(incoming.document || {}) };
    document.canvas_width = Math.round(clamp(document.canvas_width, 16, 8192, 1024));
    document.canvas_height = Math.round(clamp(document.canvas_height, 16, 8192, 1024));
    document.bg_hex = String(document.bg_hex || "#FFFFFF");
    document.flatten_output = Boolean(document.flatten_output);
    document.invert_input_masks = Boolean(document.invert_input_masks);

    const config = normalizeConfig(incoming.config || parseConfig(node), connectedImageIndices(node));
    setWidgetValue(node, "canvas_width", document.canvas_width);
    setWidgetValue(node, "canvas_height", document.canvas_height);
    setWidgetValue(node, "bg_hex", document.bg_hex);
    setWidgetValue(node, "flatten_output", document.flatten_output);
    setWidgetValue(node, "invert_input_masks", document.invert_input_masks);
    setWidgetValue(node, "layer_config", JSON.stringify(config));

    node.properties = node.properties || {};
    node.properties.orion4d_layer_manager_state = { document, config };
    node.__orionLayerRevision = (node.__orionLayerRevision || 0) + 1;
    markGraphChanged(node);
    return { document, config };
}

function getLink(node, input) {
    if (!input || input.link == null) return null;
    const links = app.graph?.links;
    return links?.get?.(input.link) ?? links?.[input.link] ?? null;
}

function getInputSource(node, layerIndex) {
    const input = node.inputs?.find(item => item.name === `L${layerIndex}_image`);
    const link = getLink(node, input);
    if (!link) return null;
    const origin = app.graph?.getNodeById?.(link.origin_id);
    if (!origin) return null;

    const slot = Number(link.origin_slot || 0);
    const preview = origin.imgs?.[slot] || origin.imgs?.[Number(origin.imageIndex || 0)] || origin.imgs?.[0];
    if (preview?.currentSrc || preview?.src) return preview.currentSrc || preview.src;

    const imageWidget = origin.widgets?.find(widget => widget.name === "image");
    const value = imageWidget?.value;
    const filename = typeof value === "object" ? (value.filename || value.image || value.name) : value;
    if (!filename) return null;
    const type = value?.type || "input";
    const subfolder = value?.subfolder || "";
    return `/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}`;
}

function viewUrlFromCacheItem(item) {
    if (!item?.filename) return null;
    const params = new URLSearchParams({
        filename: item.filename,
        type: item.type || "temp",
        subfolder: item.subfolder || "",
    });
    params.set("_orion_layer_cache", String(Date.now()));
    return `/view?${params.toString()}`;
}

function collectLayerMetadata(node) {
    const config = normalizeConfig(parseConfig(node), connectedImageIndices(node));
    const connected = connectedImageIndices(node);
    return connected.map(index => {
        const maskInput = node.inputs?.find(item => item.name === `L${index}_mask`);
        const hasMask = maskInput?.link != null;
        const rawSrc = getInputSource(node, index);
        const cacheSrc = node.__orionLayerBackendCache?.get(index) || null;
        const imageSrc = (hasMask && cacheSrc) ? cacheSrc : (rawSrc || cacheSrc);
        return {
            index,
            name: config.layers?.[index]?.name || `Layer ${index}`,
            hasMask,
            maskReady: Boolean(cacheSrc),
            rawSrc,
            cacheSrc,
            imageSrc,
        };
    });
}

function syncLayerPorts(node) {
    const connected = connectedLayerIndices(node);
    const maxConnected = connected.length ? Math.max(...connected) : 0;
    const desired = Math.min(MAX_LAYERS, Math.max(1, maxConnected + 1));

    for (let index = 1; index <= desired; index++) {
        if (!node.inputs?.some(input => input.name === `L${index}_image`)) node.addInput(`L${index}_image`, "IMAGE");
        if (!node.inputs?.some(input => input.name === `L${index}_mask`)) node.addInput(`L${index}_mask`, "MASK");
    }

    for (let inputIndex = (node.inputs?.length || 0) - 1; inputIndex >= 0; inputIndex--) {
        const input = node.inputs[inputIndex];
        const match = String(input?.name || "").match(/^L(\d+)_(?:image|mask)$/);
        if (!match) continue;
        const layerIndex = Number(match[1]);
        if (layerIndex > desired && input.link == null) node.removeInput(inputIndex);
    }
    node.__orionLayerRevision = (node.__orionLayerRevision || 0) + 1;
    markGraphChanged(node);
}

function applyBackendCache(node, message) {
    const cache = message?.orion_layer_cache || message?.ui?.orion_layer_cache || message?.output?.orion_layer_cache || [];
    if (!Array.isArray(cache)) return;
    node.__orionLayerBackendCache = node.__orionLayerBackendCache || new Map();
    for (const item of cache) {
        const index = Number(item?.layer);
        const src = viewUrlFromCacheItem(item);
        if (Number.isInteger(index) && index >= 1 && index <= MAX_LAYERS && src) node.__orionLayerBackendCache.set(index, src);
    }
    node.__orionLayerRevision = (node.__orionLayerRevision || 0) + 1;
}

function installBridge() {
    if (window.__orion4dLayerManagerBridge) return;
    window.__orion4dLayerManagerBridge = {
        getState(nodeId) {
            const node = window.__orion4dLayerManagerNodes.get(Number(nodeId));
            if (!node) return null;
            const state = readState(node);
            return {
                nodeId: Number(node.id),
                title: node.title || "Layer Manager",
                revision: Number(node.__orionLayerRevision || 0),
                document: state.document,
                config: state.config,
                layers: collectLayerMetadata(node),
            };
        },
        applyState(nodeId, payload) {
            const node = window.__orion4dLayerManagerNodes.get(Number(nodeId));
            return node ? writeState(node, payload || {}) : null;
        },
        resetState(nodeId) {
            const node = window.__orion4dLayerManagerNodes.get(Number(nodeId));
            if (!node) return null;
            const indices = connectedImageIndices(node);
            return writeState(node, { document: DEFAULT_DOCUMENT, config: normalizeConfig({}, indices) });
        },
        refreshLayers(nodeId) {
            const node = window.__orion4dLayerManagerNodes.get(Number(nodeId));
            if (!node) return null;
            syncLayerPorts(node);
            return this.getState(nodeId);
        },
    };
}

function setupNode(node) {
    if (node.__orion4dLayerManagerAppInstalled) return;
    node.__orion4dLayerManagerAppInstalled = true;
    node.__orionLayerBackendCache = node.__orionLayerBackendCache || new Map();
    node.__orionLayerRevision = node.__orionLayerRevision || 0;
    installBridge();
    window.__orion4dLayerManagerNodes.set(Number(node.id), node);

    for (const name of TECHNICAL_WIDGETS) setWidgetHidden(widgetByName(node, name), true);
    syncLayerPorts(node);

    const saved = node.properties?.orion4d_layer_manager_state;
    if (saved) writeState(node, saved);
    else node.properties = { ...(node.properties || {}), orion4d_layer_manager_state: readState(node) };

    const openButton = node.addWidget("button", "Open App", null, () => {
        window.__orion4dLayerManagerNodes.set(Number(node.id), node);
        const appUrl = new URL("./layer_manager_app.html", import.meta.url);
        appUrl.searchParams.set("nodeId", String(node.id));
        const popup = window.open(
            appUrl.href,
            `orion4d_layer_manager_${node.id}`,
            "popup=yes,width=1720,height=980,resizable=yes,scrollbars=no"
        );
        popup?.focus?.();
    });
    openButton.serialize = false;

    node.size = [Math.max(270, node.size?.[0] || 270), Math.max(150, node.computeSize?.()[1] || 150)];
    node.setSize?.(node.size);
}

app.registerExtension({
    name: "Orion4D.LayerManager.AppBridge.V1",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_CLASS) return;
        if (nodeType.prototype.__orion4dLayerManagerPatched) return;
        nodeType.prototype.__orion4dLayerManagerPatched = true;

        const originalCreated = nodeType.prototype.onNodeCreated;
        const originalConfigure = nodeType.prototype.onConfigure;
        const originalConnections = nodeType.prototype.onConnectionsChange;
        const originalExecuted = nodeType.prototype.onExecuted;
        const originalRemoved = nodeType.prototype.onRemoved;

        nodeType.prototype.onNodeCreated = function () {
            originalCreated?.apply(this, arguments);
            requestAnimationFrame(() => setupNode(this));
        };

        nodeType.prototype.onConfigure = function () {
            originalConfigure?.apply(this, arguments);
            requestAnimationFrame(() => {
                setupNode(this);
                for (const name of TECHNICAL_WIDGETS) setWidgetHidden(widgetByName(this, name), true);
                syncLayerPorts(this);
            });
        };

        nodeType.prototype.onConnectionsChange = function () {
            const result = originalConnections?.apply(this, arguments);
            window.setTimeout(() => syncLayerPorts(this), 0);
            return result;
        };

        nodeType.prototype.onExecuted = function (message) {
            const result = originalExecuted?.apply(this, arguments);
            applyBackendCache(this, message);
            markGraphChanged(this);
            return result;
        };

        nodeType.prototype.onRemoved = function () {
            window.__orion4dLayerManagerNodes?.delete?.(Number(this.id));
            originalRemoved?.apply(this, arguments);
        };
    },
});
