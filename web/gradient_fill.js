import { app } from "/scripts/app.js";

const NODE_CLASS = "Orion4D_GradientFillV2";
const TECHNICAL_WIDGETS = [
    "width", "height", "fill_mode", "color_count",
    "color_1", "color_2", "color_3", "color_4",
    "invert", "angle", "center_x", "center_y",
    "inner_border_px", "border_color", "border_opacity",
];

const DEFAULTS = {
    width: 1024,
    height: 1024,
    fill_mode: "solid",
    color_count: "1",
    color_1: "#FFFFFF",
    color_2: "#FFFFFF",
    color_3: "#FFFFFF",
    color_4: "#FFFFFF",
    invert: false,
    angle: 0,
    center_x: 0.5,
    center_y: 0.5,
    inner_border_px: 0,
    border_color: "#FFFFFF",
    border_opacity: 1,
};

window.__orion4dGradientNodes = window.__orion4dGradientNodes || new Map();

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

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value)));
}

function readSettings(node) {
    const settings = { ...DEFAULTS };
    for (const name of TECHNICAL_WIDGETS) {
        const widget = widgetByName(node, name);
        if (widget) settings[name] = widget.value;
    }
    for (let index = 1; index <= 4; index++) {
        const key = `color_${index}`;
        settings[key] = normalizeHex(settings[key], DEFAULTS[key]);
    }
    settings.border_color = normalizeHex(settings.border_color, DEFAULTS.border_color);
    return settings;
}

function writeSettings(node, incoming = {}) {
    const settings = { ...DEFAULTS, ...incoming };
    settings.width = Math.max(1, Math.min(8192, Math.round(Number(settings.width) || DEFAULTS.width)));
    settings.height = Math.max(1, Math.min(8192, Math.round(Number(settings.height) || DEFAULTS.height)));
    settings.fill_mode = ["solid", "linear", "radial", "angular", "reflected", "diamond"].includes(settings.fill_mode) ? settings.fill_mode : "solid";
    settings.color_count = String(Math.max(1, Math.min(4, Math.round(Number(settings.color_count) || 1))));
    for (let index = 1; index <= 4; index++) {
        const key = `color_${index}`;
        settings[key] = normalizeHex(settings[key], DEFAULTS[key]);
    }
    settings.invert = Boolean(settings.invert);
    settings.angle = ((Number(settings.angle) || 0) % 360 + 360) % 360;
    settings.center_x = clamp(Number(settings.center_x) || 0, 0, 1);
    settings.center_y = clamp(Number(settings.center_y) || 0, 0, 1);
    settings.inner_border_px = Math.max(0, Math.min(200, Math.round(Number(settings.inner_border_px) || 0)));
    settings.border_color = normalizeHex(settings.border_color, DEFAULTS.border_color);
    settings.border_opacity = clamp(Number(settings.border_opacity) || 0, 0, 1);

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
    node.properties.orion4d_gradient_settings = settings;
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
    app.graph?.change?.();
    return settings;
}

function installBridge() {
    if (window.__orion4dGradientBridge) return;
    window.__orion4dGradientBridge = {
        getState(nodeId) {
            const node = window.__orion4dGradientNodes.get(Number(nodeId));
            if (!node) return null;
            return {
                nodeId: Number(node.id),
                title: node.title || "Fill / Gradient Generator",
                settings: readSettings(node),
            };
        },
        applySettings(nodeId, settings) {
            const node = window.__orion4dGradientNodes.get(Number(nodeId));
            return node ? writeSettings(node, settings) : null;
        },
        resetSettings(nodeId) {
            const node = window.__orion4dGradientNodes.get(Number(nodeId));
            return node ? writeSettings(node, DEFAULTS) : null;
        },
    };
}

function setupNode(node) {
    if (node.__orion4dGradientAppInstalled) return;
    node.__orion4dGradientAppInstalled = true;
    installBridge();
    window.__orion4dGradientNodes.set(Number(node.id), node);

    for (const name of TECHNICAL_WIDGETS) setWidgetHidden(widgetByName(node, name), true);

    const saved = node.properties?.orion4d_gradient_settings;
    if (saved) writeSettings(node, saved);
    else node.properties = { ...(node.properties || {}), orion4d_gradient_settings: readSettings(node) };

    const openButton = node.addWidget("button", "Open App", null, () => {
        window.__orion4dGradientNodes.set(Number(node.id), node);
        const appUrl = new URL("./gradient_fill_app.html", import.meta.url);
        appUrl.searchParams.set("nodeId", String(node.id));
        const popup = window.open(
            appUrl.href,
            `orion4d_gradient_${node.id}`,
            "popup=yes,width=1460,height=930,resizable=yes,scrollbars=no"
        );
        popup?.focus?.();
    });
    openButton.serialize = false;

    node.size = [Math.max(250, node.size?.[0] || 250), 105];
    node.setSize?.(node.size);
}

app.registerExtension({
    name: "Orion4D.GradientFill.AppBridge.V1",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_CLASS) return;
        if (nodeType.prototype.__orion4dGradientPatched) return;
        nodeType.prototype.__orion4dGradientPatched = true;

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
                const saved = this.properties?.orion4d_gradient_settings;
                if (saved) writeSettings(this, saved);
            });
        };

        nodeType.prototype.onRemoved = function () {
            window.__orion4dGradientNodes?.delete?.(Number(this.id));
            originalRemoved?.apply(this, arguments);
        };
    },
});
