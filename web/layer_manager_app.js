const MAX_LAYERS = 20;
const DEFAULT_DOCUMENT = {
    canvas_width: 1024,
    canvas_height: 1024,
    bg_hex: "#FFFFFF",
    flatten_output: true,
    invert_input_masks: false,
};
const ANCHORS = ["top_left", "top_right", "bottom_left", "bottom_right", "center"];
const BLENDS = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "add", "subtract", "difference", "soft_light", "hard_light"];
const HANDLE_RADIUS = 7;
const HANDLE_HIT = 13;
const ROTATE_OFFSET = 34;
const HISTORY_LIMIT = 36;
const MIN_VIEW_ZOOM = 0.25;
const MAX_VIEW_ZOOM = 8;

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

const nodeId = Number(new URLSearchParams(location.search).get("nodeId"));
const bridge = window.opener?.__orion4dLayerManagerBridge;
const canvas = document.querySelector("#previewCanvas");
const ctx = canvas.getContext("2d");
const stage = document.querySelector("#previewStage");
const statusEl = document.querySelector("#status");
const canvasInfo = document.querySelector("#canvasInfo");
const emptyMessage = document.querySelector("#emptyMessage");
const layersList = document.querySelector("#layersList");
const layersEmpty = document.querySelector("#layersEmpty");
const layerCount = document.querySelector("#layerCount");
const layerProperties = document.querySelector("#layerProperties");
const selectedIndex = document.querySelector("#selectedIndex");
const alignmentSection = document.querySelector("#alignmentSection");
const undoButton = document.querySelector("#undoAction");
const redoButton = document.querySelector("#redoAction");
const zoomValue = document.querySelector("#zoomReset");
const handButton = document.querySelector("#handTool");
const lockButton = document.querySelector("#toggleLayerLock");
const muteButton = document.querySelector("#toggleLayerMute");
const soloButton = document.querySelector("#toggleLayerSolo");
const resetLayerButton = document.querySelector("#resetLayer");

const fields = {
    canvas_width: document.querySelector("#canvas_width"),
    canvas_height: document.querySelector("#canvas_height"),
    bg_color: document.querySelector("#bg_color"),
    bg_hex: document.querySelector("#bg_hex"),
    flatten_output: document.querySelector("#flatten_output"),
    invert_input_masks: document.querySelector("#invert_input_masks"),
    layer_name: document.querySelector("#layer_name"),
    layer_x: document.querySelector("#layer_x"),
    layer_y: document.querySelector("#layer_y"),
    layer_scale: document.querySelector("#layer_scale"),
    constrain_scale: document.querySelector("#constrain_scale"),
    scale_x: document.querySelector("#scale_x"),
    scale_y: document.querySelector("#scale_y"),
    layer_rotation: document.querySelector("#layer_rotation"),
    layer_opacity: document.querySelector("#layer_opacity"),
    layer_anchor: document.querySelector("#layer_anchor"),
    layer_blend: document.querySelector("#layer_blend"),
    layer_visible: document.querySelector("#layer_visible"),
};
const scaleOutput = document.querySelector("#scaleOutput");
const rotationOutput = document.querySelector("#rotationOutput");
const opacityOutput = document.querySelector("#opacityOutput");

