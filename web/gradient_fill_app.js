const DEFAULTS = {
    width: 1024, height: 1024, fill_mode: "solid", color_count: "1",
    color_1: "#FFFFFF", color_2: "#FFFFFF", color_3: "#FFFFFF", color_4: "#FFFFFF",
    invert: false, angle: 0, center_x: 0.5, center_y: 0.5,
    inner_border_px: 0, border_color: "#FFFFFF", border_opacity: 1,
};

const nodeId = Number(new URLSearchParams(location.search).get("nodeId"));
const bridge = window.opener?.__orion4dGradientBridge;
const canvas = document.querySelector("#previewCanvas");
const ctx = canvas.getContext("2d");
const stage = document.querySelector(".preview-stage");
const statusEl = document.querySelector("#status");
const canvasInfo = document.querySelector("#canvasInfo");
const presetSelect = document.querySelector("#presetSelect");
const fields = Object.fromEntries(Object.keys(DEFAULTS).map(id => [id, document.getElementById(id)]));
for (let index = 1; index <= 4; index++) fields[`color_${index}_text`] = document.getElementById(`color_${index}_text`);
fields.border_color_text = document.getElementById("border_color_text");

let settings = { ...DEFAULTS };
let currentPreset = "";
let drawRaf = 0;
let viewportWidth = 0;
let viewportHeight = 0;
let lastBoard = null;
let draggingCenter = false;

