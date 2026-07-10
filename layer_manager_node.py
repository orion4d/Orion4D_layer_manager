from __future__ import annotations

import json
import math
import os
import uuid
from typing import Any, Tuple

import numpy as np
import torch
from PIL import Image



NODE_ID = "Orion4D_LayerManager"
DISPLAY_NAME = "🧩 Layer Manager"
CATEGORY = "Orion4D_Layer"
MAX_LAYERS = 20


def _first_image(img_tensor: torch.Tensor | None) -> torch.Tensor | None:
    if img_tensor is None:
        return None
    t = img_tensor.detach()
    if t.dim() == 4:
        t = t[0]
    if t.dim() != 3:
        return None
    return t


def tensor_image_to_pil_rgba(img_tensor: torch.Tensor | None) -> Image.Image | None:
    t = _first_image(img_tensor)
    if t is None:
        return None
    arr = (t.clamp(0, 1).cpu().numpy() * 255.0).round().astype(np.uint8)
    if arr.ndim != 3:
        return None

    c = arr.shape[-1]
    if c == 1:
        rgb = np.repeat(arr, 3, axis=2)
        alpha = np.full((*arr.shape[:2], 1), 255, dtype=np.uint8)
        arr = np.concatenate([rgb, alpha], axis=2)
    elif c == 2:
        gray = np.repeat(arr[:, :, :1], 3, axis=2)
        alpha = arr[:, :, 1:2]
        arr = np.concatenate([gray, alpha], axis=2)
    elif c == 3:
        alpha = np.full((*arr.shape[:2], 1), 255, dtype=np.uint8)
        arr = np.concatenate([arr, alpha], axis=2)
    else:
        arr = arr[:, :, :4]
    return Image.fromarray(arr, mode="RGBA")


def tensor_mask_to_pil_l(mask_tensor: torch.Tensor | None, width: int, height: int, invert: bool = False) -> Image.Image | None:
    if mask_tensor is None:
        return None
    mt = mask_tensor.detach()
    if mt.dim() == 4:
        mt = mt[0]
    if mt.dim() == 3:
        if mt.shape[-1] == 1:
            mt = mt[:, :, 0]
        else:
            mt = mt[0]
    if mt.dim() != 2:
        return None

    arr = mt.clamp(0, 1).cpu().numpy().astype(np.float32)
    if invert:
        arr = 1.0 - arr
    arr = (arr * 255.0).round().clip(0, 255).astype(np.uint8)
    pil = Image.fromarray(arr, mode="L")
    if pil.size != (width, height):
        pil = pil.resize((width, height), Image.BICUBIC)
    return pil


def apply_external_mask_to_rgba(layer_rgba: Image.Image, mask_tensor: torch.Tensor | None, invert_mask: bool) -> Image.Image:
    mask = tensor_mask_to_pil_l(mask_tensor, layer_rgba.width, layer_rgba.height, invert=invert_mask)
    if mask is None:
        return layer_rgba
    arr = np.asarray(layer_rgba, dtype=np.uint8).copy()
    mask_arr = np.asarray(mask, dtype=np.float32) / 255.0
    arr[:, :, 3] = (arr[:, :, 3].astype(np.float32) * mask_arr).round().clip(0, 255).astype(np.uint8)
    return Image.fromarray(arr, mode="RGBA")


def pil_rgba_to_tensors(pil_img: Image.Image) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    rgba = np.asarray(pil_img.convert("RGBA"), dtype=np.float32) / 255.0
    rgb = torch.from_numpy(rgba[:, :, :3])[None, ...]
    rgba_t = torch.from_numpy(rgba)[None, ...]
    alpha = torch.from_numpy(rgba[:, :, 3])[None, ...]
    return rgb, rgba_t, alpha


def pil_rgb_tensor(pil_img: Image.Image) -> torch.Tensor:
    arr = np.asarray(pil_img.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]


