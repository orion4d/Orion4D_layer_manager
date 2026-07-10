import { app } from "/scripts/app.js";

const NODE_CLASS = "Orion4D_DropShadow";
const TECHNICAL_WIDGETS = [
    "canvas_width", "canvas_height", "scale_percent", "shadow_mode",
    "shadow_spread", "shadow_blur", "shadow_offset_x", "shadow_offset_y",
    "shadow_opacity", "shadow_color", "background_mode", "background_color",
];

const DEFAULTS = {
    canvas_width: 1024,
    canvas_height: 1024,
    scale_percent: -15,
    shadow_mode: "outer",
    shadow_spread: 0,
    shadow_blur: 24,
    shadow_offset_x: 24,
    shadow_offset_y: 24,
    shadow_opacity: 0.55,
    shadow_color: "#000000",
    background_mode: "transparent",
    background_color: "#FFFFFF",
};

window.__orion4dDropShadowNodes = window.__orion4dDropShadowNodes || new Map();

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

function normalizeHex(value, fallback) {
    let text = String(value || "").trim();
    if (!text.startsWith("#")) text = `#${text}`;
    if (/^#[0-9a-f]{3}$/i.test(text)) {
        text = `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
    }
    return /^#[0-9a-f]{6}$/i.test(text) ? text.toUpperCase() : fallback;
}

function readSettings(node) {
    const settings = { ...DEFAULTS };
    for (const name of TECHNICAL_WIDGETS) {
        const widget = widgetByName(node, name);
        if (widget) settings[name] = widget.value;
    }
    settings.shadow_color = normalizeHex(settings.shadow_color, DEFAULTS.shadow_color);
    settings.background_color = normalizeHex(settings.background_color, DEFAULTS.background_color);
    return settings;
}

function writeSettings(node, incoming = {}) {
    const settings = { ...DEFAULTS, ...incoming };
    settings.canvas_width = Math.max(1, Math.round(Number(settings.canvas_width) || DEFAULTS.canvas_width));
    settings.canvas_height = Math.max(1, Math.round(Number(settings.canvas_height) || DEFAULTS.canvas_height));
    settings.scale_percent = Math.max(-99, Math.min(500, Number(settings.scale_percent) || 0));
    settings.shadow_spread = Math.max(0, Math.min(256, Math.round(Number(settings.shadow_spread) || 0)));
    settings.shadow_blur = Math.max(0, Math.min(256, Number(settings.shadow_blur) || 0));
    settings.shadow_offset_x = Math.max(-4096, Math.min(4096, Math.round(Number(settings.shadow_offset_x) || 0)));
    settings.shadow_offset_y = Math.max(-4096, Math.min(4096, Math.round(Number(settings.shadow_offset_y) || 0)));
    settings.shadow_opacity = Math.max(0, Math.min(1, Number(settings.shadow_opacity) || 0));
    settings.shadow_mode = settings.shadow_mode === "inner" ? "inner" : "outer";
    settings.background_mode = settings.background_mode === "color" ? "color" : "transparent";
    settings.shadow_color = normalizeHex(settings.shadow_color, DEFAULTS.shadow_color);
    settings.background_color = normalizeHex(settings.background_color, DEFAULTS.background_color);

    for (const name of TECHNICAL_WIDGETS) {
        const widget = widgetByName(node, name);
        if (!widget) continue;
        widget.value = settings[name];
        if (widget.inputEl) {
            if (widget.inputEl.type === "checkbox") widget.inputEl.checked = Boolean(settings[name]);
            else widget.inputEl.value = settings[name];
        }
        widget.callback?.(settings[name]);
    }

    node.properties = node.properties || {};
    node.properties.orion4d_drop_shadow_settings = settings;
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
    if (window.__orion4dDropShadowBridge) return;
    window.__orion4dDropShadowBridge = {
        getState(nodeId) {
            const node = window.__orion4dDropShadowNodes.get(Number(nodeId));
            if (!node) return null;
            return {
                nodeId: Number(node.id),
                title: node.title || "Drop Shadow",
                settings: readSettings(node),
                imageSrc: getUpstreamImageSource(node),
            };
        },
        applySettings(nodeId, settings) {
            const node = window.__orion4dDropShadowNodes.get(Number(nodeId));
            if (!node) return null;
            return writeSettings(node, settings);
        },
        resetSettings(nodeId) {
            const node = window.__orion4dDropShadowNodes.get(Number(nodeId));
            if (!node) return null;
            return writeSettings(node, DEFAULTS);
        },
        refreshImage(nodeId) {
            const node = window.__orion4dDropShadowNodes.get(Number(nodeId));
            return node ? getUpstreamImageSource(node) : null;
        },
    };
}

function setupNode(node) {
    if (node.__orion4dDropShadowAppInstalled) return;
    node.__orion4dDropShadowAppInstalled = true;
    installBridge();
    window.__orion4dDropShadowNodes.set(Number(node.id), node);

    for (const name of TECHNICAL_WIDGETS) setWidgetHidden(widgetByName(node, name), true);

    const saved = node.properties?.orion4d_drop_shadow_settings;
    if (saved) writeSettings(node, saved);
    else node.properties = { ...(node.properties || {}), orion4d_drop_shadow_settings: readSettings(node) };

    const openButton = node.addWidget("button", "Open App", null, () => {
        window.__orion4dDropShadowNodes.set(Number(node.id), node);
        const appUrl = new URL("./drop_shadow_app.html", import.meta.url);
        appUrl.searchParams.set("nodeId", String(node.id));
        const popup = window.open(
            appUrl.href,
            `orion4d_drop_shadow_${node.id}`,
            "popup=yes,width=1460,height=930,resizable=yes,scrollbars=no"
        );
        popup?.focus?.();
    });
    openButton.serialize = false;

    node.size = [Math.max(240, node.size?.[0] || 240), 120];
    node.setSize?.(node.size);
}

app.registerExtension({
    name: "Orion4D.DropShadow.AppBridge.V1",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_CLASS) return;
        if (nodeType.prototype.__orion4dDropShadowPatched) return;
        nodeType.prototype.__orion4dDropShadowPatched = true;

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
                const saved = this.properties?.orion4d_drop_shadow_settings;
                if (saved) writeSettings(this, saved);
            });
        };

        nodeType.prototype.onRemoved = function () {
            window.__orion4dDropShadowNodes?.delete?.(Number(this.id));
            originalRemoved?.apply(this, arguments);
        };
    },
});
