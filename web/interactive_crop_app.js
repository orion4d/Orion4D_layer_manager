const DEFAULTS = {
    scale_multiplier: 1.0,
    x: 0,
    y: 0,
    width: 512,
    height: 512,
    aspect_ratio: "Free",
};

// Pure ratios only: fixed pixel resolutions, paper sizes and social-media formats were removed.
const ASPECT_CHOICES = [
    "Free",
    "1:1 (Perfect Square)",
    "2:1 (Double Wide)", "1:2 (Split Vertical)",
    "2:3 (Classic Portrait)", "3:2 (Classic Landscape)",
    "3:4 (Portrait Classic)", "4:3 (Classic Landscape)",
    "4:5 (Artistic Frame)", "5:4 (Balanced Frame)",
    "5:7 (Balanced Portrait)", "7:5 (Elegant Landscape)",
    "5:8 (Tall Portrait)", "8:5 (Cinematic View)",
    "7:9 (Modern Portrait)", "9:7 (Artful Horizon)",
    "9:16 (Slim Vertical)", "16:9 (Panorama)",
    "9:19 (Tall Slim)", "19:9 (Cinematic Ultrawide)",
    "9:21 (Ultra Tall)", "21:9 (Epic Ultrawide)",
    "9:32 (Skyline)", "32:9 (Extreme Ultrawide)",
    "3:5 (Elegant Vertical)", "5:3 (Wide Horizon)",
    "2:5 (Tall Banner)", "5:2 (Wide Banner)",
    "1:3 (Vertical Triptych)", "3:1 (Horizontal Triptych)",
    "1:4 (Ultra Vertical Strip)", "4:1 (Ultra Wide Strip)",
    "10:16 (Poster Portrait)", "16:10 (Wide Monitor)",
    "10:18 (Tall Poster)", "18:10 (Wide Poster)",
    "11:14 (Portrait Print)", "14:11 (Landscape Print)",
    "11:17 (Tabloid Portrait)", "17:11 (Tabloid Landscape)",
    "8:11 (Letter Portrait)", "11:8 (Letter Landscape)",
    "8:14 (Legal Portrait)", "14:8 (Legal Landscape)",
    "1:1.85 (Cinema Vertical)", "1.85:1 (Cinema Flat)",
    "1:2.35 (Cinemascope Vertical)", "2.35:1 (Cinemascope)",
    "2.39:1 (Cinema Scope)", "2.40:1 (Cinema Wide)",
    "2.20:1 (70mm)", "65:24 (XPan Panorama)",
    "6:7 (Medium Format Portrait)", "7:6 (Medium Format Landscape)",
    "6:9 (Film Portrait)", "9:6 (Film Landscape)",
];

const nodeId = Number(new URLSearchParams(location.search).get("nodeId"));
const bridge = window.opener?.__orion4dInteractiveCropBridge;
const canvas = document.querySelector("#previewCanvas");
const ctx = canvas.getContext("2d");
const stage = document.querySelector("#previewStage");
const statusEl = document.querySelector("#status");
const cropInfo = document.querySelector("#cropInfo");
const emptyMessage = document.querySelector("#emptyMessage");
const alignmentSelect = document.querySelector("#alignment");

const fields = {
    scale_multiplier: document.querySelector("#scale_multiplier"),
    x: document.querySelector("#x"),
    y: document.querySelector("#y"),
    width: document.querySelector("#width"),
    height: document.querySelector("#height"),
    x_range: document.querySelector("#x_range"),
    y_range: document.querySelector("#y_range"),
    width_range: document.querySelector("#width_range"),
    height_range: document.querySelector("#height_range"),
    aspect_ratio: document.querySelector("#aspect_ratio"),
};

const scaleOutput = document.querySelector("#scaleOutput");
const sourceSize = document.querySelector("#sourceSize");
const scaledCanvas = document.querySelector("#scaledCanvas");
const scaledCrop = document.querySelector("#scaledCrop");
const scaledPosition = document.querySelector("#scaledPosition");

for (const choice of ASPECT_CHOICES) fields.aspect_ratio.add(new Option(choice, choice));

let sourceImage = null;
let sourceUrl = null;
let imagePollTimer = null;
let drawRaf = 0;
let viewportWidth = 0;
let viewportHeight = 0;
let imageRect = { x: 0, y: 0, w: 0, h: 0 };
let selection = { x: 0, y: 0, w: 512, h: 512 };
let pointerState = null;