function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value))); }
function normalizeHex(value, fallback) {
    let text = String(value || "").trim();
    if (!text.startsWith("#")) text = `#${text}`;
    if (/^#[0-9a-f]{3}$/i.test(text)) text = `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
    return /^#[0-9a-f]{6}$/i.test(text) ? text.toUpperCase() : fallback;
}
function hexToRgb(hex) {
    const value = normalizeHex(hex, "#FFFFFF").slice(1);
    return [parseInt(value.slice(0,2),16), parseInt(value.slice(2,4),16), parseInt(value.slice(4,6),16)];
}
function rgba(hex, alpha) {
    const [r,g,b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha})`;
}

function readForm() {
    const next = {
        width: Math.max(1, Math.round(Number(fields.width.value) || 1)),
        height: Math.max(1, Math.round(Number(fields.height.value) || 1)),
        fill_mode: fields.fill_mode.value,
        color_count: String(fields.color_count.value),
        invert: fields.invert.checked,
        angle: Number(fields.angle.value),
        center_x: Number(fields.center_x.value),
        center_y: Number(fields.center_y.value),
        inner_border_px: Number(fields.inner_border_px.value),
        border_color: normalizeHex(fields.border_color_text.value, "#FFFFFF"),
        border_opacity: Number(fields.border_opacity.value),
    };
    for (let index = 1; index <= 4; index++) next[`color_${index}`] = normalizeHex(fields[`color_${index}_text`].value, "#FFFFFF");
    return next;
}

function writeForm(next) {
    settings = { ...DEFAULTS, ...(next || {}) };
    for (const key of Object.keys(DEFAULTS)) {
        if (!fields[key]) continue;
        if (fields[key].type === "checkbox") fields[key].checked = Boolean(settings[key]);
        else fields[key].value = settings[key];
    }
    for (let index = 1; index <= 4; index++) {
        const key = `color_${index}`;
        const value = normalizeHex(settings[key], DEFAULTS[key]);
        fields[key].value = value;
        fields[`${key}_text`].value = value;
    }
    const border = normalizeHex(settings.border_color, DEFAULTS.border_color);
    fields.border_color.value = border;
    fields.border_color_text.value = border;
    updateLabels();
    scheduleDraw();
}

function updateLabels() {
    document.querySelector('[data-for="angle"]').textContent = `${Math.round(Number(fields.angle.value))}°`;
    document.querySelector('[data-for="center_x"]').textContent = Number(fields.center_x.value).toFixed(2);
    document.querySelector('[data-for="center_y"]').textContent = Number(fields.center_y.value).toFixed(2);
    document.querySelector('[data-for="inner_border_px"]').textContent = `${Math.round(Number(fields.inner_border_px.value))}px`;
    document.querySelector('[data-for="border_opacity"]').textContent = `${Math.round(Number(fields.border_opacity.value) * 100)}%`;
    const count = Math.max(1, Math.min(4, Number(fields.color_count.value) || 1));
    for (let index = 1; index <= 4; index++) document.querySelector(`[data-color-row="${index}"]`)?.classList.toggle("inactive", index > count);
}

function resizeCanvas() {
    const width = Math.max(1, Math.floor(stage.clientWidth));
    const height = Math.max(1, Math.floor(stage.clientHeight));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const bufferWidth = Math.round(width * dpr);
    const bufferHeight = Math.round(height * dpr);
    if (canvas.width !== bufferWidth || canvas.height !== bufferHeight) {
        canvas.width = bufferWidth;
        canvas.height = bufferHeight;
    }
    viewportWidth = width;
    viewportHeight = height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width, height };
}

function maxCornerMetric(cx, cy, metric) {
    const corners = [[-cx,-cy],[1-cx,-cy],[-cx,1-cy],[1-cx,1-cy]];
    return Math.max(...corners.map(([x,y]) => metric(x,y)), 1e-6);
}

function interpolateColors(colors, t) {
    if (colors.length === 1) return colors[0];
    const scaled = clamp(t, 0, 1) * (colors.length - 1);
    const index = Math.min(colors.length - 2, Math.floor(scaled));
    const fraction = scaled - index;
    const a = colors[index], b = colors[index + 1];
    return [
        Math.round(a[0] * (1 - fraction) + b[0] * fraction),
        Math.round(a[1] * (1 - fraction) + b[1] * fraction),
        Math.round(a[2] * (1 - fraction) + b[2] * fraction),
    ];
}

function renderGradient(targetWidth, targetHeight, s) {
    const maxSide = 720;
    const ratio = targetWidth / targetHeight;
    let rw = Math.max(2, Math.round(Math.min(targetWidth, maxSide)));
    let rh = Math.max(2, Math.round(rw / ratio));
    if (rh > maxSide) { rh = maxSide; rw = Math.max(2, Math.round(rh * ratio)); }
    const offscreen = document.createElement("canvas");
    offscreen.width = rw;
    offscreen.height = rh;
    const offctx = offscreen.getContext("2d");
    const image = offctx.createImageData(rw, rh);
    const count = Math.max(1, Math.min(4, Number(s.color_count) || 1));
    const colors = Array.from({ length: count }, (_, i) => hexToRgb(s[`color_${i + 1}`]));
    const theta = Number(s.angle) * Math.PI / 180;
    const vx = Math.cos(theta), vy = Math.sin(theta);
    const cx = clamp(s.center_x, 0, 1), cy = clamp(s.center_y, 0, 1);
    const linearValues = [0, vx, vy, vx + vy];
    const linearMin = Math.min(...linearValues), linearMax = Math.max(...linearValues);
    const reflectedMax = maxCornerMetric(cx, cy, (x,y) => Math.abs(x * vx + y * vy));
    const radialMax = maxCornerMetric(cx, cy, (x,y) => Math.hypot(x,y));
    const diamondMax = maxCornerMetric(cx, cy, (x,y) => Math.abs(x) + Math.abs(y));
    const tau = Math.PI * 2;

    for (let y = 0; y < rh; y++) {
        const ny = rh > 1 ? y / (rh - 1) : 0;
        for (let x = 0; x < rw; x++) {
            const nx = rw > 1 ? x / (rw - 1) : 0;
            const dx = nx - cx, dy = ny - cy;
            let t = 0;
            switch (s.fill_mode) {
                case "linear": t = (nx * vx + ny * vy - linearMin) / Math.max(1e-6, linearMax - linearMin); break;
                case "reflected": t = Math.abs(dx * vx + dy * vy) / reflectedMax; break;
                case "radial": t = Math.hypot(dx,dy) / radialMax; break;
                case "diamond": t = (Math.abs(dx) + Math.abs(dy)) / diamondMax; break;
                case "angular": t = ((Math.atan2(dy,dx) - theta) % tau + tau) % tau / tau; break;
                case "solid": default: t = 0;
            }
            t = clamp(t, 0, 1);
            if (s.invert && s.fill_mode !== "solid") t = 1 - t;
            const [r,g,b] = interpolateColors(colors, t);
            const offset = (y * rw + x) * 4;
            image.data[offset] = r; image.data[offset + 1] = g; image.data[offset + 2] = b; image.data[offset + 3] = 255;
        }
    }
    offctx.putImageData(image, 0, 0);
    return offscreen;
}

function draw() {
    drawRaf = 0;
    settings = readForm();
    const { width, height } = resizeCanvas();
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#090d12";
    ctx.fillRect(0, 0, width, height);

    const margin = 22;
    const scale = Math.max(.0001, Math.min((width - margin * 2) / settings.width, (height - margin * 2) / settings.height));
    const boardW = Math.max(1, settings.width * scale);
    const boardH = Math.max(1, settings.height * scale);
    const bx = (width - boardW) / 2;
    const by = (height - boardH) / 2;
    lastBoard = { x: bx, y: by, w: boardW, h: boardH };
    canvasInfo.textContent = `${settings.width} × ${settings.height}`;

    const rendered = renderGradient(boardW, boardH, settings);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(rendered, bx, by, boardW, boardH);

    if (settings.inner_border_px > 0 && settings.border_opacity > 0) {
        const border = Math.min(boardW / 2, boardH / 2, settings.inner_border_px * scale);
        ctx.save();
        ctx.strokeStyle = rgba(settings.border_color, settings.border_opacity);
        ctx.lineWidth = border;
        ctx.strokeRect(bx + border / 2, by + border / 2, boardW - border, boardH - border);
        ctx.restore();
    }

    ctx.strokeStyle = "rgba(255,255,255,.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + .5, by + .5, boardW - 1, boardH - 1);

    if (["radial", "angular", "reflected", "diamond"].includes(settings.fill_mode)) {
        const px = bx + settings.center_x * boardW;
        const py = by + settings.center_y * boardH;
        ctx.save();
        ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = "white"; ctx.stroke();
        ctx.restore();
    }
}

function scheduleDraw() {
    updateLabels();
    if (!drawRaf) drawRaf = requestAnimationFrame(draw);
}

function updateCenterFromPointer(event) {
    if (!lastBoard) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    fields.center_x.value = clamp((x - lastBoard.x) / lastBoard.w, 0, 1).toFixed(2);
    fields.center_y.value = clamp((y - lastBoard.y) / lastBoard.h, 0, 1).toFixed(2);
    scheduleDraw();
}
canvas.addEventListener("pointerdown", event => {
    if (!["radial", "angular", "reflected", "diamond"].includes(fields.fill_mode.value)) return;
    draggingCenter = true;
    canvas.setPointerCapture(event.pointerId);
    updateCenterFromPointer(event);
});
canvas.addEventListener("pointermove", event => { if (draggingCenter) updateCenterFromPointer(event); });
canvas.addEventListener("pointerup", event => { draggingCenter = false; canvas.releasePointerCapture?.(event.pointerId); });
canvas.addEventListener("pointercancel", () => { draggingCenter = false; });

async function readJsonResponse(response) {
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
}
async function refreshPresets(preferred = currentPreset) {
    try {
        const payload = await readJsonResponse(await fetch("/orion4d/gradient_presets", { cache: "no-store" }));
        const names = Array.isArray(payload.presets) ? payload.presets : [];
        presetSelect.replaceChildren(new Option("— Preset —", ""));
        for (const name of names) presetSelect.add(new Option(name, name));
        currentPreset = names.includes(preferred) ? preferred : "";
        presetSelect.value = currentPreset;
    } catch (error) { statusEl.textContent = `Preset error — ${error.message}`; }
}
async function loadPreset(name) {
    if (!name) { currentPreset = ""; return; }
    try {
        const payload = await readJsonResponse(await fetch(`/orion4d/gradient_presets/${encodeURIComponent(name)}`, { cache: "no-store" }));
        currentPreset = payload.name || name;
        writeForm(payload.data || DEFAULTS);
        statusEl.textContent = `Preset loaded — ${currentPreset}`;
    } catch (error) { statusEl.textContent = `Preset error — ${error.message}`; }
}
async function savePreset(name, overwrite = false) {
    const cleanName = String(name || "").trim();
    if (!cleanName) return;
    if (overwrite && !window.confirm(`Overwrite preset “${cleanName}”?`)) return;
    try {
        const payload = await readJsonResponse(await fetch("/orion4d/gradient_presets/save", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: cleanName, data: readForm() }),
        }));
        currentPreset = payload.name || cleanName;
        await refreshPresets(currentPreset);
        statusEl.textContent = `Preset saved — ${currentPreset}`;
    } catch (error) { statusEl.textContent = `Preset error — ${error.message}`; }
}
async function savePresetAs() {
    const name = window.prompt("Preset name:", currentPreset || "New Gradient");
    if (name) await savePreset(name, false);
}
async function deletePreset() {
    const name = presetSelect.value;
    if (!name || !window.confirm(`Delete preset “${name}”?`)) return;
    try {
        await readJsonResponse(await fetch("/orion4d/gradient_presets/delete", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
        }));
        currentPreset = "";
        await refreshPresets();
        statusEl.textContent = `Preset deleted — ${name}`;
    } catch (error) { statusEl.textContent = `Preset error — ${error.message}`; }
}

function apply() {
    const applied = bridge?.applySettings?.(nodeId, readForm());
    if (applied) { writeForm(applied); statusEl.textContent = "Settings applied to ComfyUI"; }
    else statusEl.textContent = "Unable to reach the ComfyUI node";
}

for (const key of Object.keys(DEFAULTS)) {
    fields[key]?.addEventListener("input", scheduleDraw);
    fields[key]?.addEventListener("change", scheduleDraw);
}
for (let index = 1; index <= 4; index++) {
    const color = fields[`color_${index}`];
    const text = fields[`color_${index}_text`];
    color.addEventListener("input", () => { text.value = color.value.toUpperCase(); scheduleDraw(); });
    text.addEventListener("change", () => { color.value = normalizeHex(text.value, "#FFFFFF"); text.value = color.value; scheduleDraw(); });
}
fields.border_color.addEventListener("input", () => { fields.border_color_text.value = fields.border_color.value.toUpperCase(); scheduleDraw(); });
fields.border_color_text.addEventListener("change", () => { fields.border_color.value = normalizeHex(fields.border_color_text.value, "#FFFFFF"); fields.border_color_text.value = fields.border_color.value; scheduleDraw(); });

presetSelect.addEventListener("change", () => loadPreset(presetSelect.value));
document.querySelector("#savePreset").addEventListener("click", () => currentPreset ? savePreset(currentPreset, true) : savePresetAs());
document.querySelector("#savePresetAs").addEventListener("click", savePresetAs);
document.querySelector("#deletePreset").addEventListener("click", deletePreset);
document.querySelector("#applySettings").addEventListener("click", apply);
document.querySelector("#applyClose").addEventListener("click", () => { apply(); window.close(); });
document.querySelector("#resetSettings").addEventListener("click", () => writeForm(bridge?.resetSettings?.(nodeId) || DEFAULTS));
document.querySelector("#closeApp").addEventListener("click", () => window.close());

const resizeObserver = new ResizeObserver(() => {
    const nextWidth = Math.max(1, Math.floor(stage.clientWidth));
    const nextHeight = Math.max(1, Math.floor(stage.clientHeight));
    if (nextWidth !== viewportWidth || nextHeight !== viewportHeight) scheduleDraw();
});
resizeObserver.observe(stage);
window.addEventListener("resize", scheduleDraw, { passive: true });

refreshPresets();
if (!window.opener || !bridge || !Number.isFinite(nodeId)) {
    statusEl.textContent = "Open this application from the Gradient Fill node";
    writeForm(DEFAULTS);
} else {
    const state = bridge.getState(nodeId);
    if (!state) {
        statusEl.textContent = "Gradient Fill node not found";
        writeForm(DEFAULTS);
    } else {
        document.title = `${state.title} — Orion4D`;
        statusEl.textContent = "Connected to ComfyUI";
        writeForm(state.settings);
    }
}