let documentSettings = { ...DEFAULT_DOCUMENT };
let config = normalizeConfig({});
let metadata = [];
let activeLayer = null;
let dirty = false;
let lastRevision = -1;
let pollTimer = null;
let rafId = 0;
let viewportWidth = 1;
let viewportHeight = 1;
let documentRect = { x: 0, y: 0, w: 1, h: 1, scale: 1 };
let interaction = null;
let viewZoom = 1;
let viewOffset = { x: 0, y: 0 };
let handToolActive = false;
let spacePanActive = false;
let history = [];
let historyIndex = -1;
let historyTimer = null;
let historyReady = false;
let restoringHistory = false;
const imageEntries = new Map();

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, number(value, min))); }
function round3(value) { return Math.round(number(value) * 1000) / 1000; }
function normalizeHex(value, fallback = "#FFFFFF") {
    let text = String(value || "").trim();
    if (!text.startsWith("#")) text = `#${text}`;
    if (/^#[0-9a-f]{3}$/i.test(text)) text = `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
    if (!/^#[0-9a-f]{6}$/i.test(text)) return fallback;
    return text.toUpperCase();
}
function normalizeSourceUrl(value) {
    if (!value) return "";
    try {
        const url = new URL(value, location.origin);
        for (const key of [...url.searchParams.keys()]) {
            if (key === "t" || key.startsWith("_orion")) url.searchParams.delete(key);
        }
        return url.href;
    } catch { return String(value); }
}
function withCacheBust(value) {
    if (!value) return "";
    const url = new URL(value, location.origin);
    url.searchParams.set("t", String(Date.now()));
    return url.href;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function normalizeLayer(layer, index) {
    const next = { ...defaultLayer(index), ...(layer || {}) };
    next.name = String(next.name || `Layer ${index}`);
    next.x = clamp(next.x, -8192, 8192);
    next.y = clamp(next.y, -8192, 8192);
    next.scale = clamp(next.scale, 1, 2000);
    next.scale_x = clamp(next.scale_x ?? next.scale, 1, 2000);
    next.scale_y = clamp(next.scale_y ?? next.scale, 1, 2000);
    next.constrain_homothety = Boolean(next.constrain_homothety);
    if (next.constrain_homothety) next.scale_x = next.scale_y = next.scale;
    next.rot = clamp(next.rot, -180, 180);
    next.opacity = clamp(next.opacity, 0, 1);
    next.visible = Boolean(next.visible);
    next.locked = Boolean(next.locked);
    next.anchor = ANCHORS.includes(next.anchor) ? next.anchor : "top_left";
    next.blend = BLENDS.includes(next.blend) ? next.blend : "normal";
    return next;
}

function normalizeConfig(raw, connected = []) {
    const input = raw && typeof raw === "object" ? raw : {};
    const maxIndex = Math.min(MAX_LAYERS, Math.max(1, number(input.layer_count, 1), ...connected));
    const layers = Array.isArray(input.layers) ? input.layers.map(item => item ? { ...item } : null) : [null];
    if (!layers.length) layers.push(null);
    layers[0] = null;
    while (layers.length <= maxIndex) layers.push(null);
    for (let index = 1; index < layers.length; index++) layers[index] = normalizeLayer(layers[index], index);
    for (const index of connected) {
        while (layers.length <= index) layers.push(null);
        layers[index] = normalizeLayer(layers[index], index);
    }
    const order = [];
    if (Array.isArray(input.order)) {
        for (const item of input.order) {
            const index = Number(item);
            if (Number.isInteger(index) && index >= 1 && index <= MAX_LAYERS && !order.includes(index)) order.push(index);
        }
    }
    for (let index = 1; index < layers.length; index++) if (!order.includes(index)) order.push(index);
    for (const index of connected) if (!order.includes(index)) order.push(index);
    const rawSolo = Number(input.solo_layer);
    const solo_layer = Number.isInteger(rawSolo) && rawSolo >= 1 && rawSolo <= MAX_LAYERS ? rawSolo : null;
    return { version: 31, layer_count: maxIndex, order, solo_layer, layers };
}

function connectedIndices() { return metadata.map(item => item.index).sort((a, b) => a - b); }
function ensureConnectedConfig() {
    config = normalizeConfig(config, connectedIndices());
    if (activeLayer == null || !connectedIndices().includes(activeLayer)) activeLayer = connectedIndices()[0] ?? null;
}
function active() { return activeLayer == null ? null : config.layers?.[activeLayer] || null; }
function metaFor(index) { return metadata.find(item => item.index === index) || null; }
function imageFor(index) { return imageEntries.get(index)?.image || null; }
function isSoloActive(index) { return Number(config.solo_layer) === Number(index); }
function isEffectivelyVisible(index) {
    const layer = config.layers?.[index];
    if (!layer?.visible) return false;
    return config.solo_layer == null || Number(config.solo_layer) === Number(index);
}

function captureHistoryState() {
    return {
        document: clone(documentSettings),
        config: clone(config),
        activeLayer,
    };
}
function historyKey(state) { return JSON.stringify(state); }
function updateHistoryButtons() {
    if (undoButton) undoButton.disabled = historyIndex <= 0;
    if (redoButton) redoButton.disabled = historyIndex < 0 || historyIndex >= history.length - 1;
}
function resetHistory() {
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = null;
    history = [captureHistoryState()];
    historyIndex = 0;
    historyReady = true;
    updateHistoryButtons();
}
function commitHistory() {
    if (!historyReady || restoringHistory) return;
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = null;
    const next = captureHistoryState();
    const current = history[historyIndex];
    if (current && historyKey(current) === historyKey(next)) return;
    history = history.slice(0, historyIndex + 1);
    history.push(next);
    if (history.length > HISTORY_LIMIT + 1) history.shift();
    historyIndex = history.length - 1;
    updateHistoryButtons();
}
function queueHistoryCommit() {
    if (!historyReady || restoringHistory) return;
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = window.setTimeout(commitHistory, 180);
}
function restoreHistoryState(state, label) {
    if (!state) return;
    restoringHistory = true;
    documentSettings = { ...DEFAULT_DOCUMENT, ...(clone(state.document) || {}) };
    config = normalizeConfig(clone(state.config) || {}, connectedIndices());
    activeLayer = connectedIndices().includes(Number(state.activeLayer)) ? Number(state.activeLayer) : (connectedIndices()[0] ?? null);
    dirty = true;
    writeDocumentForm();
    ensureConnectedConfig();
    renderLayerList();
    syncActiveControls();
    scheduleDraw();
    statusEl.textContent = label;
    restoringHistory = false;
    updateHistoryButtons();
}
function undo() {
    if (!historyReady) return;
    if (historyTimer) commitHistory();
    if (historyIndex <= 0) return;
    historyIndex -= 1;
    restoreHistoryState(history[historyIndex], `Undo · ${historyIndex}/${Math.max(0, history.length - 1)}`);
}
function redo() {
    if (!historyReady) return;
    if (historyTimer) commitHistory();
    if (historyIndex >= history.length - 1) return;
    historyIndex += 1;
    restoreHistoryState(history[historyIndex], `Redo · ${historyIndex}/${Math.max(0, history.length - 1)}`);
}

function writeDocumentForm() {
    fields.canvas_width.value = documentSettings.canvas_width;
    fields.canvas_height.value = documentSettings.canvas_height;
    fields.bg_hex.value = normalizeHex(documentSettings.bg_hex);
    fields.bg_color.value = normalizeHex(documentSettings.bg_hex);
    fields.flatten_output.checked = Boolean(documentSettings.flatten_output);
    fields.invert_input_masks.checked = Boolean(documentSettings.invert_input_masks);
    canvasInfo.textContent = `${documentSettings.canvas_width} × ${documentSettings.canvas_height}`;
}
function readDocumentForm() {
    documentSettings.canvas_width = Math.round(clamp(fields.canvas_width.value, 16, 8192));
    documentSettings.canvas_height = Math.round(clamp(fields.canvas_height.value, 16, 8192));
    documentSettings.bg_hex = normalizeHex(fields.bg_hex.value, "#FFFFFF");
    documentSettings.flatten_output = fields.flatten_output.checked;
    documentSettings.invert_input_masks = fields.invert_input_masks.checked;
    writeDocumentForm();
}

function syncActiveControls() {
    const layer = active();
    const disabled = !layer;
    const locked = Boolean(layer?.locked);
    layerProperties.classList.toggle("disabled", disabled);
    layerProperties.classList.toggle("layer-locked", !disabled && locked);
    alignmentSection?.classList.toggle("disabled-section", disabled || locked);
    selectedIndex.textContent = layer ? `L${activeLayer}` : "—";

    for (const element of Object.values(fields)) {
        if (!element || !element.closest("#layerProperties")) continue;
        const allowedWhenLocked = element === fields.layer_visible;
        element.disabled = disabled || (locked && !allowedWhenLocked);
    }
    for (const button of [lockButton, muteButton, soloButton, resetLayerButton]) if (button) button.disabled = disabled;
    if (resetLayerButton) resetLayerButton.disabled = disabled || locked;
    document.querySelector("#fitLayer").disabled = disabled || locked;
    document.querySelector("#centerLayer").disabled = disabled || locked;
    document.querySelectorAll("[data-align]").forEach(button => button.disabled = disabled || locked);

    if (!layer) {
        lockButton?.classList.remove("active-state");
        muteButton?.classList.remove("active-state");
        soloButton?.classList.remove("active-state");
        return;
    }
    fields.layer_name.value = layer.name;
    fields.layer_x.value = round3(layer.x);
    fields.layer_y.value = round3(layer.y);
    fields.layer_scale.value = layer.scale;
    fields.constrain_scale.checked = layer.constrain_homothety;
    fields.scale_x.value = layer.scale_x;
    fields.scale_y.value = layer.scale_y;
    fields.scale_x.disabled = locked || layer.constrain_homothety;
    fields.scale_y.disabled = locked || layer.constrain_homothety;
    fields.layer_rotation.value = layer.rot;
    fields.layer_opacity.value = layer.opacity;
    fields.layer_anchor.value = layer.anchor;
    fields.layer_blend.value = layer.blend;
    fields.layer_visible.checked = layer.visible;
    scaleOutput.textContent = `${number(layer.scale, 100).toFixed(1)}%`;
    rotationOutput.textContent = `${number(layer.rot, 0).toFixed(1)}°`;
    opacityOutput.textContent = `${Math.round(number(layer.opacity, 1) * 100)}%`;

    lockButton.classList.toggle("active-state", locked);
    lockButton.innerHTML = locked ? "🔒 <span>Locked</span>" : "🔓 <span>Lock</span>";
    muteButton.classList.toggle("active-state", !layer.visible);
    muteButton.innerHTML = `<strong>M</strong> <span>${layer.visible ? "Mute" : "Muted"}</span>`;
    soloButton.classList.toggle("active-state", isSoloActive(activeLayer));
    soloButton.innerHTML = `<strong>S</strong> <span>${isSoloActive(activeLayer) ? "Soloed" : "Solo"}</span>`;
}
function markDirty(message = "Changes not applied") {
    dirty = true;
    statusEl.textContent = message;
    scheduleDraw();
    queueHistoryCommit();
}

function syncLayerSources(nextMetadata, force = false) {
    metadata = Array.isArray(nextMetadata) ? nextMetadata.map(item => ({ ...item })) : [];
    const live = new Set(metadata.map(item => item.index));
    for (const index of [...imageEntries.keys()]) if (!live.has(index)) imageEntries.delete(index);

    for (const item of metadata) {
        const source = item.imageSrc || item.rawSrc || item.cacheSrc;
        const clean = normalizeSourceUrl(source);
        const previous = imageEntries.get(item.index);
        if (!source) {
            imageEntries.set(item.index, { source: "", clean: "", image: null, loading: false });
            continue;
        }
        if (!force && previous?.clean === clean && previous.image) continue;
        const entry = { source, clean, image: previous?.image || null, loading: true };
        imageEntries.set(item.index, entry);
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => {
            const current = imageEntries.get(item.index);
            if (!current || current.clean !== clean) return;
            current.image = image;
            current.loading = false;
            scheduleDraw();
            renderLayerList();
        };
        image.onerror = () => {
            const current = imageEntries.get(item.index);
            if (current?.clean === clean) current.loading = false;
            scheduleDraw();
        };
        image.src = withCacheBust(source);
    }
    ensureConnectedConfig();
    renderLayerList();
    syncActiveControls();
    scheduleDraw();
}

function orderedConnectedBottomToTop() {
    const connected = new Set(connectedIndices());
    return config.order.filter(index => connected.has(index));
}

function moveOrder(index, direction) {
    const order = orderedConnectedBottomToTop();
    const position = order.indexOf(index);
    if (position < 0) return;
    const target = direction === "up" ? position + 1 : position - 1;
    if (target < 0 || target >= order.length) return;
    [order[position], order[target]] = [order[target], order[position]];
    const disconnected = config.order.filter(item => !order.includes(item));
    config.order = [...order, ...disconnected];
    markDirty("Layer order changed");
    renderLayerList();
}

function renderLayerList() {
    const orderTopToBottom = [...orderedConnectedBottomToTop()].reverse();
    layersList.replaceChildren();
    layerCount.textContent = String(orderTopToBottom.length);
    layersEmpty.hidden = orderTopToBottom.length > 0;
    emptyMessage.hidden = orderTopToBottom.length > 0;

    for (const index of orderTopToBottom) {
        const layer = config.layers[index];
        const meta = metaFor(index);
        const effectiveVisible = isEffectivelyVisible(index);
        const row = document.createElement("div");
        row.className = `layer-row${index === activeLayer ? " active" : ""}${layer.visible ? "" : " hidden-layer"}${config.solo_layer != null && !isSoloActive(index) ? " solo-muted" : ""}${layer.locked ? " locked-layer" : ""}`;
        row.dataset.index = String(index);

        const mute = document.createElement("button");
        mute.className = `layer-eye${layer.visible ? "" : " active-state"}`;
        mute.title = layer.visible ? "Mute layer" : "Unmute layer";
        mute.textContent = "M";
        mute.addEventListener("click", event => {
            event.stopPropagation();
            layer.visible = !layer.visible;
            markDirty(layer.visible ? "Layer unmuted" : "Layer muted");
            renderLayerList();
            syncActiveControls();
        });

        const solo = document.createElement("button");
        solo.className = `layer-solo${isSoloActive(index) ? " active-state" : ""}`;
        solo.title = isSoloActive(index) ? "Disable solo" : "Solo layer";
        solo.textContent = "S";
        solo.addEventListener("click", event => {
            event.stopPropagation();
            const enablingSolo = !isSoloActive(index);
            config.solo_layer = enablingSolo ? index : null;
            if (enablingSolo) layer.visible = true;
            markDirty(config.solo_layer == null ? "Solo disabled" : `Layer ${index} solo`);
            renderLayerList();
            syncActiveControls();
        });

        const lock = document.createElement("button");
        lock.className = `layer-lock${layer.locked ? " active-state" : ""}`;
        lock.title = layer.locked ? "Unlock layer" : "Lock layer";
        lock.textContent = layer.locked ? "🔒" : "🔓";
        lock.addEventListener("click", event => {
            event.stopPropagation();
            layer.locked = !layer.locked;
            markDirty(layer.locked ? "Layer locked" : "Layer unlocked");
            renderLayerList();
            syncActiveControls();
        });

        const thumb = document.createElement("img");
        thumb.className = "layer-thumb";
        const entry = imageEntries.get(index);
        if (entry?.source) thumb.src = entry.source;
        thumb.style.opacity = effectiveVisible ? "1" : ".55";

        const title = document.createElement("div");
        title.className = "layer-title";
        const name = document.createElement("div");
        name.className = "layer-name";
        name.textContent = layer.name || `Layer ${index}`;
        const metaLine = document.createElement("div");
        metaLine.className = "layer-meta";
        const idText = document.createElement("span");
        idText.textContent = `L${index}`;
        metaLine.appendChild(idText);
        if (meta?.hasMask) {
            const badge = document.createElement("span");
            badge.className = meta.maskReady ? "mask-badge" : "mask-pending";
            badge.textContent = meta.maskReady ? "MASK" : "MASK · RUN";
            metaLine.appendChild(badge);
        }
        title.append(name, metaLine);

        const up = document.createElement("button");
        up.className = "layer-order";
        up.title = "Move up";
        up.textContent = "▲";
        up.addEventListener("click", event => { event.stopPropagation(); moveOrder(index, "up"); });
        const down = document.createElement("button");
        down.className = "layer-order";
        down.title = "Move down";
        down.textContent = "▼";
        down.addEventListener("click", event => { event.stopPropagation(); moveOrder(index, "down"); });

        row.append(mute, solo, lock, thumb, title, up, down);
        row.addEventListener("click", () => {
            activeLayer = index;
            syncActiveControls();
            renderLayerList();
            scheduleDraw();
        });
        layersList.appendChild(row);
    }
}
function ensureCanvasSize() {
    const width = Math.max(1, Math.floor(stage.clientWidth));
    const height = Math.max(1, Math.floor(stage.clientHeight));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    if (width !== viewportWidth || height !== viewportHeight || canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        viewportWidth = width;
        viewportHeight = height;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function calculateDocumentRect() {
    const cw = Math.max(1, documentSettings.canvas_width);
    const ch = Math.max(1, documentSettings.canvas_height);
    const padding = 28;
    const fitScale = Math.max(.0001, Math.min((viewportWidth - padding * 2) / cw, (viewportHeight - padding * 2) / ch));
    const scale = fitScale * viewZoom;
    const w = cw * scale;
    const h = ch * scale;
    documentRect = { x: (viewportWidth - w) / 2 + viewOffset.x, y: (viewportHeight - h) / 2 + viewOffset.y, w, h, scale };
    return documentRect;
}
function updateZoomDisplay() { if (zoomValue) zoomValue.textContent = `${Math.round(viewZoom * 100)}%`; }
function setViewZoom(value, focal = null) {
    ensureCanvasSize();
    calculateDocumentRect();
    const focus = focal || { x: viewportWidth / 2, y: viewportHeight / 2 };
    const documentPoint = canvasToDoc(focus);
    const next = clamp(value, MIN_VIEW_ZOOM, MAX_VIEW_ZOOM);
    if (Math.abs(next - viewZoom) < 1e-6) return;
    viewZoom = next;
    calculateDocumentRect();
    const after = docToCanvas(documentPoint);
    viewOffset.x += focus.x - after.x;
    viewOffset.y += focus.y - after.y;
    updateZoomDisplay();
    scheduleDraw();
}
function resetViewZoom() {
    viewZoom = 1;
    viewOffset = { x: 0, y: 0 };
    updateZoomDisplay();
    scheduleDraw();
}
function isHandMode() { return handToolActive || spacePanActive; }
function isTextEntryTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}
function updateHandToolState() {
    if (handButton) {
        handButton.classList.toggle("active-tool", isHandMode());
        handButton.setAttribute("aria-pressed", handToolActive ? "true" : "false");
        handButton.title = handToolActive ? "Hand tool active · Hold Space for temporary use" : "Hand tool · Hold Space";
    }
    if (interaction?.mode === "pan") canvas.style.cursor = "grabbing";
    else if (isHandMode()) canvas.style.cursor = "grab";
    else canvas.style.cursor = "default";
}
function docToCanvas(point) { return { x: documentRect.x + point.x * documentRect.scale, y: documentRect.y + point.y * documentRect.scale }; }
function canvasToDoc(point) { return { x: (point.x - documentRect.x) / documentRect.scale, y: (point.y - documentRect.y) / documentRect.scale }; }
function rotateVector(x, y, degrees) {
    const radians = degrees * Math.PI / 180;
    const c = Math.cos(radians), s = Math.sin(radians);
    return { x: x * c - y * s, y: x * s + y * c };
}
function anchorPoint(layer, image) {
    switch (layer.anchor) {
        case "top_right": return { x: image.naturalWidth, y: 0 };
        case "bottom_left": return { x: 0, y: image.naturalHeight };
        case "bottom_right": return { x: image.naturalWidth, y: image.naturalHeight };
        case "center": return { x: image.naturalWidth / 2, y: image.naturalHeight / 2 };
        default: return { x: 0, y: 0 };
    }
}
function layerScales(layer) {
    const sx = (layer.constrain_homothety ? layer.scale : layer.scale_x) / 100;
    const sy = (layer.constrain_homothety ? layer.scale : layer.scale_y) / 100;
    return { sx: Math.max(.001, sx), sy: Math.max(.001, sy) };
}
function sourcePointToWorld(layer, image, sourcePoint) {
    const anchor = anchorPoint(layer, image);
    const { sx, sy } = layerScales(layer);
    const rotated = rotateVector((sourcePoint.x - anchor.x) * sx, (sourcePoint.y - anchor.y) * sy, layer.rot);
    return { x: layer.x + rotated.x, y: layer.y + rotated.y };
}
function geometryFor(index) {
    const layer = config.layers?.[index];
    const image = imageFor(index);
    if (!layer || !image?.naturalWidth || !image?.naturalHeight) return null;
    const w = image.naturalWidth, h = image.naturalHeight;
    const cornersDoc = [
        sourcePointToWorld(layer, image, { x: 0, y: 0 }),
        sourcePointToWorld(layer, image, { x: w, y: 0 }),
        sourcePointToWorld(layer, image, { x: w, y: h }),
        sourcePointToWorld(layer, image, { x: 0, y: h }),
    ];
    const centerDoc = sourcePointToWorld(layer, image, { x: w / 2, y: h / 2 });
    const corners = cornersDoc.map(docToCanvas);
    const center = docToCanvas(centerDoc);
    const topMid = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
    let nx = topMid.x - center.x, ny = topMid.y - center.y;
    const length = Math.hypot(nx, ny) || 1;
    nx /= length; ny /= length;
    const rotateHandle = { x: topMid.x + nx * ROTATE_OFFSET, y: topMid.y + ny * ROTATE_OFFSET };
    return { layer, image, cornersDoc, corners, centerDoc, center, topMid, rotateHandle };
}
function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        const intersect = ((yi > point.y) !== (yj > point.y)) && (point.x < (xj - xi) * (point.y - yi) / ((yj - yi) || 1e-9) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function hitHandle(point, geometry) {
    if (!geometry) return null;
    for (let index = 0; index < geometry.corners.length; index++) if (distance(point, geometry.corners[index]) <= HANDLE_HIT) return { type: "scale", corner: index };
    if (distance(point, geometry.rotateHandle) <= HANDLE_HIT + 2) return { type: "rotate" };
    return null;
}
function localPointer(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function drawChecker(x, y, w, h) {
    const size = 12;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    for (let yy = y; yy < y + h; yy += size) for (let xx = x; xx < x + w; xx += size) {
        ctx.fillStyle = ((Math.floor((xx - x) / size) + Math.floor((yy - y) / size)) & 1) ? "#dfe4ea" : "#f7f8fa";
        ctx.fillRect(xx, yy, size, size);
    }
    ctx.restore();
}
function canvasBlend(mode) {
    return ({ normal: "source-over", multiply: "multiply", screen: "screen", overlay: "overlay", darken: "darken", lighten: "lighten", add: "lighter", difference: "difference", soft_light: "soft-light", hard_light: "hard-light" })[mode] || "source-over";
}
function drawLayer(index) {
    const layer = config.layers[index];
    const image = imageFor(index);
    if (!isEffectivelyVisible(index) || !image?.naturalWidth) return;
    const anchor = anchorPoint(layer, image);
    const { sx, sy } = layerScales(layer);
    const anchorCanvas = docToCanvas({ x: layer.x, y: layer.y });
    ctx.save();
    ctx.beginPath(); ctx.rect(documentRect.x, documentRect.y, documentRect.w, documentRect.h); ctx.clip();
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = canvasBlend(layer.blend);
    ctx.translate(anchorCanvas.x, anchorCanvas.y);
    ctx.rotate(layer.rot * Math.PI / 180);
    ctx.scale(sx * documentRect.scale, sy * documentRect.scale);
    ctx.drawImage(image, -anchor.x, -anchor.y);
    ctx.restore();
}
function drawSelection() {
    if (activeLayer == null) return;
    const geometry = geometryFor(activeLayer);
    if (!geometry) return;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.strokeStyle = geometry.layer.locked ? "#6f8dac" : "#69b0ff";
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    geometry.corners.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.closePath(); ctx.stroke();
    if (!geometry.layer.locked) {
        ctx.beginPath(); ctx.moveTo(geometry.topMid.x, geometry.topMid.y); ctx.lineTo(geometry.rotateHandle.x, geometry.rotateHandle.y); ctx.stroke();
        for (const point of geometry.corners) {
            ctx.fillRect(point.x - HANDLE_RADIUS, point.y - HANDLE_RADIUS, HANDLE_RADIUS * 2, HANDLE_RADIUS * 2);
            ctx.strokeRect(point.x - HANDLE_RADIUS, point.y - HANDLE_RADIUS, HANDLE_RADIUS * 2, HANDLE_RADIUS * 2);
        }
        ctx.fillStyle = "#3f83f8";
        ctx.beginPath(); ctx.arc(geometry.rotateHandle.x, geometry.rotateHandle.y, HANDLE_RADIUS, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = "#69b0ff";
    ctx.beginPath(); ctx.arc(docToCanvas({ x: geometry.layer.x, y: geometry.layer.y }).x, docToCanvas({ x: geometry.layer.x, y: geometry.layer.y }).y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
}
function draw() {
    rafId = 0;
    ensureCanvasSize();
    calculateDocumentRect();
    ctx.clearRect(0, 0, viewportWidth, viewportHeight);
    ctx.fillStyle = "#090d12"; ctx.fillRect(0, 0, viewportWidth, viewportHeight);
    drawChecker(documentRect.x, documentRect.y, documentRect.w, documentRect.h);
    if (documentSettings.flatten_output) {
        ctx.fillStyle = normalizeHex(documentSettings.bg_hex);
        ctx.fillRect(documentRect.x, documentRect.y, documentRect.w, documentRect.h);
    }
    for (const index of orderedConnectedBottomToTop()) drawLayer(index);
    drawSelection();
    ctx.strokeStyle = "#536274"; ctx.lineWidth = 1;
    ctx.strokeRect(documentRect.x + .5, documentRect.y + .5, documentRect.w - 1, documentRect.h - 1);
}
function scheduleDraw() { if (!rafId) rafId = requestAnimationFrame(draw); }

function preserveCenterForTransform(layer, image, centerDoc) {
    const anchor = anchorPoint(layer, image);
    const { sx, sy } = layerScales(layer);
    const offset = rotateVector((image.naturalWidth / 2 - anchor.x) * sx, (image.naturalHeight / 2 - anchor.y) * sy, layer.rot);
    layer.x = round3(centerDoc.x - offset.x);
    layer.y = round3(centerDoc.y - offset.y);
}

canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    const point = localPointer(event);

    if (isHandMode()) {
        interaction = {
            mode: "pan",
            startPoint: point,
            startOffset: { ...viewOffset },
        };
        canvas.setPointerCapture?.(event.pointerId);
        canvas.style.cursor = "grabbing";
        event.preventDefault();
        return;
    }

    const selectedGeometry = activeLayer == null ? null : geometryFor(activeLayer);
    const handle = selectedGeometry?.layer.locked ? null : hitHandle(point, selectedGeometry);
    if (handle && selectedGeometry) {
        interaction = {
            mode: handle.type,
            index: activeLayer,
            startPoint: point,
            startLayer: clone(selectedGeometry.layer),
            centerDoc: { ...selectedGeometry.centerDoc },
            startAngle: Math.atan2(point.y - selectedGeometry.center.y, point.x - selectedGeometry.center.x),
        };
    } else {
        let hitIndex = null;
        const topToBottom = [...orderedConnectedBottomToTop()].reverse();
        for (const index of topToBottom) {
            const layer = config.layers?.[index];
            if (!layer || layer.locked || !isEffectivelyVisible(index)) continue;
            const geometry = geometryFor(index);
            if (geometry && pointInPolygon(point, geometry.corners)) { hitIndex = index; break; }
        }
        if (hitIndex == null) { activeLayer = null; syncActiveControls(); renderLayerList(); scheduleDraw(); return; }
        activeLayer = hitIndex;
        const layer = config.layers[hitIndex];
        interaction = { mode: "move", index: hitIndex, startDoc: canvasToDoc(point), startX: layer.x, startY: layer.y };
        syncActiveControls(); renderLayerList(); scheduleDraw();
    }
    if (interaction) canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
});

canvas.addEventListener("pointermove", event => {
    const point = localPointer(event);
    if (!interaction) {
        if (isHandMode()) { canvas.style.cursor = "grab"; return; }
        const geometry = activeLayer == null ? null : geometryFor(activeLayer);
        const handle = geometry?.layer.locked ? null : hitHandle(point, geometry);
        if (handle?.type === "scale") canvas.style.cursor = "nwse-resize";
        else if (handle?.type === "rotate") canvas.style.cursor = "crosshair";
        else {
            let over = false;
            for (const index of [...orderedConnectedBottomToTop()].reverse()) {
                const layer = config.layers?.[index];
                if (!layer || layer.locked || !isEffectivelyVisible(index)) continue;
                const g = geometryFor(index);
                if (g && pointInPolygon(point, g.corners)) { over = true; break; }
            }
            canvas.style.cursor = over ? "move" : "default";
        }
        return;
    }

    if (interaction.mode === "pan") {
        viewOffset.x = interaction.startOffset.x + point.x - interaction.startPoint.x;
        viewOffset.y = interaction.startOffset.y + point.y - interaction.startPoint.y;
        canvas.style.cursor = "grabbing";
        scheduleDraw();
        return;
    }

    const layer = config.layers[interaction.index];
    const image = imageFor(interaction.index);
    if (!layer || !image) return;
    if (interaction.mode === "move") {
        const current = canvasToDoc(point);
        layer.x = round3(interaction.startX + current.x - interaction.startDoc.x);
        layer.y = round3(interaction.startY + current.y - interaction.startDoc.y);
    } else if (interaction.mode === "scale") {
        const currentDoc = canvasToDoc(point);
        const delta = { x: currentDoc.x - interaction.centerDoc.x, y: currentDoc.y - interaction.centerDoc.y };
        const local = rotateVector(delta.x, delta.y, -interaction.startLayer.rot);
        let sx = clamp(Math.abs(local.x) / Math.max(1, image.naturalWidth / 2), .01, 20);
        let sy = clamp(Math.abs(local.y) / Math.max(1, image.naturalHeight / 2), .01, 20);
        if (interaction.startLayer.constrain_homothety) {
            const uniform = Math.max(sx, sy);
            sx = sy = uniform;
            layer.scale = round3(uniform * 100);
        }
        layer.scale_x = round3(sx * 100);
        layer.scale_y = round3(sy * 100);
        if (!layer.constrain_homothety) layer.scale = round3((layer.scale_x + layer.scale_y) / 2);
        preserveCenterForTransform(layer, image, interaction.centerDoc);
    } else if (interaction.mode === "rotate") {
        const centerCanvas = docToCanvas(interaction.centerDoc);
        const angle = Math.atan2(point.y - centerCanvas.y, point.x - centerCanvas.x);
        let degrees = interaction.startLayer.rot + (angle - interaction.startAngle) * 180 / Math.PI;
        degrees = ((degrees + 180) % 360 + 360) % 360 - 180;
        layer.rot = round3(degrees);
        preserveCenterForTransform(layer, image, interaction.centerDoc);
    }
    markDirty();
    syncActiveControls();
});

function endInteraction(event) {
    if (!interaction) return;
    const completedMode = interaction.mode;
    interaction = null;
    try { canvas.releasePointerCapture?.(event.pointerId); } catch {}
    updateHandToolState();
    if (completedMode === "pan") { scheduleDraw(); return; }
    renderLayerList();
    syncActiveControls();
    commitHistory();
}
canvas.addEventListener("pointerup", endInteraction);
canvas.addEventListener("pointercancel", endInteraction);

function currentBounds(index) {
    const geometry = geometryFor(index);
    if (!geometry) return null;
    const xs = geometry.cornersDoc.map(point => point.x), ys = geometry.cornersDoc.map(point => point.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}
function alignActive(mode) {
    if (activeLayer == null) return;
    const layer = active();
    const bounds = currentBounds(activeLayer);
    if (!layer || layer.locked || !bounds) return;
    const width = bounds.maxX - bounds.minX, height = bounds.maxY - bounds.minY;
    let targetX = bounds.minX, targetY = bounds.minY;
    const centerX = (documentSettings.canvas_width - width) / 2;
    const centerY = (documentSettings.canvas_height - height) / 2;
    const right = documentSettings.canvas_width - width;
    const bottom = documentSettings.canvas_height - height;
    if (["top_left", "left", "bottom_left"].includes(mode)) targetX = 0;
    if (["top", "center", "bottom"].includes(mode)) targetX = centerX;
    if (["top_right", "right", "bottom_right"].includes(mode)) targetX = right;
    if (["top_left", "top", "top_right"].includes(mode)) targetY = 0;
    if (["left", "center", "right"].includes(mode)) targetY = centerY;
    if (["bottom_left", "bottom", "bottom_right"].includes(mode)) targetY = bottom;
    layer.x = round3(layer.x + targetX - bounds.minX);
    layer.y = round3(layer.y + targetY - bounds.minY);
    markDirty("Layer aligned"); syncActiveControls();
}
function centerActive() { alignActive("center"); }
function fitActive() {
    if (activeLayer == null) return;
    const layer = active();
    const image = imageFor(activeLayer);
    if (!layer || layer.locked || !image?.naturalWidth) return;
    const factor = Math.min(documentSettings.canvas_width / image.naturalWidth, documentSettings.canvas_height / image.naturalHeight);
    layer.anchor = "center";
    layer.rot = 0;
    layer.constrain_homothety = true;
    layer.scale = layer.scale_x = layer.scale_y = round3(factor * 100);
    layer.x = documentSettings.canvas_width / 2;
    layer.y = documentSettings.canvas_height / 2;
    markDirty("Layer fitted to canvas"); syncActiveControls();
}
function resetActive() {
    if (activeLayer == null) return;
    const old = active();
    if (!old || old.locked) return;
    config.layers[activeLayer] = {
        ...defaultLayer(activeLayer),
        name: old.name || `Layer ${activeLayer}`,
        anchor: "center",
        x: documentSettings.canvas_width / 2,
        y: documentSettings.canvas_height / 2,
        scale: 100,
        scale_x: 100,
        scale_y: 100,
        rot: 0,
        opacity: 1,
        blend: "normal",
        visible: true,
        locked: false,
    };
    markDirty("Layer reset · centered at 100%"); syncActiveControls(); renderLayerList();
}

function bindDocumentFields() {
    for (const field of [fields.canvas_width, fields.canvas_height]) field.addEventListener("change", () => { readDocumentForm(); markDirty("Document changed"); });
    fields.bg_color.addEventListener("input", () => { fields.bg_hex.value = fields.bg_color.value.toUpperCase(); readDocumentForm(); markDirty("Background changed"); });
    fields.bg_hex.addEventListener("change", () => { fields.bg_hex.value = normalizeHex(fields.bg_hex.value); fields.bg_color.value = fields.bg_hex.value; readDocumentForm(); markDirty("Background changed"); });
    fields.flatten_output.addEventListener("change", () => { readDocumentForm(); markDirty("Document changed"); });
    fields.invert_input_masks.addEventListener("change", () => { readDocumentForm(); markDirty("Mask setting changed"); });
}
function canEditActive() { const layer = active(); return Boolean(layer && !layer.locked); }
function bindLayerFields() {
    fields.layer_name.addEventListener("input", () => { const layer = active(); if (!layer || layer.locked) return; layer.name = fields.layer_name.value; markDirty(); renderLayerList(); });
    fields.layer_x.addEventListener("change", () => { const layer = active(); if (!layer || layer.locked) return; layer.x = clamp(fields.layer_x.value, -8192, 8192); markDirty(); syncActiveControls(); });
    fields.layer_y.addEventListener("change", () => { const layer = active(); if (!layer || layer.locked) return; layer.y = clamp(fields.layer_y.value, -8192, 8192); markDirty(); syncActiveControls(); });
    fields.layer_scale.addEventListener("input", () => {
        const layer = active(); if (!layer || layer.locked) return;
        layer.scale = clamp(fields.layer_scale.value, 1, 2000);
        if (layer.constrain_homothety) layer.scale_x = layer.scale_y = layer.scale;
        markDirty(); syncActiveControls();
    });
    fields.constrain_scale.addEventListener("change", () => {
        const layer = active(); if (!layer || layer.locked) return;
        layer.constrain_homothety = fields.constrain_scale.checked;
        if (layer.constrain_homothety) layer.scale_x = layer.scale_y = layer.scale;
        markDirty(); syncActiveControls();
    });
    fields.scale_x.addEventListener("change", () => { const layer = active(); if (!layer || layer.locked) return; layer.scale_x = clamp(fields.scale_x.value, 1, 2000); layer.scale = (layer.scale_x + layer.scale_y) / 2; markDirty(); syncActiveControls(); });
    fields.scale_y.addEventListener("change", () => { const layer = active(); if (!layer || layer.locked) return; layer.scale_y = clamp(fields.scale_y.value, 1, 2000); layer.scale = (layer.scale_x + layer.scale_y) / 2; markDirty(); syncActiveControls(); });
    fields.layer_rotation.addEventListener("input", () => { const layer = active(); if (!layer || layer.locked) return; layer.rot = clamp(fields.layer_rotation.value, -180, 180); markDirty(); syncActiveControls(); });
    fields.layer_opacity.addEventListener("input", () => { const layer = active(); if (!layer || layer.locked) return; layer.opacity = clamp(fields.layer_opacity.value, 0, 1); markDirty(); syncActiveControls(); });
    fields.layer_anchor.addEventListener("change", () => {
        const layer = active(), image = imageFor(activeLayer); if (!layer || layer.locked || !image) return;
        const geometry = geometryFor(activeLayer); layer.anchor = fields.layer_anchor.value;
        if (geometry) preserveCenterForTransform(layer, image, geometry.centerDoc);
        markDirty(); syncActiveControls();
    });
    fields.layer_blend.addEventListener("change", () => { const layer = active(); if (!layer || layer.locked) return; layer.blend = fields.layer_blend.value; markDirty(); });
    fields.layer_visible.addEventListener("change", () => { const layer = active(); if (!layer) return; layer.visible = fields.layer_visible.checked; markDirty(); renderLayerList(); });
}

function apply() {
    readDocumentForm();
    config = normalizeConfig(config, connectedIndices());
    const result = bridge?.applyState?.(nodeId, { document: documentSettings, config });
    if (result) {
        documentSettings = { ...DEFAULT_DOCUMENT, ...(result.document || {}) };
        config = normalizeConfig(result.config || config, connectedIndices());
        dirty = false;
        statusEl.textContent = "Composition applied to ComfyUI";
        writeDocumentForm(); syncActiveControls(); renderLayerList(); scheduleDraw();
        return true;
    }
    statusEl.textContent = "Unable to reach the ComfyUI node";
    return false;
}

function consumeState(state, { full = false, forceImages = false } = {}) {
    if (!state) return;
    lastRevision = Number(state.revision ?? lastRevision);
    if (full || !dirty) {
        documentSettings = { ...DEFAULT_DOCUMENT, ...(state.document || {}) };
        config = normalizeConfig(state.config || {}, (state.layers || []).map(item => item.index));
        writeDocumentForm();
    }
    syncLayerSources(state.layers || [], forceImages);
    ensureConnectedConfig();
    statusEl.textContent = metadata.length ? `Connected — ${metadata.length} layer${metadata.length > 1 ? "s" : ""}` : "Connected — no image layer";
}

function initialLoad() {
    if (!bridge || !Number.isFinite(nodeId)) {
        statusEl.textContent = "Open this application from the Layer Manager node";
        return;
    }
    const state = bridge.getState?.(nodeId);
    if (!state) { statusEl.textContent = "Layer Manager node not found"; return; }
    consumeState(state, { full: true, forceImages: true });
    resetHistory();
    pollTimer = window.setInterval(() => {
        const next = bridge.getState?.(nodeId);
        if (!next) return;
        const revisionChanged = Number(next.revision ?? -1) !== lastRevision;
        const signature = JSON.stringify((next.layers || []).map(item => [item.index, normalizeSourceUrl(item.imageSrc), item.hasMask, item.maskReady]));
        const currentSignature = JSON.stringify(metadata.map(item => [item.index, normalizeSourceUrl(item.imageSrc), item.hasMask, item.maskReady]));
        if (revisionChanged || signature !== currentSignature) consumeState(next, { full: !dirty, forceImages: signature !== currentSignature });
    }, 800);
}

bindDocumentFields();
bindLayerFields();
document.querySelectorAll("[data-align]").forEach(button => button.addEventListener("click", () => alignActive(button.dataset.align)));
document.querySelector("#fitLayer").addEventListener("click", fitActive);
document.querySelector("#centerLayer").addEventListener("click", centerActive);
document.querySelector("#refreshLayers").addEventListener("click", () => {
    const state = bridge?.refreshLayers?.(nodeId);
    if (state) consumeState(state, { full: false, forceImages: true });
});
document.querySelector("#applySettings").addEventListener("click", apply);
document.querySelector("#applyClose").addEventListener("click", () => { if (apply()) window.close(); });
document.querySelector("#closeApp").addEventListener("click", () => window.close());

undoButton.addEventListener("click", undo);
redoButton.addEventListener("click", redo);
document.querySelector("#zoomOut").addEventListener("click", () => setViewZoom(viewZoom / 1.2));
document.querySelector("#zoomIn").addEventListener("click", () => setViewZoom(viewZoom * 1.2));
zoomValue.addEventListener("click", resetViewZoom);
handButton?.addEventListener("click", () => {
    handToolActive = !handToolActive;
    updateHandToolState();
});
canvas.addEventListener("wheel", event => {
    event.preventDefault();
    const focal = localPointer(event);
    setViewZoom(viewZoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), focal);
}, { passive: false });
lockButton.addEventListener("click", () => {
    const layer = active(); if (!layer) return;
    layer.locked = !layer.locked;
    markDirty(layer.locked ? "Layer locked" : "Layer unlocked");
    syncActiveControls(); renderLayerList();
});
muteButton.addEventListener("click", () => {
    const layer = active(); if (!layer) return;
    layer.visible = !layer.visible;
    markDirty(layer.visible ? "Layer unmuted" : "Layer muted");
    syncActiveControls(); renderLayerList();
});
soloButton.addEventListener("click", () => {
    if (activeLayer == null) return;
    const enablingSolo = !isSoloActive(activeLayer);
    config.solo_layer = enablingSolo ? activeLayer : null;
    if (enablingSolo) active().visible = true;
    markDirty(config.solo_layer == null ? "Solo disabled" : `Layer ${activeLayer} solo`);
    syncActiveControls(); renderLayerList();
});
resetLayerButton.addEventListener("click", resetActive);

new ResizeObserver(scheduleDraw).observe(stage);
window.addEventListener("beforeunload", () => { if (pollTimer) clearInterval(pollTimer); });
window.addEventListener("keydown", event => {
    const key = event.key.toLowerCase();
    if (event.code === "Space" && !isTextEntryTarget(event.target)) {
        event.preventDefault();
        if (!spacePanActive) {
            spacePanActive = true;
            updateHandToolState();
        }
        return;
    }
    if ((event.ctrlKey || event.metaKey) && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
        return;
    }
    if ((event.ctrlKey || event.metaKey) && key === "y") { event.preventDefault(); redo(); return; }
    if ((event.ctrlKey || event.metaKey) && key === "s") { event.preventDefault(); apply(); }
    if (event.key === "Escape") { interaction = null; updateHandToolState(); scheduleDraw(); }
});
window.addEventListener("keyup", event => {
    if (event.code !== "Space") return;
    if (spacePanActive) {
        spacePanActive = false;
        updateHandToolState();
    }
});
window.addEventListener("blur", () => {
    spacePanActive = false;
    if (interaction?.mode === "pan") interaction = null;
    updateHandToolState();
    scheduleDraw();
});

writeDocumentForm();
syncActiveControls();
updateZoomDisplay();
updateHandToolState();
updateHistoryButtons();
initialLoad();
scheduleDraw();