const HANDLE_SIZE = 12;
const HANDLE_HIT = 24;

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function parseRatio(value = fields.aspect_ratio.value) {
    const text = String(value || "").trim();
    if (!text || text.toLowerCase().startsWith("free")) return 0;
    const match = text.match(/(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)/);
    if (!match) return 0;
    const w = Number(match[1]);
    const h = Number(match[2]);
    return w > 0 && h > 0 ? w / h : 0;
}

function imageWidth() { return sourceImage?.naturalWidth || 0; }
function imageHeight() { return sourceImage?.naturalHeight || 0; }

function normalizeSelection(input = selection) {
    const iw = imageWidth();
    const ih = imageHeight();
    const out = {
        x: Math.round(number(input.x, 0)),
        y: Math.round(number(input.y, 0)),
        w: Math.round(Math.max(1, number(input.w, 1))),
        h: Math.round(Math.max(1, number(input.h, 1))),
    };
    if (!iw || !ih) return out;
    out.x = clamp(out.x, 0, Math.max(0, iw - 1));
    out.y = clamp(out.y, 0, Math.max(0, ih - 1));
    out.w = clamp(out.w, 1, Math.max(1, iw - out.x));
    out.h = clamp(out.h, 1, Math.max(1, ih - out.y));
    return out;
}

function readForm() {
    selection = normalizeSelection({
        x: number(fields.x.value, 0),
        y: number(fields.y.value, 0),
        w: number(fields.width.value, 512),
        h: number(fields.height.value, 512),
    });
    return {
        scale_multiplier: clamp(number(fields.scale_multiplier.value, 1), 0.1, 10),
        x: selection.x,
        y: selection.y,
        width: selection.w,
        height: selection.h,
        aspect_ratio: fields.aspect_ratio.value || "Free",
    };
}

function writeForm(settings = DEFAULTS, normalize = true) {
    const next = { ...DEFAULTS, ...settings };
    fields.scale_multiplier.value = clamp(number(next.scale_multiplier, 1), 0.1, 10);
    fields.aspect_ratio.value = ASPECT_CHOICES.includes(String(next.aspect_ratio)) ? String(next.aspect_ratio) : "Free";
    alignmentSelect.value = "free";
    selection = {
        x: Math.round(number(next.x, 0)),
        y: Math.round(number(next.y, 0)),
        w: Math.round(Math.max(1, number(next.width, 512))),
        h: Math.round(Math.max(1, number(next.height, 512))),
    };
    if (normalize) selection = normalizeSelection(selection);
    syncFieldsFromSelection({ preserveAlignment: true });
    scheduleDraw();
}

function setRangeLimits(range, numberInput, min, max) {
    const safeMin = Math.round(min);
    const safeMax = Math.max(safeMin, Math.round(max));
    range.min = String(safeMin);
    range.max = String(safeMax);
    numberInput.min = String(safeMin);
    numberInput.max = String(safeMax);
}

function updateDynamicControls() {
    const iw = imageWidth() || 16384;
    const ih = imageHeight() || 16384;
    const maxW = imageWidth() ? Math.max(1, iw - selection.x) : 16384;
    const maxH = imageHeight() ? Math.max(1, ih - selection.y) : 16384;
    const maxX = imageWidth() ? Math.max(0, iw - selection.w) : 16384;
    const maxY = imageHeight() ? Math.max(0, ih - selection.h) : 16384;

    setRangeLimits(fields.width_range, fields.width, 1, maxW);
    setRangeLimits(fields.height_range, fields.height, 1, maxH);
    setRangeLimits(fields.x_range, fields.x, 0, maxX);
    setRangeLimits(fields.y_range, fields.y, 0, maxY);

    fields.x.value = selection.x;
    fields.y.value = selection.y;
    fields.width.value = selection.w;
    fields.height.value = selection.h;
    fields.x_range.value = clamp(selection.x, 0, maxX);
    fields.y_range.value = clamp(selection.y, 0, maxY);
    fields.width_range.value = clamp(selection.w, 1, maxW);
    fields.height_range.value = clamp(selection.h, 1, maxH);
}

function syncFieldsFromSelection({ preserveAlignment = false } = {}) {
    selection = normalizeSelection(selection);
    if (!preserveAlignment) alignmentSelect.value = "free";
    updateDynamicControls();
    updateMetrics();
}

