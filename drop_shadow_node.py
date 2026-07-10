import json
import math
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F


try:
    from aiohttp import web
    from server import PromptServer
except Exception:  # pragma: no cover
    web = None
    PromptServer = None


ROOT_DIR = Path(__file__).resolve().parent
PRESETS_DIR = ROOT_DIR / "presets_shadows"
PRESETS_DIR.mkdir(parents=True, exist_ok=True)

PRESET_KEYS = {
    "canvas_width", "canvas_height", "scale_percent", "shadow_mode",
    "shadow_spread", "shadow_blur", "shadow_offset_x", "shadow_offset_y",
    "shadow_opacity", "shadow_color", "background_mode", "background_color",
}


def _safe_preset_name(value):
    value = str(value or "").strip()
    if not value:
        return ""
    for ch in '<>:"/\\|?*':
        value = value.replace(ch, "_")
    value = value.replace("..", "_")
    return value[:120].strip().rstrip(".")


def _preset_path(name):
    safe = _safe_preset_name(name)
    if not safe:
        raise ValueError("Preset name is empty")
    return PRESETS_DIR / f"{safe}.json"


def _clean_preset_data(data):
    if not isinstance(data, dict):
        raise ValueError("Preset data must be a JSON object")
    return {key: data[key] for key in PRESET_KEYS if key in data}


def _normalize_hex(value, fallback="#000000"):
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


def _hex_to_rgb01(value, fallback="#000000"):
    value = _normalize_hex(value, fallback)
    raw = value[1:]
    return np.array([
        int(raw[0:2], 16),
        int(raw[2:4], 16),
        int(raw[4:6], 16),
    ], dtype=np.float32) / 255.0


def _resize_image_and_alpha(rgb, alpha, scale_factor):
    h, w = rgb.shape[:2]
    new_w = max(1, int(round(w * scale_factor)))
    new_h = max(1, int(round(h * scale_factor)))

    img_t = torch.from_numpy(np.ascontiguousarray(rgb)).permute(2, 0, 1).unsqueeze(0).float()
    alpha_t = torch.from_numpy(np.ascontiguousarray(alpha)).unsqueeze(0).unsqueeze(0).float()

    img_t = F.interpolate(img_t, size=(new_h, new_w), mode="bilinear", align_corners=False)
    alpha_t = F.interpolate(alpha_t, size=(new_h, new_w), mode="bilinear", align_corners=False)

    rgb_resized = img_t.squeeze(0).permute(1, 2, 0).cpu().numpy().astype(np.float32)
    alpha_resized = alpha_t.squeeze(0).squeeze(0).cpu().numpy().astype(np.float32)
    return rgb_resized, np.clip(alpha_resized, 0.0, 1.0)


