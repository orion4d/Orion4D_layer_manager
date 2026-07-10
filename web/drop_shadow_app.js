const DEFAULTS = {
    canvas_width: 1024, canvas_height: 1024, scale_percent: -15,
    shadow_mode: "outer", shadow_spread: 0, shadow_blur: 24,
    shadow_offset_x: 24, shadow_offset_y: 24, shadow_opacity: 0.55,
    shadow_color: "#000000", background_mode: "transparent", background_color: "#FFFFFF",
};

const nodeId = Number(new URLSearchParams(location.search).get("nodeId"));
const bridge = window.opener?.__orion4dDropShadowBridge;
const canvas = document.querySelector("#previewCanvas");
const ctx = canvas.getContext("2d");
const stage = document.querySelector(".preview-stage");
const statusEl = document.querySelector("#status");
const canvasInfo = document.querySelector("#canvasInfo");
const emptyMessage = document.querySelector("#emptyMessage");
const backgroundColorRow = document.querySelector("#backgroundColorRow");
const presetSelect = document.querySelector("#presetSelect");
const savePresetButton = document.querySelector("#savePreset");
const savePresetAsButton = document.querySelector("#savePresetAs");
const deletePresetButton = document.querySelector("#deletePreset");
let currentPreset = "";

const ids = Object.keys(DEFAULTS);
const fields = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
fields.shadow_color_text = document.getElementById("shadow_color_text");
fields.background_color_text = document.getElementById("background_color_text");
let settings = { ...DEFAULTS };
let sourceImage = null;
let sourceUrl = null;
let drawRaf = 0;
let imagePollTimer = 0;
let viewportWidth = 0;
let viewportHeight = 0;

function normalizeHex(value, fallback) {
    let text = String(value || "").trim();
    if (!text.startsWith("#")) text = `#${text}`;
    if (/^#[0-9a-f]{3}$/i.test(text)) text = `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
    return /^#[0-9a-f]{6}$/i.test(text) ? text.toUpperCase() : fallback;
}

function readForm() {
    return {
        canvas_width: Number(fields.canvas_width.value),
        canvas_height: Number(fields.canvas_height.value),
        scale_percent: Number(fields.scale_percent.value),
        shadow_mode: fields.shadow_mode.value,
        shadow_spread: Number(fields.shadow_spread.value),
        shadow_blur: Number(fields.shadow_blur.value),
        shadow_offset_x: Number(fields.shadow_offset_x.value),
        shadow_offset_y: Number(fields.shadow_offset_y.value),
        shadow_opacity: Number(fields.shadow_opacity.value),
        shadow_color: normalizeHex(fields.shadow_color_text.value, "#000000"),
        background_mode: fields.background_mode.value,
        background_color: normalizeHex(fields.background_color_text.value, "#FFFFFF"),
    };
}

function writeForm(next) {
    settings = { ...DEFAULTS, ...next };
    for (const id of ids) if (fields[id]) fields[id].value = settings[id];
    fields.shadow_color_text.value = normalizeHex(settings.shadow_color, "#000000");
    fields.shadow_color.value = fields.shadow_color_text.value;
    fields.background_color_text.value = normalizeHex(settings.background_color, "#FFFFFF");
    fields.background_color.value = fields.background_color_text.value;
    updateLabels();
    scheduleDraw();
}

function updateLabels() {
    document.querySelector('[data-for="scale_percent"]').textContent = `${Number(fields.scale_percent.value).toFixed(1)}%`;
    document.querySelector('[data-for="shadow_spread"]').textContent = `${fields.shadow_spread.value}px`;
    document.querySelector('[data-for="shadow_blur"]').textContent = `${Number(fields.shadow_blur.value).toFixed(1)}px`;
    document.querySelector('[data-for="shadow_opacity"]').textContent = `${Math.round(Number(fields.shadow_opacity.value) * 100)}%`;
    backgroundColorRow.style.opacity = fields.background_mode.value === "transparent" ? "0.45" : "1";
}

function checkerboard(x, y, w, h) {
    const size = 14;
    for (let py = y; py < y + h; py += size) {
        for (let px = x; px < x + w; px += size) {
            const even = ((Math.floor((px - x) / size) + Math.floor((py - y) / size)) % 2) === 0;
            ctx.fillStyle = even ? "#cbd2da" : "#eef1f4";
            ctx.fillRect(px, py, Math.min(size, x + w - px), Math.min(size, y + h - py));
        }
    }
}

function resizeCanvas() {
    // The canvas must never influence the layout of its own parent.
    // CSS keeps it absolutely positioned; only its backing buffer is resized here.
    const width = Math.max(1, Math.floor(stage.clientWidth));
    const height = Math.max(1, Math.floor(stage.clientHeight));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const bufferWidth = Math.max(1, Math.round(width * dpr));
    const bufferHeight = Math.max(1, Math.round(height * dpr));

    if (canvas.width !== bufferWidth || canvas.height !== bufferHeight) {
        canvas.width = bufferWidth;
        canvas.height = bufferHeight;
    }

    viewportWidth = width;
    viewportHeight = height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width, height };
}