function updateMetrics() {
    const scale = clamp(number(fields.scale_multiplier.value, 1), 0.1, 10);
    const iw = imageWidth();
    const ih = imageHeight();
    scaleOutput.textContent = `${scale.toFixed(1)}×`;
    sourceSize.textContent = iw && ih ? `${iw} × ${ih}` : "—";
    scaledCanvas.textContent = iw && ih ? `${Math.round(iw * scale)} × ${Math.round(ih * scale)}` : "—";
    scaledCrop.textContent = `${Math.round(selection.w * scale)} × ${Math.round(selection.h * scale)}`;
    scaledPosition.textContent = `${Math.round(selection.x * scale)}, ${Math.round(selection.y * scale)}`;
    cropInfo.textContent = `${selection.w} × ${selection.h} px · X ${selection.x} · Y ${selection.y}`;
}

function fitCurrentSelectionToRatio() {
    const ratio = parseRatio();
    const iw = imageWidth();
    const ih = imageHeight();
    if (!ratio || !iw || !ih) return;

    const cx = selection.x + selection.w / 2;
    const cy = selection.y + selection.h / 2;
    let w = selection.w;
    let h = w / ratio;
    if (h > selection.h) {
        h = selection.h;
        w = h * ratio;
    }
    w = Math.min(w, iw, ih * ratio);
    h = w / ratio;
    const x = clamp(cx - w / 2, 0, iw - w);
    const y = clamp(cy - h / 2, 0, ih - h);
    selection = normalizeSelection({ x, y, w, h });
    syncFieldsFromSelection({ preserveAlignment: true });
}

function alignSelection(mode) {
    const iw = imageWidth();
    const ih = imageHeight();
    if (!iw || !ih) return;

    let x = selection.x;
    let y = selection.y;
    const centerX = Math.round((iw - selection.w) / 2);
    const centerY = Math.round((ih - selection.h) / 2);
    const rightX = Math.max(0, iw - selection.w);
    const bottomY = Math.max(0, ih - selection.h);

    switch (mode) {
        case "top_left": x = 0; y = 0; break;
        case "top": x = centerX; y = 0; break;
        case "top_right": x = rightX; y = 0; break;
        case "left": x = 0; y = centerY; break;
        case "center": x = centerX; y = centerY; break;
        case "right": x = rightX; y = centerY; break;
        case "bottom_left": x = 0; y = bottomY; break;
        case "bottom": x = centerX; y = bottomY; break;
        case "bottom_right": x = rightX; y = bottomY; break;
        default: alignmentSelect.value = "free"; return;
    }

    selection = normalizeSelection({ ...selection, x, y });
    alignmentSelect.value = mode;
    syncFieldsFromSelection({ preserveAlignment: true });
    scheduleDraw();
}

function setFullImage() {
    const iw = imageWidth();
    const ih = imageHeight();
    if (!iw || !ih) return;
    const ratio = parseRatio();
    let w = iw;
    let h = ih;
    if (ratio) {
        if (w / h > ratio) w = h * ratio;
        else h = w / ratio;
    }
    selection = normalizeSelection({
        x: Math.round((iw - w) / 2),
        y: Math.round((ih - h) / 2),
        w: Math.round(w),
        h: Math.round(h),
    });
    alignmentSelect.value = "center";
    syncFieldsFromSelection({ preserveAlignment: true });
    scheduleDraw();
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
    return { width, height };
}

function calculateImageRect() {
    const iw = imageWidth();
    const ih = imageHeight();
    const padding = 24;
    if (!iw || !ih) {
        imageRect = { x: 0, y: 0, w: 0, h: 0 };
        return imageRect;
    }
    const availableW = Math.max(1, viewportWidth - padding * 2);
    const availableH = Math.max(1, viewportHeight - padding * 2);
    const scale = Math.min(availableW / iw, availableH / ih);
    const w = iw * scale;
    const h = ih * scale;
    imageRect = { x: (viewportWidth - w) / 2, y: (viewportHeight - h) / 2, w, h };
    return imageRect;
}

function imageToCanvas(x, y) {
    return {
        x: imageRect.x + (x / imageWidth()) * imageRect.w,
        y: imageRect.y + (y / imageHeight()) * imageRect.h,
    };
}

function canvasToImage(x, y) {
    const iw = imageWidth();
    const ih = imageHeight();
    return {
        x: clamp(((x - imageRect.x) / Math.max(1e-6, imageRect.w)) * iw, 0, iw),
        y: clamp(((y - imageRect.y) / Math.max(1e-6, imageRect.h)) * ih, 0, ih),
        inside: x >= imageRect.x && x <= imageRect.x + imageRect.w && y >= imageRect.y && y <= imageRect.y + imageRect.h,
    };
}

