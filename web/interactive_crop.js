import { app } from "/scripts/app.js";

const NODE_CLASS = "InteractiveCropNode";
const TECHNICAL_WIDGETS = ["scale_multiplier", "x", "y", "width", "height", "aspect_ratio"];

const DEFAULTS = {
    scale_multiplier: 1.0,
    x: 0,
    y: 0,
    width: 512,
    height: 512,
    aspect_ratio: "Free",
};

window.__orion4dInteractiveCropNodes = window.__orion4dInteractiveCropNodes || new Map();

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

function clamp(value, min, max, fallback = min) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
}

function readSettings(node) {
    const settings = { ...DEFAULTS };
    for (const name of TECHNICAL_WIDGETS) {
        const widget = widgetByName(node, name);
        if (widget) settings[name] = widget.value;
    }
    return settings;
}

function writeSettings(node, incoming = {}) {
    const settings = { ...DEFAULTS, ...incoming };
    settings.scale_multiplier = clamp(settings.scale_multiplier, 0.1, 10, DEFAULTS.scale_multiplier);
    settings.x = Math.round(clamp(settings.x, 0, 16384, DEFAULTS.x));
    settings.y = Math.round(clamp(settings.y, 0, 16384, DEFAULTS.y));
    settings.width = Math.round(clamp(settings.width, 1, 16384, DEFAULTS.width));
    settings.height = Math.round(clamp(settings.height, 1, 16384, DEFAULTS.height));
    settings.aspect_ratio = String(settings.aspect_ratio || DEFAULTS.aspect_ratio);

    for (const name of TECHNICAL_WIDGETS) {
        const widget = widgetByName(node, name);
        if (!widget) continue;
        widget.value = settings[name];
        if (widget.inputEl) widget.inputEl.value = settings[name];
        widget.callback?.(settings[name]);
    }

    node.properties = node.properties || {};
    node.properties.orion4d_interactive_crop_settings = settings;
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
    app.graph?.change?.();
    return settings;
}

function getUpstreamImageSource(node) {
    const input = node.inputs?.find(item => item.name === "image") || node.inputs?.[0];
    if (!input || input.link == null) return null;
    const links = app.graph?.links;
    const link = links?.get?.(input.link) ?? links?.[input.link];
    if (!link) return null;
    const originNode = app.graph?.getNodeById?.(link.origin_id);
    if (!originNode) return null;

    const preview = originNode.imgs?.[0];
    if (preview?.currentSrc || preview?.src) return preview.currentSrc || preview.src;

    const imageWidget = originNode.widgets?.find(widget => widget.name === "image");
    const value = imageWidget?.value;
    const filename = typeof value === "object" ? (value.filename || value.image || value.name) : value;
    if (!filename) return null;
    const type = value?.type || "input";
    const subfolder = value?.subfolder || "";
    return `/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}`;
}

function installBridge() {
    if (window.__orion4dInteractiveCropBridge) return;
    window.__orion4dInteractiveCropBridge = {
        getState(nodeId) {
            const node = window.__orion4dInteractiveCropNodes.get(Number(nodeId));
            if (!node) return null;
            return {
                nodeId: Number(node.id),
                title: node.title || "Interactive Crop",
                settings: readSettings(node),
                imageSrc: getUpstreamImageSource(node),
            };
        },
        applySettings(nodeId, settings) {
            const node = window.__orion4dInteractiveCropNodes.get(Number(nodeId));
            return node ? writeSettings(node, settings) : null;
        },
        resetSettings(nodeId) {
            const node = window.__orion4dInteractiveCropNodes.get(Number(nodeId));
            return node ? writeSettings(node, DEFAULTS) : null;
        },
        refreshImage(nodeId) {
            const node = window.__orion4dInteractiveCropNodes.get(Number(nodeId));
            return node ? getUpstreamImageSource(node) : null;
        },
    };
}

function setupNode(node) {
    if (node.__orion4dInteractiveCropAppInstalled) return;
    node.__orion4dInteractiveCropAppInstalled = true;
    installBridge();
    window.__orion4dInteractiveCropNodes.set(Number(node.id), node);

    for (const name of TECHNICAL_WIDGETS) setWidgetHidden(widgetByName(node, name), true);

    const saved = node.properties?.orion4d_interactive_crop_settings;
    if (saved) writeSettings(node, saved);
    else node.properties = { ...(node.properties || {}), orion4d_interactive_crop_settings: readSettings(node) };

    const openButton = node.addWidget("button", "Open App", null, () => {
        window.__orion4dInteractiveCropNodes.set(Number(node.id), node);
        const appUrl = new URL("./interactive_crop_app.html", import.meta.url);
        appUrl.searchParams.set("nodeId", String(node.id));
        const popup = window.open(
            appUrl.href,
            `orion4d_interactive_crop_${node.id}`,
            "popup=yes,width=1460,height=930,resizable=yes,scrollbars=no"
        );
        popup?.focus?.();
    });
    openButton.serialize = false;

    node.size = [Math.max(240, node.size?.[0] || 240), 120];
    node.setSize?.(node.size);
}

app.registerExtension({
    name: "Orion4D.InteractiveCrop.AppBridge.V1",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_CLASS) return;
        if (nodeType.prototype.__orion4dInteractiveCropPatched) return;
        nodeType.prototype.__orion4dInteractiveCropPatched = true;

        const originalCreated = nodeType.prototype.onNodeCreated;
        const originalConfigure = nodeType.prototype.onConfigure;
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
                const saved = this.properties?.orion4d_interactive_crop_settings;
                if (saved) writeSettings(this, saved);
            });
        };

        nodeType.prototype.onRemoved = function () {
            window.__orion4dInteractiveCropNodes?.delete?.(Number(this.id));
            originalRemoved?.apply(this, arguments);
        };
    },
});
