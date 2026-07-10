import json
import math
from pathlib import Path

import numpy as np
import torch

try:
    from aiohttp import web
    from server import PromptServer
except Exception:  # pragma: no cover
    web = None
    PromptServer = None


ROOT_DIR = Path(__file__).resolve().parent
PRESETS_DIR = ROOT_DIR / "presets_gradients"
PRESETS_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_SETTINGS = {
    "width": 1024,
    "height": 1024,
    "fill_mode": "solid",
    "color_count": "1",
    "color_1": "#FFFFFF",
    "color_2": "#FFFFFF",
    "color_3": "#FFFFFF",
    "color_4": "#FFFFFF",
    "invert": False,
    "angle": 0.0,
    "center_x": 0.5,
    "center_y": 0.5,
    "inner_border_px": 0,
    "border_color": "#FFFFFF",
    "border_opacity": 1.0,
}


def _safe_preset_name(value: str) -> str:
    value = str(value or "").strip()
    if not value:
        return ""
    forbidden = '<>:"/\\|?*'
    for ch in forbidden:
        value = value.replace(ch, "_")
    value = value.replace("..", "_")
    return value[:120].strip()


def _preset_path(name: str) -> Path:
    safe = _safe_preset_name(name)
    if not safe:
        raise ValueError("Preset name is empty")
    return PRESETS_DIR / f"{safe}.json"


def _normalize_hex(value, fallback="#FFFFFF"):
    value = str(value or "").strip()
    if not value.startswith("#"):
        value = "#" + value
    raw = value[1:]
    try:
        if len(raw) == 3:
            raw = "".join(ch * 2 for ch in raw)
        if len(raw) != 6:
            raise ValueError("invalid hex length")
        int(raw, 16)
        return f"#{raw.upper()}"
    except Exception:
        return fallback.upper()


def _hex_to_rgb01(value, fallback="#FFFFFF"):
    value = _normalize_hex(value, fallback)
    raw = value[1:]
    return np.array([
        int(raw[0:2], 16),
        int(raw[2:4], 16),
        int(raw[4:6], 16),
    ], dtype=np.float32) / 255.0


def _active_colors(color_count, color_1, color_2, color_3, color_4):
    try:
        count = int(str(color_count).strip())
    except Exception:
        count = 2
    count = max(1, min(count, 4))

    colors_hex = [
        _normalize_hex(color_1, "#FFFFFF"),
        _normalize_hex(color_2, "#FF7A18"),
        _normalize_hex(color_3, "#FFFFFF"),
        _normalize_hex(color_4, "#111827"),
    ][:count]

    colors_rgb = np.stack([_hex_to_rgb01(c) for c in colors_hex], axis=0)
    return colors_hex, colors_rgb


def _interpolate_stops(t, colors_rgb):
    t = np.clip(t.astype(np.float32), 0.0, 1.0)
    if len(colors_rgb) == 1:
        return np.broadcast_to(colors_rgb[0].reshape(1, 1, 3), (*t.shape, 3)).copy().astype(np.float32)

    scaled = t * (len(colors_rgb) - 1)
    idx = np.floor(scaled).astype(np.int32)
    idx = np.clip(idx, 0, len(colors_rgb) - 2)
    frac = (scaled - idx).astype(np.float32)

    c0 = colors_rgb[idx]
    c1 = colors_rgb[idx + 1]
    return (c0 * (1.0 - frac[..., None]) + c1 * frac[..., None]).astype(np.float32)