function selectionCanvasRect() {
    const p1 = imageToCanvas(selection.x, selection.y);
    const p2 = imageToCanvas(selection.x + selection.w, selection.y + selection.h);
    return { x: p1.x, y: p1.y, w: p2.x - p1.x, h: p2.y - p1.y };
}

function handlePositions() {
    const r = selectionCanvasRect();
    return {
        nw: { x: r.x, y: r.y },
        ne: { x: r.x + r.w, y: r.y },
        se: { x: r.x + r.w, y: r.y + r.h },
        sw: { x: r.x, y: r.y + r.h },
    };
}

function hitHandle(point) {
    const handles = handlePositions();
    for (const [name, handle] of Object.entries(handles)) {
        if (Math.abs(point.x - handle.x) <= HANDLE_HIT && Math.abs(point.y - handle.y) <= HANDLE_HIT) return name;
    }
    return null;
}

function pointInsideSelection(point) {
    const r = selectionCanvasRect();
    return point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h;
}

function draw() {
    drawRaf = 0;
    const { width, height } = ensureCanvasSize();
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#090d12";
    ctx.fillRect(0, 0, width, height);
    calculateImageRect();

    if (!sourceImage) {
        emptyMessage.hidden = false;
        return;
    }
    emptyMessage.hidden = true;

    ctx.drawImage(sourceImage, imageRect.x, imageRect.y, imageRect.w, imageRect.h);
    const crop = selectionCanvasRect();

    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, .62)";
    ctx.beginPath();
    ctx.rect(imageRect.x, imageRect.y, imageRect.w, imageRect.h);
    ctx.rect(crop.x, crop.y, crop.w, crop.h);
    ctx.fill("evenodd");
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = "rgba(105, 176, 255, .98)";
    ctx.lineWidth = 2;
    ctx.strokeRect(crop.x + 0.5, crop.y + 0.5, crop.w - 1, crop.h - 1);

    ctx.strokeStyle = "rgba(255,255,255,.34)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 2; i++) {
        const xx = crop.x + crop.w * i / 3;
        const yy = crop.y + crop.h * i / 3;
        ctx.beginPath(); ctx.moveTo(xx, crop.y); ctx.lineTo(xx, crop.y + crop.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(crop.x, yy); ctx.lineTo(crop.x + crop.w, yy); ctx.stroke();
    }

    for (const handle of Object.values(handlePositions())) {
        ctx.fillStyle = "#eaf4ff";
        ctx.fillRect(handle.x - HANDLE_SIZE / 2, handle.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
        ctx.strokeStyle = "#267edc";
        ctx.strokeRect(handle.x - HANDLE_SIZE / 2 + 0.5, handle.y - HANDLE_SIZE / 2 + 0.5, HANDLE_SIZE - 1, HANDLE_SIZE - 1);
    }

    const label = `${selection.w} × ${selection.h}`;
    ctx.font = "12px system-ui, sans-serif";
    const labelW = ctx.measureText(label).width + 14;
    const labelY = crop.y > 28 ? crop.y - 25 : crop.y + 7;
    ctx.fillStyle = "rgba(12, 18, 26, .9)";
    ctx.fillRect(crop.x, labelY, labelW, 20);
    ctx.fillStyle = "#dcecff";
    ctx.fillText(label, crop.x + 7, labelY + 14);
    ctx.restore();
}

function scheduleDraw() {
    updateMetrics();
    if (!drawRaf) drawRaf = requestAnimationFrame(draw);
}