function draw() {
    drawRaf = 0;
    settings = readForm();
    const { width, height } = resizeCanvas();
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#090d12";
    ctx.fillRect(0, 0, width, height);

    const cw = Math.max(1, settings.canvas_width);
    const ch = Math.max(1, settings.canvas_height);
    const margin = 22;
    const availableWidth = Math.max(1, width - margin * 2);
    const availableHeight = Math.max(1, height - margin * 2);
    const scale = Math.max(0.0001, Math.min(availableWidth / cw, availableHeight / ch));
    const boardW = Math.max(1, cw * scale);
    const boardH = Math.max(1, ch * scale);
    const bx = (width - boardW) / 2;
    const by = (height - boardH) / 2;
    canvasInfo.textContent = `${cw} × ${ch}`;

    ctx.save();
    ctx.beginPath(); ctx.rect(bx, by, boardW, boardH); ctx.clip();
    if (settings.background_mode === "transparent") checkerboard(bx, by, boardW, boardH);
    else { ctx.fillStyle = settings.background_color; ctx.fillRect(bx, by, boardW, boardH); }

    if (sourceImage) {
        const objectScale = Math.max(.01, 1 + settings.scale_percent / 100);
        const drawW = sourceImage.naturalWidth * objectScale * scale;
        const drawH = sourceImage.naturalHeight * objectScale * scale;
        const x = bx + (boardW - drawW) / 2;
        const y = by + (boardH - drawH) / 2;
        const ox = settings.shadow_offset_x * scale;
        const oy = settings.shadow_offset_y * scale;
        const blur = settings.shadow_blur * scale;
        const spread = settings.shadow_spread * scale;

        if (settings.shadow_mode === "outer") {
            ctx.save();
            ctx.shadowColor = hexToRgba(settings.shadow_color, settings.shadow_opacity);
            ctx.shadowBlur = Math.max(0, blur + spread * 1.5);
            ctx.shadowOffsetX = ox;
            ctx.shadowOffsetY = oy;
            ctx.drawImage(sourceImage, x, y, drawW, drawH);
            ctx.restore();
            ctx.drawImage(sourceImage, x, y, drawW, drawH);
        } else {
            ctx.drawImage(sourceImage, x, y, drawW, drawH);
            ctx.save();
            ctx.globalCompositeOperation = "source-atop";
            ctx.filter = `blur(${Math.max(0, blur)}px)`;
            ctx.globalAlpha = settings.shadow_opacity;
            ctx.drawImage(sourceImage, x + ox, y + oy, drawW, drawH);
            ctx.globalCompositeOperation = "source-in";
            ctx.fillStyle = settings.shadow_color;
            ctx.fillRect(x - blur, y - blur, drawW + blur * 2, drawH + blur * 2);
            ctx.restore();
        }
    }
    ctx.restore();
    ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1; ctx.strokeRect(bx + .5, by + .5, boardW - 1, boardH - 1);
    emptyMessage.hidden = Boolean(sourceImage);
}