def parse_bg(bg_hex: str) -> tuple[int, int, int, int]:
    if not isinstance(bg_hex, str):
        return 255, 255, 255, 255
    s = bg_hex.strip()
    if s.lower() in {"transparent", "none", "alpha", "rgba"}:
        return 0, 0, 0, 0
    hx = s.lstrip("#")
    if len(hx) == 3:
        hx = "".join(ch * 2 for ch in hx) + "FF"
    elif len(hx) == 4:
        hx = "".join(ch * 2 for ch in hx)
    elif len(hx) == 6:
        hx += "FF"
    if len(hx) != 8:
        return 255, 255, 255, 255
    try:
        return tuple(int(hx[i:i+2], 16) for i in (0, 2, 4, 6))  # type: ignore[return-value]
    except ValueError:
        return 255, 255, 255, 255


def visible_to_bool(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        v = value.strip().lower()
        if v in {"false", "0", "hidden", "hide", "off", "no", "disabled"}:
            return False
        if v in {"true", "1", "visible", "show", "on", "yes", "enabled"}:
            return True
        return default
    return bool(value)


def normalize_anchor(anchor: Any) -> str:
    if not isinstance(anchor, str):
        return "top_left"
    value = anchor.strip().lower()
    mapping = {
        "haut_gauche": "top_left", "top_left": "top_left", "topleft": "top_left", "upper_left": "top_left",
        "haut_droite": "top_right", "top_right": "top_right", "topright": "top_right", "upper_right": "top_right",
        "bas_gauche": "bottom_left", "bottom_left": "bottom_left", "bottomleft": "bottom_left", "lower_left": "bottom_left",
        "bas_droite": "bottom_right", "bottom_right": "bottom_right", "bottomright": "bottom_right", "lower_right": "bottom_right",
        "centre": "center", "center": "center", "middle": "center",
    }
    return mapping.get(value, "top_left")


def normalize_blend_mode(mode: Any) -> str:
    if not isinstance(mode, str):
        return "normal"
    value = mode.strip().lower().replace(" ", "_")
    allowed = {
        "normal", "multiply", "screen", "overlay", "darken", "lighten",
        "add", "subtract", "difference", "soft_light", "hard_light",
    }
    return value if value in allowed else "normal"


def _default_layer() -> dict[str, Any]:
    return {
        "name": "", "x": 0, "y": 0, "scale": 100.0, "scale_x": 100.0, "scale_y": 100.0,
        "constrain_homothety": True, "collapsed": False, "rot": 0.0, "opacity": 1.0,
        "visible": True, "edit": False, "anchor": "top_left", "blend": "normal",
    }


def parse_layer_config(layer_config: Any, kwargs: dict[str, Any]) -> dict[int, dict[str, Any]]:
    data: dict[str, Any] = {}
    if isinstance(layer_config, str) and layer_config.strip():
        try:
            data = json.loads(layer_config)
        except Exception:
            data = {}
    elif isinstance(layer_config, dict):
        data = layer_config

    out = {}
    layers_data = data.get("layers")
    
    # Extraction depuis le JSON (Indexé en base 1 désormais)
    if isinstance(layers_data, list):
        for idx, layer in enumerate(layers_data):
            if layer and isinstance(layer, dict) and idx >= 1:
                out[idx] = {
                    "x": layer.get("x", 0),
                    "y": layer.get("y", 0),
                    "scale": layer.get("scale", 100.0),
                    "scale_x": layer.get("scale_x", layer.get("scale", 100.0)),
                    "scale_y": layer.get("scale_y", layer.get("scale", 100.0)),
                    "constrain_homothety": layer.get("constrain_homothety", True),
                    "collapsed": layer.get("collapsed", False),
                    "rot": layer.get("rot", 0.0),
                    "opacity": layer.get("opacity", 1.0),
                    "visible": visible_to_bool(layer.get("visible", True), True),
                    "edit": visible_to_bool(layer.get("edit", False), False),
                    "anchor": normalize_anchor(layer.get("anchor", "top_left")),
                    "blend": normalize_blend_mode(layer.get("blend", "normal")),
                }

    # Fallback sur les kwargs
    for i in range(1, MAX_LAYERS + 1):
        p = f"L{i}_"
        if i not in out:
            if f"{p}image" in kwargs or f"{p}x" in kwargs:
                out[i] = {
                    "x": kwargs.get(f"{p}x", 0),
                    "y": kwargs.get(f"{p}y", 0),
                    "scale": kwargs.get(f"{p}scale", 100.0),
                    "scale_x": kwargs.get(f"{p}scale_x", kwargs.get(f"{p}scale", 100.0)),
                    "scale_y": kwargs.get(f"{p}scale_y", kwargs.get(f"{p}scale", 100.0)),
                    "constrain_homothety": kwargs.get(f"{p}constrain_homothety", True),
                    "collapsed": kwargs.get(f"{p}collapsed", False),
                    "rot": kwargs.get(f"{p}rot", 0.0),
                    "opacity": kwargs.get(f"{p}opacity", 1.0),
                    "visible": visible_to_bool(kwargs.get(f"{p}visible", True), True),
                    "edit": visible_to_bool(kwargs.get(f"{p}edit", False), False),
                    "anchor": normalize_anchor(kwargs.get(f"{p}anchor", "top_left")),
                    "blend": normalize_blend_mode(kwargs.get(f"{p}blend", "normal")),
                }
            else:
                out[i] = _default_layer()
                
    return out


def parse_layer_order(layer_config: Any) -> list[int]:
    data: dict[str, Any] = {}
    if isinstance(layer_config, str) and layer_config.strip():
        try:
            parsed = json.loads(layer_config)
            if isinstance(parsed, dict):
                data = parsed
        except Exception:
            data = {}
    elif isinstance(layer_config, dict):
        data = layer_config

    order: list[int] = []
    raw_order = data.get("order", [])
    if isinstance(raw_order, list):
        for item in raw_order:
            try:
                idx = int(item)
            except Exception:
                continue
            if 1 <= idx <= MAX_LAYERS and idx not in order:
                order.append(idx)
    for idx in range(1, MAX_LAYERS + 1):
        if idx not in order:
            order.append(idx)
    return order


def parse_solo_layer(layer_config: Any) -> int | None:
    data: dict[str, Any] = {}
    if isinstance(layer_config, str) and layer_config.strip():
        try:
            parsed = json.loads(layer_config)
            if isinstance(parsed, dict):
                data = parsed
        except Exception:
            data = {}
    elif isinstance(layer_config, dict):
        data = layer_config
    try:
        index = int(data.get("solo_layer"))
    except Exception:
        return None
    return index if 1 <= index <= MAX_LAYERS else None


def anchor_point(width: float, height: float, anchor: Any) -> tuple[float, float]:
    anchor = normalize_anchor(anchor)
    points = {
        "top_left": (0.0, 0.0),
        "top_right": (float(width), 0.0),
        "bottom_left": (0.0, float(height)),
        "bottom_right": (float(width), float(height)),
        "center": (float(width) / 2.0, float(height) / 2.0),
    }
    return points[anchor]


def _rotated_bounds(width: float, height: float, anchor_xy: tuple[float, float], rot_deg: float) -> tuple[float, float, float, float]:
    ax, ay = anchor_xy
    theta = math.radians(-float(rot_deg))
    cos_t = math.cos(theta)
    sin_t = math.sin(theta)
    corners = [(0.0, 0.0), (float(width), 0.0), (float(width), float(height)), (0.0, float(height))]
    xs, ys = [], []
    for x, y in corners:
        dx, dy = x - ax, y - ay
        xs.append(ax + dx * cos_t - dy * sin_t)
        ys.append(ay + dx * sin_t + dy * cos_t)
    return min(xs), min(ys), max(xs), max(ys)


def transform_layer_with_anchor(
    pil_img: Image.Image,
    scale_x_percent: float,
    scale_y_percent: float,
    rot_deg: float,
    anchor: Any,
) -> tuple[Image.Image, tuple[float, float]]:
    scale_x = max(float(scale_x_percent) / 100.0, 0.001)
    scale_y = max(float(scale_y_percent) / 100.0, 0.001)
    if abs(scale_x - 1.0) > 1e-8 or abs(scale_y - 1.0) > 1e-8:
        new_w = max(1, int(round(pil_img.width * scale_x)))
        new_h = max(1, int(round(pil_img.height * scale_y)))
        pil_img = pil_img.resize((new_w, new_h), Image.BICUBIC)

    ax, ay = anchor_point(pil_img.width, pil_img.height, anchor)
    min_x, min_y, _, _ = _rotated_bounds(pil_img.width, pil_img.height, (ax, ay), float(rot_deg))

    if abs(float(rot_deg)) > 1e-8:
        pil_img = pil_img.rotate(-float(rot_deg), expand=True, resample=Image.BICUBIC, center=(ax, ay))

    return pil_img, (ax - min_x, ay - min_y)

def transform_layer_canvas_exact(
    pil_img: Image.Image,
    canvas_width: int,
    canvas_height: int,
    x: float,
    y: float,
    scale_x_percent: float,
    scale_y_percent: float,
    rot_deg: float,
    anchor: Any,
) -> Image.Image:
    """Render a layer with the same transform order as the JS preview canvas.

    Frontend drawing order is:
        translate(x, y) -> rotate(rot) -> scale(scale_x, scale_y) -> drawImage(-anchor_x, -anchor_y)

    The previous backend implementation resized first and then used PIL.rotate(expand=True).
    That is close for simple cases, but it can drift from the browser preview when several
    rotated/scaled layers are stacked. This affine transform maps destination canvas pixels
    back to source image pixels, matching the Canvas 2D transform directly.
    """
    canvas_width = int(canvas_width)
    canvas_height = int(canvas_height)
    scale_x = max(float(scale_x_percent) / 100.0, 0.001)
    scale_y = max(float(scale_y_percent) / 100.0, 0.001)

    ax, ay = anchor_point(pil_img.width, pil_img.height, anchor)
    theta = math.radians(float(rot_deg))
    cos_t = math.cos(theta)
    sin_t = math.sin(theta)
    x = float(x)
    y = float(y)

    # PIL Image.transform expects the inverse affine matrix:
    # source_x = a * dst_x + b * dst_y + c
    # source_y = d * dst_x + e * dst_y + f
    matrix = (
        cos_t / scale_x,
        sin_t / scale_x,
        ax - (cos_t * x + sin_t * y) / scale_x,
        -sin_t / scale_y,
        cos_t / scale_y,
        ay + (sin_t * x - cos_t * y) / scale_y,
    )

    try:
        resample = Image.Resampling.BICUBIC
    except AttributeError:
        resample = Image.BICUBIC

    return pil_img.transform(
        (canvas_width, canvas_height),
        Image.AFFINE,
        matrix,
        resample=resample,
        fillcolor=(0, 0, 0, 0),
    )


def _blend_rgb(base_rgb: np.ndarray, src_rgb: np.ndarray, mode: str) -> np.ndarray:
    mode = normalize_blend_mode(mode)
    if mode == "normal":
        return src_rgb
    if mode == "multiply":
        return base_rgb * src_rgb
    if mode == "screen":
        return 1.0 - (1.0 - base_rgb) * (1.0 - src_rgb)
    if mode == "overlay":
        return np.where(base_rgb <= 0.5, 2.0 * base_rgb * src_rgb, 1.0 - 2.0 * (1.0 - base_rgb) * (1.0 - src_rgb))
    if mode == "darken":
        return np.minimum(base_rgb, src_rgb)
    if mode == "lighten":
        return np.maximum(base_rgb, src_rgb)
    if mode == "add":
        return np.clip(base_rgb + src_rgb, 0.0, 1.0)
    if mode == "subtract":
        return np.clip(base_rgb - src_rgb, 0.0, 1.0)
    if mode == "difference":
        return np.abs(base_rgb - src_rgb)
    if mode == "soft_light":
        return np.clip((1.0 - 2.0 * src_rgb) * (base_rgb ** 2) + 2.0 * src_rgb * base_rgb, 0.0, 1.0)
    if mode == "hard_light":
        return np.where(src_rgb <= 0.5, 2.0 * base_rgb * src_rgb, 1.0 - 2.0 * (1.0 - base_rgb) * (1.0 - src_rgb))
    return src_rgb


def blend_rgba_onto_canvas(canvas_rgba: Image.Image, layer_rgba: Image.Image, top_left_x: int, top_left_y: int, blend_mode: str) -> None:
    canvas_arr = np.asarray(canvas_rgba, dtype=np.float32) / 255.0
    layer_arr = np.asarray(layer_rgba, dtype=np.float32) / 255.0

    h, w = layer_arr.shape[:2]
    x0 = max(0, int(top_left_x))
    y0 = max(0, int(top_left_y))
    x1 = min(canvas_arr.shape[1], int(top_left_x) + w)
    y1 = min(canvas_arr.shape[0], int(top_left_y) + h)
    if x0 >= x1 or y0 >= y1:
        return

    lx0, ly0 = x0 - int(top_left_x), y0 - int(top_left_y)
    lx1, ly1 = lx0 + (x1 - x0), ly0 + (y1 - y0)

    base = canvas_arr[y0:y1, x0:x1, :].copy()
    src = layer_arr[ly0:ly1, lx0:lx1, :].copy()

    base_rgb, base_a = base[:, :, :3], base[:, :, 3:4]
    src_rgb, src_a = src[:, :, :3], src[:, :, 3:4]

    blended_rgb = _blend_rgb(base_rgb, src_rgb, normalize_blend_mode(blend_mode))
    effective_rgb = src_rgb * (1.0 - base_a) + blended_rgb * base_a
    out_a = src_a + base_a * (1.0 - src_a)
    premul_rgb = effective_rgb * src_a + base_rgb * base_a * (1.0 - src_a)
    out_rgb = np.divide(premul_rgb, np.maximum(out_a, 1e-6))

    canvas_arr[y0:y1, x0:x1, :] = np.clip(np.concatenate([out_rgb, out_a], axis=2), 0.0, 1.0)
    result = Image.fromarray((canvas_arr * 255.0).round().clip(0, 255).astype(np.uint8), mode="RGBA")
    canvas_rgba.paste(result)


def apply_opacity(layer_rgba: Image.Image, opacity: float) -> Image.Image:
    opacity = float(np.clip(opacity, 0.0, 1.0))
    if opacity >= 0.999:
        return layer_rgba
    arr = np.asarray(layer_rgba, dtype=np.uint8).copy()
    arr[:, :, 3] = (arr[:, :, 3].astype(np.float32) * opacity).round().clip(0, 255).astype(np.uint8)
    return Image.fromarray(arr, mode="RGBA")


def composite_rgba_over_bg(pil_img: Image.Image, bg_rgba: tuple[int, int, int, int]) -> Image.Image:
    src = np.asarray(pil_img.convert("RGBA"), dtype=np.float32) / 255.0
    bg = np.array(bg_rgba, dtype=np.float32) / 255.0
    bg_rgb = bg[:3].reshape(1, 1, 3)
    src_rgb = src[:, :, :3]
    src_a = src[:, :, 3:4]
    out_rgb = src_rgb * src_a + bg_rgb * (1.0 - src_a)
    out = np.concatenate([out_rgb, np.ones_like(src_a)], axis=2)
    return Image.fromarray((out * 255.0).round().clip(0, 255).astype(np.uint8), mode="RGBA")


def _temp_directory() -> str:
    try:
        import folder_paths  # type: ignore
        return folder_paths.get_temp_directory()
    except Exception:
        return os.path.join(os.getcwd(), "temp")


def save_layer_cache_png(layer_rgba: Image.Image, layer_index: int) -> dict[str, Any]:
    temp_dir = _temp_directory()
    os.makedirs(temp_dir, exist_ok=True)
    filename = f"orion4d_layer_cache_{uuid.uuid4().hex}_L{layer_index}.png"
    path = os.path.join(temp_dir, filename)
    layer_rgba.save(path)
    return {
        "layer": int(layer_index),
        "filename": filename,
        "subfolder": "",
        "type": "temp",
    }


def composite_layers_impl(canvas_width: int, canvas_height: int, bg_hex: str, flatten_output: bool, invert_input_masks: bool, layer_config: Any = "{}", **kwargs: Any) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, list[dict[str, Any]]]:
    canvas_width = int(np.clip(int(canvas_width), 16, 8192))
    canvas_height = int(np.clip(int(canvas_height), 16, 8192))
    canvas = Image.new("RGBA", (canvas_width, canvas_height), (0, 0, 0, 0))
    layer_cache: list[dict[str, Any]] = []

    layers_cfg = parse_layer_config(layer_config, kwargs)
    solo_layer = parse_solo_layer(layer_config)
    
    # Bottom-to-top order can be changed from the external Layer Manager app.
    for i in parse_layer_order(layer_config):
        if solo_layer is not None and i != solo_layer:
            continue
        layer = layers_cfg.get(i, {})
        if not visible_to_bool(layer.get("visible", True)):
            continue

        layer_rgba = tensor_image_to_pil_rgba(kwargs.get(f"L{i}_image"))
        if layer_rgba is None:
            continue

        layer_rgba = apply_external_mask_to_rgba(layer_rgba, kwargs.get(f"L{i}_mask"), invert_mask=bool(invert_input_masks))
        try:
            layer_cache.append(save_layer_cache_png(layer_rgba, i))
        except Exception:
            pass

        sx = layer.get("scale_x", layer.get("scale", 100.0))
        sy = layer.get("scale_y", layer.get("scale", 100.0))
        if visible_to_bool(layer.get("constrain_homothety", True)):
            sx = sy = layer.get("scale", sx)

        layer_rgba = apply_opacity(layer_rgba, layer.get("opacity", 1.0))
        transformed = transform_layer_canvas_exact(
            layer_rgba,
            canvas_width,
            canvas_height,
            layer.get("x", 0),
            layer.get("y", 0),
            sx,
            sy,
            layer.get("rot", 0.0),
            layer.get("anchor", "top_left"),
        )
        blend_rgba_onto_canvas(canvas, transformed, 0, 0, layer.get("blend", "normal"))

    straight_rgb, image_rgba, alpha = pil_rgba_to_tensors(canvas)
    if flatten_output:
        image_bg = pil_rgb_tensor(composite_rgba_over_bg(canvas, parse_bg(bg_hex)))
    else:
        image_bg = straight_rgb
    return image_bg, image_rgba, alpha, layer_cache


class LayerManagerNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "canvas_width": ("INT", {"default": 1024, "min": 16, "max": 8192, "step": 1}),
                "canvas_height": ("INT", {"default": 1024, "min": 16, "max": 8192, "step": 1}),
                "bg_hex": ("STRING", {"default": "#FFFFFF", "multiline": False}),
                "flatten_output": ("BOOLEAN", {"default": True}),
                "invert_input_masks": ("BOOLEAN", {"default": False}),
                "layer_config": ("STRING", {"default": "{}", "multiline": True}),
            },
            "optional": {
                "L1_image": ("IMAGE",),
                "L1_mask": ("MASK",),
                # Les ports L2, L3 s'ajouteront dynamiquement par kwargs.
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "MASK")
    RETURN_NAMES = ("image_bg", "image_rgba", "alpha")
    FUNCTION = "composite_layers"
    CATEGORY = CATEGORY

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def composite_layers(self, canvas_width, canvas_height, bg_hex, flatten_output=True, invert_input_masks=False, layer_config="{}", **kwargs):
        image_bg, image_rgba, alpha, layer_cache = composite_layers_impl(
            canvas_width,
            canvas_height,
            bg_hex,
            flatten_output,
            invert_input_masks,
            layer_config,
            **kwargs,
        )
        return {
            "ui": {"orion_layer_cache": layer_cache},
            "result": (image_bg, image_rgba, alpha),
        }


NODE_CLASS_MAPPINGS = {NODE_ID: LayerManagerNode}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_ID: DISPLAY_NAME}