function localPointer(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function anchorForHandle(handle, start) {
    switch (handle) {
        case "nw": return { x: start.x + start.w, y: start.y + start.h, sx: -1, sy: -1 };
        case "ne": return { x: start.x, y: start.y + start.h, sx: 1, sy: -1 };
        case "se": return { x: start.x, y: start.y, sx: 1, sy: 1 };
        case "sw": return { x: start.x + start.w, y: start.y, sx: -1, sy: 1 };
        default: return { x: start.x, y: start.y, sx: 1, sy: 1 };
    }
}

function selectionFromAnchor(anchor, pointer, sx, sy, ratio) {
    const iw = imageWidth();
    const ih = imageHeight();
    const maxW = sx > 0 ? iw - anchor.x : anchor.x;
    const maxH = sy > 0 ? ih - anchor.y : anchor.y;
    let w = clamp(Math.abs(pointer.x - anchor.x), 1, Math.max(1, maxW));
    let h = clamp(Math.abs(pointer.y - anchor.y), 1, Math.max(1, maxH));

    if (ratio) {
        if (w / h > ratio) h = w / ratio;
        else w = h * ratio;
        w = Math.min(w, maxW, maxH * ratio);
        h = w / ratio;
        w = Math.max(1, w);
        h = Math.max(1, h);
    }

    const movingX = anchor.x + sx * w;
    const movingY = anchor.y + sy * h;
    return normalizeSelection({
        x: Math.min(anchor.x, movingX),
        y: Math.min(anchor.y, movingY),
        w: Math.abs(movingX - anchor.x),
        h: Math.abs(movingY - anchor.y),
    });
}

function updateCursor(point) {
    const handle = sourceImage ? hitHandle(point) : null;
    if (handle === "nw" || handle === "se") canvas.style.cursor = "nwse-resize";
    else if (handle === "ne" || handle === "sw") canvas.style.cursor = "nesw-resize";
    else if (pointInsideSelection(point)) canvas.style.cursor = "move";
    else canvas.style.cursor = "crosshair";
}

canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !sourceImage) return;
    const local = localPointer(event);
    const imagePoint = canvasToImage(local.x, local.y);
    if (!imagePoint.inside) return;

    const handle = hitHandle(local);
    const start = { ...selection };

    if (handle) {
        pointerState = {
            mode: "resize",
            pointerId: event.pointerId,
            handle,
            start,
            anchor: anchorForHandle(handle, start),
        };
    } else if (pointInsideSelection(local)) {
        pointerState = {
            mode: "move",
            pointerId: event.pointerId,
            start,
            startPoint: { x: imagePoint.x, y: imagePoint.y },
        };
    } else {
        pointerState = {
            mode: "new",
            pointerId: event.pointerId,
            startPoint: { x: imagePoint.x, y: imagePoint.y },
        };
        selection = normalizeSelection({ x: imagePoint.x, y: imagePoint.y, w: 1, h: 1 });
    }

    alignmentSelect.value = "free";
    canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    syncFieldsFromSelection();
    scheduleDraw();
});

canvas.addEventListener("pointermove", event => {
    const local = localPointer(event);
    if (!pointerState) {
        updateCursor(local);
        return;
    }
    const point = canvasToImage(local.x, local.y);
    const ratio = parseRatio();

    if (pointerState.mode === "move") {
        const dx = point.x - pointerState.startPoint.x;
        const dy = point.y - pointerState.startPoint.y;
        selection = normalizeSelection({
            ...pointerState.start,
            x: clamp(pointerState.start.x + dx, 0, imageWidth() - pointerState.start.w),
            y: clamp(pointerState.start.y + dy, 0, imageHeight() - pointerState.start.h),
        });
    } else if (pointerState.mode === "resize") {
        const { x, y, sx, sy } = pointerState.anchor;
        selection = selectionFromAnchor({ x, y }, point, sx, sy, ratio);
    } else if (pointerState.mode === "new") {
        const start = pointerState.startPoint;
        const sx = point.x >= start.x ? 1 : -1;
        const sy = point.y >= start.y ? 1 : -1;
        selection = selectionFromAnchor(start, point, sx, sy, ratio);
    }

    syncFieldsFromSelection();
    scheduleDraw();
    event.preventDefault();
});

function endPointer(event) {
    if (!pointerState) return;
    if (event.pointerId === pointerState.pointerId) canvas.releasePointerCapture?.(event.pointerId);
    pointerState = null;
    syncFieldsFromSelection();
    scheduleDraw();
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("contextmenu", event => event.preventDefault());

function normalizeSourceUrl(url) {
    const raw = String(url || "");
    if (!raw) return "";
    try {
        const parsed = new URL(raw, window.location.href);
        for (const key of ["orion_t", "t", "timestamp", "cache", "cb", "rand"]) parsed.searchParams.delete(key);
        return `${parsed.pathname}?${parsed.searchParams.toString()}`.replace(/\?$/, "");
    } catch {
        return raw.replace(/([?&])(orion_t|t|timestamp|cache|cb|rand)=[^&]*/gi, "$1").replace(/[?&]+$/, "").replace(/\?&/, "?");
    }
}

function loadImage(url, force = false) {
    const nextUrl = url || null;
    if (!force && normalizeSourceUrl(nextUrl) === normalizeSourceUrl(sourceUrl) && sourceImage) return;
    sourceUrl = nextUrl;

    if (!nextUrl) {
        sourceImage = null;
        statusEl.textContent = "Connected — waiting for an input preview";
        updateMetrics();
        scheduleDraw();
        return;
    }

    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
        sourceImage = image;
        selection = normalizeSelection(selection);
        syncFieldsFromSelection({ preserveAlignment: true });
        statusEl.textContent = `Connected — ${image.naturalWidth} × ${image.naturalHeight}`;
        scheduleDraw();
    };
    image.onerror = () => {
        sourceImage = null;
        statusEl.textContent = "Connected — preview unavailable";
        scheduleDraw();
    };
    image.src = `${nextUrl}${String(nextUrl).includes("?") ? "&" : "?"}orion_t=${Date.now()}`;
}