function hexToRgba(hex, alpha) {
    const value = normalizeHex(hex, "#000000").slice(1);
    return `rgba(${parseInt(value.slice(0,2),16)},${parseInt(value.slice(2,4),16)},${parseInt(value.slice(4,6),16)},${alpha})`;
}

function scheduleDraw() {
    updateLabels();
    if (!drawRaf) drawRaf = requestAnimationFrame(draw);
}

function normalizeSourceUrl(url) {
    const raw = String(url || "");
    if (!raw) return "";
    try {
        const parsed = new URL(raw, window.location.href);
        // Ignore cache-busting parameters added by ComfyUI or this application.
        for (const key of ["orion_t", "t", "timestamp", "cache", "cb", "rand"]) {
            parsed.searchParams.delete(key);
        }
        return `${parsed.pathname}?${parsed.searchParams.toString()}`.replace(/\?$/, "");
    } catch {
        return raw
            .replace(/([?&])(orion_t|t|timestamp|cache|cb|rand)=[^&]*/gi, "$1")
            .replace(/[?&]+$/, "")
            .replace(/\?&/, "?");
    }
}

function loadImage(url, force = false) {
    const nextUrl = url || null;
    const cleanNext = normalizeSourceUrl(nextUrl);
    const cleanCurrent = normalizeSourceUrl(sourceUrl);
    if (!force && cleanNext && cleanNext === cleanCurrent && sourceImage) return;

    sourceUrl = nextUrl;
    if (!nextUrl) {
        sourceImage = null;
        statusEl.textContent = "Connected — waiting for an input preview";
        scheduleDraw();
        return;
    }

    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
        sourceImage = image;
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
        const cleanNext = normalizeSourceUrl(next);
        const cleanCurrent = normalizeSourceUrl(sourceUrl);
        if (cleanNext !== cleanCurrent) loadImage(next, true);
        else if (!sourceImage && next) loadImage(next, false);
    }, 1000);
}

window.addEventListener("beforeunload", () => {
    if (imagePollTimer) clearInterval(imagePollTimer);
});

async function readJsonResponse(response) {
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
}

async function refreshPresets(preferred = currentPreset) {
    try {
        const payload = await readJsonResponse(await fetch("/orion4d/drop_shadow_presets", { cache: "no-store" }));
        const names = Array.isArray(payload.presets) ? payload.presets : [];
        presetSelect.replaceChildren(new Option("— Preset —", ""));
        for (const name of names) presetSelect.add(new Option(name, name));
        const selected = names.includes(preferred) ? preferred : "";
        presetSelect.value = selected;
        currentPreset = selected;
    } catch (error) {
        console.error("[Orion4D] Unable to list shadow presets:", error);
        statusEl.textContent = `Preset error — ${error.message}`;
    }
}

async function loadPreset(name) {
    if (!name) { currentPreset = ""; return; }
    try {
        const payload = await readJsonResponse(await fetch(`/orion4d/drop_shadow_presets/${encodeURIComponent(name)}`, { cache: "no-store" }));
        currentPreset = payload.name || name;
        writeForm(payload.data || DEFAULTS);
        presetSelect.value = currentPreset;
        statusEl.textContent = `Preset loaded — ${currentPreset}`;
    } catch (error) {
        console.error("[Orion4D] Unable to load shadow preset:", error);
        statusEl.textContent = `Preset error — ${error.message}`;
    }
}

async function savePreset(name, overwrite = false) {
    const cleanName = String(name || "").trim();
    if (!cleanName) return;
    if (overwrite && !window.confirm(`Overwrite preset “${cleanName}”?`)) return;
    try {
        const payload = await readJsonResponse(await fetch("/orion4d/drop_shadow_presets/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: cleanName, data: readForm() }),
        }));
        currentPreset = payload.name || cleanName;
        await refreshPresets(currentPreset);
        statusEl.textContent = `Preset saved — ${currentPreset}`;
    } catch (error) {
        console.error("[Orion4D] Unable to save shadow preset:", error);
        statusEl.textContent = `Preset error — ${error.message}`;
    }
}