class Orion4D_GradientFillV2:
    MODES = ["solid", "linear", "radial", "angular", "reflected", "diamond"]
    COLOR_COUNTS = ["1", "2", "3", "4"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {"default": DEFAULT_SETTINGS["width"], "min": 1, "max": 8192, "step": 1}),
                "height": ("INT", {"default": DEFAULT_SETTINGS["height"], "min": 1, "max": 8192, "step": 1}),
                "fill_mode": (cls.MODES, {"default": DEFAULT_SETTINGS["fill_mode"]}),
                "color_count": (cls.COLOR_COUNTS, {"default": DEFAULT_SETTINGS["color_count"]}),
                "color_1": ("STRING", {"default": DEFAULT_SETTINGS["color_1"]}),
                "color_2": ("STRING", {"default": DEFAULT_SETTINGS["color_2"]}),
                "color_3": ("STRING", {"default": DEFAULT_SETTINGS["color_3"]}),
                "color_4": ("STRING", {"default": DEFAULT_SETTINGS["color_4"]}),
                "invert": ("BOOLEAN", {"default": DEFAULT_SETTINGS["invert"]}),
                "angle": ("FLOAT", {"default": DEFAULT_SETTINGS["angle"], "min": 0.0, "max": 360.0, "step": 1.0}),
                "center_x": ("FLOAT", {"default": DEFAULT_SETTINGS["center_x"], "min": 0.0, "max": 1.0, "step": 0.01}),
                "center_y": ("FLOAT", {"default": DEFAULT_SETTINGS["center_y"], "min": 0.0, "max": 1.0, "step": 0.01}),
                "inner_border_px": ("INT", {"default": DEFAULT_SETTINGS["inner_border_px"], "min": 0, "max": 200, "step": 1}),
                "border_color": ("STRING", {"default": DEFAULT_SETTINGS["border_color"]}),
                "border_opacity": ("FLOAT", {"default": DEFAULT_SETTINGS["border_opacity"], "min": 0.0, "max": 1.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "MASK", "STRING")
    RETURN_NAMES = ("image", "full_mask", "border_mask", "settings_json")
    FUNCTION = "generate"
    CATEGORY = "Orion4D_Layer"

    def generate(
        self,
        width,
        height,
        fill_mode,
        color_count,
        color_1,
        color_2,
        color_3,
        color_4,
        invert,
        angle,
        center_x,
        center_y,
        inner_border_px,
        border_color,
        border_opacity,
    ):
        w = max(1, int(width))
        h = max(1, int(height))
        mode = fill_mode if fill_mode in self.MODES else "linear"

        colors_hex, colors_rgb = _active_colors(color_count, color_1, color_2, color_3, color_4)
        border_color_hex = _normalize_hex(border_color, "#FFFFFF")
        border_rgb = _hex_to_rgb01(border_color_hex)

        cx = float(max(0.0, min(float(center_x), 1.0)))
        cy = float(max(0.0, min(float(center_y), 1.0)))
        theta = math.radians(float(angle) % 360.0)
        border = int(max(0, min(int(inner_border_px), 200)))
        opacity = float(max(0.0, min(float(border_opacity), 1.0)))
        inv = bool(invert)

        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        nx = xx / (w - 1) if w > 1 else np.zeros((h, w), dtype=np.float32)
        ny = yy / (h - 1) if h > 1 else np.zeros((h, w), dtype=np.float32)
        dx = nx - cx
        dy = ny - cy

        if mode == "solid" or len(colors_rgb) == 1:
            img = np.broadcast_to(colors_rgb[0].reshape(1, 1, 3), (h, w, 3)).copy().astype(np.float32)
        else:
            vx = math.cos(theta)
            vy = math.sin(theta)

            if mode == "linear":
                proj = nx * vx + ny * vy
                mn = float(proj.min())
                mx = float(proj.max())
                t = (proj - mn) / max(mx - mn, 1e-6)
            elif mode == "reflected":
                proj = dx * vx + dy * vy
                t = np.abs(proj) / max(float(np.max(np.abs(proj))), 1e-6)
            elif mode == "radial":
                dist = np.sqrt(dx * dx + dy * dy)
                corners = np.array([[0.0 - cx, 0.0 - cy], [1.0 - cx, 0.0 - cy], [0.0 - cx, 1.0 - cy], [1.0 - cx, 1.0 - cy]], dtype=np.float32)
                t = dist / max(float(np.sqrt((corners * corners).sum(axis=1)).max()), 1e-6)
            elif mode == "diamond":
                dist = np.abs(dx) + np.abs(dy)
                corners = np.array([[0.0 - cx, 0.0 - cy], [1.0 - cx, 0.0 - cy], [0.0 - cx, 1.0 - cy], [1.0 - cx, 1.0 - cy]], dtype=np.float32)
                t = dist / max(float((np.abs(corners[:, 0]) + np.abs(corners[:, 1])).max()), 1e-6)
            elif mode == "angular":
                ang = np.arctan2(dy, dx) - theta
                t = np.mod(ang, 2.0 * math.pi) / (2.0 * math.pi)
            else:
                t = np.zeros((h, w), dtype=np.float32)

            t = np.clip(t, 0.0, 1.0).astype(np.float32)
            if inv:
                t = 1.0 - t
            img = _interpolate_stops(t, colors_rgb)

        full_mask = np.ones((h, w), dtype=np.float32)
        border_mask = np.zeros((h, w), dtype=np.float32)

        if border > 0:
            bx = min(border, w)
            by = min(border, h)
            border_mask[:by, :] = 1.0
            border_mask[h - by:, :] = 1.0
            border_mask[:, :bx] = 1.0
            border_mask[:, w - bx:] = 1.0
            if opacity > 0.0:
                alpha = border_mask[..., None] * opacity
                img = img * (1.0 - alpha) + border_rgb.reshape(1, 1, 3) * alpha

        image_tensor = torch.from_numpy(np.ascontiguousarray(img.astype(np.float32))).unsqueeze(0)
        full_mask_tensor = torch.from_numpy(full_mask).unsqueeze(0)
        border_mask_tensor = torch.from_numpy(border_mask).unsqueeze(0)

        settings = {
            "width": w,
            "height": h,
            "fill_mode": mode,
            "color_count": str(len(colors_hex)),
            "color_1": colors_hex[0] if len(colors_hex) > 0 else DEFAULT_SETTINGS["color_1"],
            "color_2": colors_hex[1] if len(colors_hex) > 1 else DEFAULT_SETTINGS["color_2"],
            "color_3": colors_hex[2] if len(colors_hex) > 2 else DEFAULT_SETTINGS["color_3"],
            "color_4": colors_hex[3] if len(colors_hex) > 3 else DEFAULT_SETTINGS["color_4"],
            "invert": inv,
            "angle": float(angle),
            "center_x": cx,
            "center_y": cy,
            "inner_border_px": border,
            "border_color": border_color_hex,
            "border_opacity": opacity,
        }

        return (
            image_tensor,
            full_mask_tensor,
            border_mask_tensor,
            json.dumps(settings, ensure_ascii=False),
        )


NODE_CLASS_MAPPINGS = {
    "Orion4D_GradientFillV2": Orion4D_GradientFillV2,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Orion4D_GradientFillV2": "🎨 Fill / Gradient Generator v2",
}


if PromptServer is not None and web is not None:
    @PromptServer.instance.routes.get("/orion4d/gradient_presets")
    async def orion4d_gradient_presets_list(request):
        presets = sorted(p.stem for p in PRESETS_DIR.glob("*.json"))
        return web.json_response({"presets": presets, "directory": str(PRESETS_DIR)})


    @PromptServer.instance.routes.get("/orion4d/gradient_presets/{name}")
    async def orion4d_gradient_presets_get(request):
        name = request.match_info.get("name", "")
        try:
            path = _preset_path(name)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)
        if not path.exists():
            return web.json_response({"error": "Preset not found"}, status=404)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            return web.json_response({"error": f"Invalid preset file: {e}"}, status=500)
        return web.json_response({"name": path.stem, "data": data})


    @PromptServer.instance.routes.post("/orion4d/gradient_presets/save")
    async def orion4d_gradient_presets_save(request):
        payload = await request.json()
        name = payload.get("name", "")
        data = payload.get("data", {})
        try:
            path = _preset_path(name)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)
        merged = dict(DEFAULT_SETTINGS)
        if isinstance(data, dict):
            merged.update(data)
        path.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
        return web.json_response({"ok": True, "name": path.stem})


    @PromptServer.instance.routes.post("/orion4d/gradient_presets/delete")
    async def orion4d_gradient_presets_delete(request):
        payload = await request.json()
        name = payload.get("name", "")
        try:
            path = _preset_path(name)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)
        if path.exists():
            path.unlink()
        return web.json_response({"ok": True, "name": path.stem})