function startImagePolling() {
    if (imagePollTimer || !bridge) return;
    imagePollTimer = window.setInterval(() => {
        const next = bridge.refreshImage?.(nodeId);
        if (normalizeSourceUrl(next) !== normalizeSourceUrl(sourceUrl)) loadImage(next, true);
        else if (!sourceImage && next) loadImage(next, false);
    }, 1000);
}

function apply() {
    const next = readForm();
    const applied = bridge?.applySettings?.(nodeId, next);
    if (applied) {
        const alignment = alignmentSelect.value;
        writeForm(applied);
        alignmentSelect.value = alignment;
        statusEl.textContent = "Crop settings applied to ComfyUI";
    } else {
        statusEl.textContent = "Unable to reach the ComfyUI node";
    }
}

function editSelectionField(name, rawValue) {
    const value = Math.round(number(rawValue, name === "width" || name === "height" ? 1 : 0));
    const ratio = parseRatio();
    const next = { ...selection };

    if (name === "x") next.x = value;
    else if (name === "y") next.y = value;
    else if (name === "width") {
        next.w = Math.max(1, value);
        if (ratio) next.h = Math.max(1, Math.round(next.w / ratio));
    } else if (name === "height") {
        next.h = Math.max(1, value);
        if (ratio) next.w = Math.max(1, Math.round(next.h * ratio));
    }

    selection = normalizeSelection(next);
    alignmentSelect.value = "free";
    syncFieldsFromSelection();
    scheduleDraw();
}

for (const name of ["x", "y", "width", "height"]) {
    fields[name].addEventListener("input", () => editSelectionField(name, fields[name].value));
    fields[`${name}_range`].addEventListener("input", () => editSelectionField(name, fields[`${name}_range`].value));
}

fields.scale_multiplier.addEventListener("input", updateMetrics);
fields.aspect_ratio.addEventListener("change", () => {
    const alignment = alignmentSelect.value;
    fitCurrentSelectionToRatio();
    if (alignment !== "free") alignSelection(alignment);
    else scheduleDraw();
});
alignmentSelect.addEventListener("change", () => alignSelection(alignmentSelect.value));

document.querySelector("#fullImage").addEventListener("click", setFullImage);
document.querySelector("#centerCrop").addEventListener("click", () => alignSelection("center"));
document.querySelector("#refreshImage").addEventListener("click", () => loadImage(bridge?.refreshImage?.(nodeId), true));
document.querySelector("#applySettings").addEventListener("click", apply);
document.querySelector("#applyClose").addEventListener("click", () => { apply(); window.close(); });
document.querySelector("#closeApp").addEventListener("click", () => window.close());
document.querySelector("#resetSettings").addEventListener("click", () => {
    const reset = bridge?.resetSettings?.(nodeId) || DEFAULTS;
    writeForm(reset);
    statusEl.textContent = "Crop settings reset";
});

const resizeObserver = new ResizeObserver(scheduleDraw);
resizeObserver.observe(stage);
window.addEventListener("resize", scheduleDraw, { passive: true });
window.addEventListener("beforeunload", () => {
    if (imagePollTimer) clearInterval(imagePollTimer);
    resizeObserver.disconnect();
});

if (!window.opener || !bridge || !Number.isFinite(nodeId)) {
    statusEl.textContent = "Open this application from the Interactive Crop node";
    writeForm(DEFAULTS, false);
} else {
    const state = bridge.getState(nodeId);
    if (!state) {
        statusEl.textContent = "Interactive Crop node not found";
        writeForm(DEFAULTS, false);
    } else {
        document.title = `${state.title} — Orion4D`;
        writeForm(state.settings, false);
        loadImage(state.imageSrc, true);
        startImagePolling();
    }
}