async function savePresetAs() {
    const proposed = currentPreset || "Soft Shadow";
    const name = window.prompt("Preset name:", proposed);
    if (!name) return;
    await savePreset(name, false);
}

async function deletePreset() {
    const name = presetSelect.value;
    if (!name) return;
    if (!window.confirm(`Delete preset “${name}”?`)) return;
    try {
        await readJsonResponse(await fetch("/orion4d/drop_shadow_presets/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        }));
        currentPreset = "";
        await refreshPresets("");
        statusEl.textContent = `Preset deleted — ${name}`;
    } catch (error) {
        console.error("[Orion4D] Unable to delete shadow preset:", error);
        statusEl.textContent = `Preset error — ${error.message}`;
    }
}

function apply() {
    const next = readForm();
    const applied = bridge?.applySettings?.(nodeId, next);
    if (applied) { writeForm(applied); statusEl.textContent = "Settings applied to ComfyUI"; }
    else statusEl.textContent = "Unable to reach the ComfyUI node";
}

for (const field of Object.values(fields)) {
    field?.addEventListener("input", scheduleDraw);
    field?.addEventListener("change", scheduleDraw);
}
fields.shadow_color.addEventListener("input", () => { fields.shadow_color_text.value = fields.shadow_color.value.toUpperCase(); scheduleDraw(); });
fields.shadow_color_text.addEventListener("change", () => { fields.shadow_color.value = normalizeHex(fields.shadow_color_text.value, "#000000"); fields.shadow_color_text.value = fields.shadow_color.value; scheduleDraw(); });
fields.background_color.addEventListener("input", () => { fields.background_color_text.value = fields.background_color.value.toUpperCase(); scheduleDraw(); });
fields.background_color_text.addEventListener("change", () => { fields.background_color.value = normalizeHex(fields.background_color_text.value, "#FFFFFF"); fields.background_color_text.value = fields.background_color.value; scheduleDraw(); });

presetSelect.addEventListener("change", () => loadPreset(presetSelect.value));
savePresetButton.addEventListener("click", () => currentPreset ? savePreset(currentPreset, true) : savePresetAs());
savePresetAsButton.addEventListener("click", savePresetAs);
deletePresetButton.addEventListener("click", deletePreset);
document.querySelector("#applySettings").addEventListener("click", apply);
document.querySelector("#applyClose").addEventListener("click", () => { apply(); window.close(); });
document.querySelector("#closeApp").addEventListener("click", () => window.close());
document.querySelector("#resetSettings").addEventListener("click", () => writeForm(bridge?.resetSettings?.(nodeId) || DEFAULTS));
document.querySelector("#refreshImage").addEventListener("click", () => loadImage(bridge?.refreshImage?.(nodeId), true));
const resizeObserver = new ResizeObserver(() => {
    const nextWidth = Math.max(1, Math.floor(stage.clientWidth));
    const nextHeight = Math.max(1, Math.floor(stage.clientHeight));
    if (nextWidth !== viewportWidth || nextHeight !== viewportHeight) scheduleDraw();
});
resizeObserver.observe(stage);
window.addEventListener("resize", scheduleDraw, { passive: true });

refreshPresets();

if (!window.opener || !bridge || !Number.isFinite(nodeId)) {
    statusEl.textContent = "Open this application from the Drop Shadow node";
    writeForm(DEFAULTS);
} else {
    const state = bridge.getState(nodeId);
    if (!state) {
        statusEl.textContent = "Drop Shadow node not found";
        writeForm(DEFAULTS);
    } else {
        document.title = `${state.title} — Orion4D`;
        writeForm(state.settings);
        loadImage(state.imageSrc, true);
        startImagePolling();
    }
}