def _place_center(canvas_h, canvas_w, item, fill_value=0.0):
    if item.ndim == 3:
        out = np.full((canvas_h, canvas_w, item.shape[2]), fill_value, dtype=np.float32)
        item_h, item_w = item.shape[:2]
    else:
        out = np.full((canvas_h, canvas_w), fill_value, dtype=np.float32)
        item_h, item_w = item.shape

    dst_x0 = max(0, (canvas_w - item_w) // 2)
    dst_y0 = max(0, (canvas_h - item_h) // 2)
    dst_x1 = min(canvas_w, dst_x0 + item_w)
    dst_y1 = min(canvas_h, dst_y0 + item_h)

    src_x0 = max(0, (item_w - canvas_w) // 2)
    src_y0 = max(0, (item_h - canvas_h) // 2)
    src_x1 = src_x0 + (dst_x1 - dst_x0)
    src_y1 = src_y0 + (dst_y1 - dst_y0)

    if item.ndim == 3:
        out[dst_y0:dst_y1, dst_x0:dst_x1, :] = item[src_y0:src_y1, src_x0:src_x1, :]
    else:
        out[dst_y0:dst_y1, dst_x0:dst_x1] = item[src_y0:src_y1, src_x0:src_x1]
    return out


def _shift_mask(mask, offset_x, offset_y):
    h, w = mask.shape
    out = np.zeros_like(mask)

    src_x0 = max(0, -offset_x)
    src_y0 = max(0, -offset_y)
    src_x1 = min(w, w - offset_x) if offset_x >= 0 else w
    src_y1 = min(h, h - offset_y) if offset_y >= 0 else h

    dst_x0 = max(0, offset_x)
    dst_y0 = max(0, offset_y)
    dst_x1 = dst_x0 + max(0, src_x1 - src_x0)
    dst_y1 = dst_y0 + max(0, src_y1 - src_y0)

    if src_x1 > src_x0 and src_y1 > src_y0 and dst_x1 > dst_x0 and dst_y1 > dst_y0:
        out[dst_y0:dst_y1, dst_x0:dst_x1] = mask[src_y0:src_y1, src_x0:src_x1]
    return out


def _gaussian_blur(mask, blur_px):
    blur_px = float(max(0.0, blur_px))
    if blur_px <= 0.0:
        return mask.astype(np.float32)

    sigma = max(0.5, blur_px * 0.35)
    radius = max(1, int(math.ceil(sigma * 3.0)))
    x = torch.arange(-radius, radius + 1, dtype=torch.float32)
    kernel = torch.exp(-(x * x) / (2.0 * sigma * sigma))
    kernel = kernel / kernel.sum()

    t = torch.from_numpy(mask.astype(np.float32)).unsqueeze(0).unsqueeze(0)
    kx = kernel.view(1, 1, 1, -1)
    ky = kernel.view(1, 1, -1, 1)

    t = F.pad(t, (radius, radius, 0, 0), mode="constant", value=0.0)
    t = F.conv2d(t, kx)
    t = F.pad(t, (0, 0, radius, radius), mode="constant", value=0.0)
    t = F.conv2d(t, ky)
    return t.squeeze(0).squeeze(0).cpu().numpy().astype(np.float32)


def _dilate_mask(mask, spread_px):
    spread_px = int(max(0, spread_px))
    if spread_px <= 0:
        return mask.astype(np.float32)
    k = spread_px * 2 + 1
    t = torch.from_numpy(mask.astype(np.float32)).unsqueeze(0).unsqueeze(0)
    t = F.max_pool2d(t, kernel_size=k, stride=1, padding=spread_px)
    return t.squeeze(0).squeeze(0).cpu().numpy().astype(np.float32)


def _composite_layers(bg_rgb, bg_alpha, shadow_rgb, shadow_alpha, obj_rgb, obj_alpha):
    bg_p = bg_rgb * bg_alpha[..., None]
    sh_p = shadow_rgb[None, None, :] * shadow_alpha[..., None]
    under_p = sh_p + bg_p * (1.0 - shadow_alpha[..., None])
    under_a = shadow_alpha + bg_alpha * (1.0 - shadow_alpha)

    obj_p = obj_rgb * obj_alpha[..., None]
    out_p = obj_p + under_p * (1.0 - obj_alpha[..., None])
    out_a = obj_alpha + under_a * (1.0 - obj_alpha)

    out_rgb = np.zeros_like(obj_rgb, dtype=np.float32)
    mask = out_a > 1e-6
    out_rgb[mask] = out_p[mask] / out_a[mask, None]
    return np.clip(out_rgb, 0.0, 1.0), np.clip(out_a, 0.0, 1.0)


class Orion4D_DropShadow:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "canvas_width": ("INT", {"default": 1024, "min": 1, "max": 8192, "step": 1}),
                "canvas_height": ("INT", {"default": 1024, "min": 1, "max": 8192, "step": 1}),
                "scale_percent": ("FLOAT", {"default": -15.0, "min": -99.0, "max": 500.0, "step": 0.1}),
                "shadow_mode": (["outer", "inner"], {"default": "outer"}),
                "shadow_spread": ("INT", {"default": 0, "min": 0, "max": 256, "step": 1}),
                "shadow_blur": ("FLOAT", {"default": 24.0, "min": 0.0, "max": 256.0, "step": 0.5}),
                "shadow_offset_x": ("INT", {"default": 24, "min": -4096, "max": 4096, "step": 1}),
                "shadow_offset_y": ("INT", {"default": 24, "min": -4096, "max": 4096, "step": 1}),
                "shadow_opacity": ("FLOAT", {"default": 0.55, "min": 0.0, "max": 1.0, "step": 0.01}),
                "shadow_color": ("STRING", {"default": "#000000"}),
                "background_mode": (["transparent", "color"], {"default": "transparent"}),
                "background_color": ("STRING", {"default": "#FFFFFF"}),
            },
            "optional": {
                "mask": ("MASK",),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE", "IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask", "rgba_image", "shadow_rgba", "shadow_mask")
    FUNCTION = "apply_shadow"
    CATEGORY = "Orion4D_Layer"

    def apply_shadow(
        self,
        image,
        canvas_width,
        canvas_height,
        scale_percent,
        shadow_mode,
        shadow_spread,
        shadow_blur,
        shadow_offset_x,
        shadow_offset_y,
        shadow_opacity,
        shadow_color,
        background_mode,
        background_color,
        mask=None,
    ):
        canvas_w = max(1, int(canvas_width))
        canvas_h = max(1, int(canvas_height))
        scale_factor = max(0.01, 1.0 + float(scale_percent) / 100.0)
        sh_color = _hex_to_rgb01(shadow_color, "#000000")
        bg_color = _hex_to_rgb01(background_color, "#FFFFFF")
        bg_mode = background_mode if background_mode in ["transparent", "color"] else "transparent"
        sh_mode = shadow_mode if shadow_mode in ["outer", "inner"] else "outer"
        shadow_opacity = float(max(0.0, min(float(shadow_opacity), 1.0)))
        spread = int(max(0, shadow_spread))

        batch = image.shape[0]
        out_images = []
        out_masks = []
        out_rgba = []
        out_shadow_rgba = []
        out_shadow_masks = []

        mask_batch = None
        if mask is not None:
            mask_batch = mask
            if len(mask_batch.shape) == 2:
                mask_batch = mask_batch.unsqueeze(0)

        for i in range(batch):
            img = image[i].detach().cpu().numpy().astype(np.float32)
            rgb = np.clip(img[..., :3], 0.0, 1.0)

            if mask_batch is not None:
                mi = min(i, mask_batch.shape[0] - 1)
                alpha = 1.0 - np.clip(mask_batch[mi].detach().cpu().numpy().astype(np.float32), 0.0, 1.0)
            elif img.shape[-1] >= 4:
                alpha = np.clip(img[..., 3], 0.0, 1.0)
            else:
                alpha = np.ones(rgb.shape[:2], dtype=np.float32)

            rgb_scaled, alpha_scaled = _resize_image_and_alpha(rgb, alpha, scale_factor)
            rgb_canvas = _place_center(canvas_h, canvas_w, rgb_scaled, 0.0)
            alpha_canvas = _place_center(canvas_h, canvas_w, alpha_scaled, 0.0)

            if sh_mode == "outer":
                shadow_seed = _dilate_mask(alpha_canvas, spread)
                shadow_seed = _shift_mask(shadow_seed, int(shadow_offset_x), int(shadow_offset_y))
                shadow_alpha = _gaussian_blur(shadow_seed, float(shadow_blur)) * shadow_opacity
                shadow_alpha = np.clip(shadow_alpha, 0.0, 1.0)
            else:
                inner_seed = _dilate_mask(alpha_canvas, spread)
                inner_seed = _shift_mask(inner_seed, int(shadow_offset_x), int(shadow_offset_y))
                inner_seed = alpha_canvas * (1.0 - inner_seed)
                shadow_alpha = _gaussian_blur(inner_seed, float(shadow_blur)) * shadow_opacity
                shadow_alpha = np.clip(shadow_alpha * alpha_canvas, 0.0, 1.0)

            # Full RGBA output: keep true transparency if requested.
            if bg_mode == "color":
                bg_alpha_rgba = np.ones((canvas_h, canvas_w), dtype=np.float32)
                bg_rgb_rgba = np.broadcast_to(bg_color.reshape(1, 1, 3), (canvas_h, canvas_w, 3)).copy().astype(np.float32)
            else:
                bg_alpha_rgba = np.zeros((canvas_h, canvas_w), dtype=np.float32)
                bg_rgb_rgba = np.zeros((canvas_h, canvas_w, 3), dtype=np.float32)

            out_rgb_rgba, out_alpha = _composite_layers(bg_rgb_rgba, bg_alpha_rgba, sh_color, shadow_alpha, rgb_canvas, alpha_canvas)
            rgba = np.concatenate([out_rgb_rgba, out_alpha[..., None]], axis=-1)

            # Visible RGB output always uses the background color as backdrop.
            bg_alpha_rgb = np.ones((canvas_h, canvas_w), dtype=np.float32)
            bg_rgb_rgb = np.broadcast_to(bg_color.reshape(1, 1, 3), (canvas_h, canvas_w, 3)).copy().astype(np.float32)
            out_rgb_visible, _ = _composite_layers(bg_rgb_rgb, bg_alpha_rgb, sh_color, shadow_alpha, rgb_canvas, alpha_canvas)

            shadow_rgba = np.concatenate([
                np.broadcast_to(sh_color.reshape(1, 1, 3), (canvas_h, canvas_w, 3)).copy().astype(np.float32),
                shadow_alpha[..., None]
            ], axis=-1)

            out_images.append(torch.from_numpy(np.ascontiguousarray(out_rgb_visible)).unsqueeze(0))
            out_masks.append(torch.from_numpy(np.ascontiguousarray(out_alpha)).unsqueeze(0))
            out_rgba.append(torch.from_numpy(np.ascontiguousarray(rgba)).unsqueeze(0))
            out_shadow_rgba.append(torch.from_numpy(np.ascontiguousarray(shadow_rgba)).unsqueeze(0))
            out_shadow_masks.append(torch.from_numpy(np.ascontiguousarray(shadow_alpha)).unsqueeze(0))

        return (
            torch.cat(out_images, dim=0),
            torch.cat(out_masks, dim=0),
            torch.cat(out_rgba, dim=0),
            torch.cat(out_shadow_rgba, dim=0),
            torch.cat(out_shadow_masks, dim=0),
        )


NODE_CLASS_MAPPINGS = {
    "Orion4D_DropShadow": Orion4D_DropShadow,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Orion4D_DropShadow": "🌑 Drop Shadow",
}


if PromptServer is not None and web is not None:
    @PromptServer.instance.routes.get("/orion4d/drop_shadow_presets")
    async def orion4d_drop_shadow_presets_list(request):
        presets = sorted(
            (path.stem for path in PRESETS_DIR.glob("*.json")),
            key=str.casefold,
        )
        return web.json_response({"presets": presets})


    @PromptServer.instance.routes.get("/orion4d/drop_shadow_presets/{name}")
    async def orion4d_drop_shadow_preset_load(request):
        try:
            path = _preset_path(request.match_info.get("name", ""))
            if not path.exists():
                return web.json_response({"error": "Preset not found"}, status=404)
            data = json.loads(path.read_text(encoding="utf-8"))
            return web.json_response({"name": path.stem, "data": _clean_preset_data(data)})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)


    @PromptServer.instance.routes.post("/orion4d/drop_shadow_presets/save")
    async def orion4d_drop_shadow_preset_save(request):
        try:
            payload = await request.json()
            path = _preset_path(payload.get("name", ""))
            data = _clean_preset_data(payload.get("data", {}))
            path.write_text(
                json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            return web.json_response({"ok": True, "name": path.stem})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)


    @PromptServer.instance.routes.post("/orion4d/drop_shadow_presets/delete")
    async def orion4d_drop_shadow_preset_delete(request):
        try:
            payload = await request.json()
            path = _preset_path(payload.get("name", ""))
            if path.exists():
                path.unlink()
            return web.json_response({"ok": True, "name": path.stem})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)
