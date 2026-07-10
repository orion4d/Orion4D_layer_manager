import re

import torch
import torch.nn.functional as F


_ASPECT_RATIO_CHOICES = [
    'Free',
    '1:1 (Perfect Square)',
    '2:1 (Double Wide)',
    '1:2 (Split Vertical)',
    '2:3 (Classic Portrait)',
    '3:2 (Classic Landscape)',
    '3:4 (Portrait Classic)',
    '4:3 (Classic Landscape)',
    '4:5 (Artistic Frame)',
    '5:4 (Balanced Frame)',
    '5:7 (Balanced Portrait)',
    '7:5 (Elegant Landscape)',
    '5:8 (Tall Portrait)',
    '8:5 (Cinematic View)',
    '7:9 (Modern Portrait)',
    '9:7 (Artful Horizon)',
    '9:16 (Slim Vertical)',
    '16:9 (Panorama)',
    '9:19 (Tall Slim)',
    '19:9 (Cinematic Ultrawide)',
    '9:21 (Ultra Tall)',
    '21:9 (Epic Ultrawide)',
    '9:32 (Skyline)',
    '32:9 (Extreme Ultrawide)',
    '3:5 (Elegant Vertical)',
    '5:3 (Wide Horizon)',
    '2:5 (Tall Banner)',
    '5:2 (Wide Banner)',
    '1:3 (Vertical Triptych)',
    '3:1 (Horizontal Triptych)',
    '1:4 (Ultra Vertical Strip)',
    '4:1 (Ultra Wide Strip)',
    '10:16 (Poster Portrait)',
    '16:10 (Wide Monitor)',
    '10:18 (Tall Poster)',
    '18:10 (Wide Poster)',
    '11:14 (Portrait Print)',
    '14:11 (Landscape Print)',
    '11:17 (Tabloid Portrait)',
    '17:11 (Tabloid Landscape)',
    '8:11 (Letter Portrait)',
    '11:8 (Letter Landscape)',
    '8:14 (Legal Portrait)',
    '14:8 (Legal Landscape)',
    '1:1.85 (Cinema Vertical)',
    '1.85:1 (Cinema Flat)',
    '1:2.35 (Cinemascope Vertical)',
    '2.35:1 (Cinemascope)',
    '2.39:1 (Cinema Scope)',
    '2.40:1 (Cinema Wide)',
    '2.20:1 (70mm)',
    '65:24 (XPan Panorama)',
    '6:7 (Medium Format Portrait)',
    '7:6 (Medium Format Landscape)',
    '6:9 (Film Portrait)',
    '9:6 (Film Landscape)',
]

_ASPECT_RATIOS = {
    "1:1": 1.0,
    "4:5": 4.0 / 5.0,
    "3:2": 3.0 / 2.0,
    "16:9": 16.0 / 9.0,
}


class InteractiveCropNode:
    """
    Orion4D Interactive Crop - Nodes 2.0 friendly backend.

    IMAGE ComfyUI format: [B, H, W, C], float 0..1.
    The interactive preview is handled by web/interactive_crop.js.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "scale_multiplier": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.1,
                    "max": 10.0,
                    "step": 0.1,
                    "display": "number",
                    "tooltip": "Scales the cropped image and returned coordinates. 1.0 keeps the crop at source size."
                }),
                "x": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 16384,
                    "step": 1,
                    "tooltip": "Crop X position in source image pixels."
                }),
                "y": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 16384,
                    "step": 1,
                    "tooltip": "Crop Y position in source image pixels."
                }),
                "width": ("INT", {
                    "default": 512,
                    "min": 1,
                    "max": 16384,
                    "step": 1,
                    "tooltip": "Crop width in source image pixels."
                }),
                "height": ("INT", {
                    "default": 512,
                    "min": 1,
                    "max": 16384,
                    "step": 1,
                    "tooltip": "Crop height in source image pixels."
                }),
                "aspect_ratio": (_ASPECT_RATIO_CHOICES, {
                    "default": "Free",
                    "tooltip": "Interactive crop ratio. The backend also clamps the crop safely."
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "INT", "INT", "INT", "INT")
    RETURN_NAMES = (
        "cropped_image",
        "output_width",
        "output_height",
        "output_x",
        "output_y",
        "crop_width",
        "crop_height",
    )
    FUNCTION = "crop_image"
    CATEGORY = "Orion4D_Layer"
    DESCRIPTION = "Interactive crop with a Nodes 2.0 compatible DOM preview widget."

    def crop_image(self, image, scale_multiplier, x, y, width, height, aspect_ratio="Free"):
        if image is None or image.ndim != 4:
            raise ValueError("InteractiveCropNode attend une IMAGE ComfyUI au format [B, H, W, C].")

        _, orig_height, orig_width, _ = image.shape
        if orig_width <= 0 or orig_height <= 0:
            raise ValueError("InteractiveCropNode a reçu une image vide.")

        safe_x = int(max(0, min(int(x), orig_width - 1)))
        safe_y = int(max(0, min(int(y), orig_height - 1)))
        safe_width = int(max(1, min(int(width), orig_width - safe_x)))
        safe_height = int(max(1, min(int(height), orig_height - safe_y)))

        safe_width, safe_height = _fit_aspect_ratio(
            safe_width,
            safe_height,
            orig_width - safe_x,
            orig_height - safe_y,
            aspect_ratio,
        )

        cropped = image[
            :,
            safe_y:safe_y + safe_height,
            safe_x:safe_x + safe_width,
            :
        ].contiguous()

        sm = float(scale_multiplier)
        if sm <= 0:
            sm = 1.0

        output_width = max(1, int(round(orig_width * sm)))
        output_height = max(1, int(round(orig_height * sm)))
        output_x = max(0, int(round(safe_x * sm)))
        output_y = max(0, int(round(safe_y * sm)))
        crop_width = max(1, int(round(safe_width * sm)))
        crop_height = max(1, int(round(safe_height * sm)))

        # Keep the image size coherent with the returned scaled coordinates.
        # This makes Interactive Crop -> Paste Cropped Image work directly when scale_multiplier != 1.0.
        if crop_width != safe_width or crop_height != safe_height:
            cropped = _resize_bhwc(cropped, crop_width, crop_height)

        return (
            cropped.contiguous(),
            output_width,
            output_height,
            output_x,
            output_y,
            crop_width,
            crop_height,
        )


class PasteCroppedImageNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "cropped_image": ("IMAGE",),
                "canvas_width": ("INT", {
                    "default": 1024,
                    "min": 1,
                    "max": 16384,
                    "step": 1
                }),
                "canvas_height": ("INT", {
                    "default": 1024,
                    "min": 1,
                    "max": 16384,
                    "step": 1
                }),
                "x": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 16384,
                    "step": 1
                }),
                "y": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 16384,
                    "step": 1
                }),
                "background_type": (["transparent", "hex_color"], {
                    "default": "transparent"
                }),
                "hex_color": ("STRING", {
                    "default": "#000000",
                    "multiline": False
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE")
    RETURN_NAMES = ("image", "mask", "rgba_image")
    FUNCTION = "paste_image"
    CATEGORY = "Orion4D_Layer"
    DESCRIPTION = "Pastes a cropped image on a new canvas and returns RGB image, alpha mask and RGBA image."

    def paste_image(self, cropped_image, canvas_width, canvas_height, x, y, background_type="transparent", hex_color="#000000"):
        if cropped_image is None or cropped_image.ndim != 4:
            raise ValueError("PasteCroppedImageNode attend une IMAGE ComfyUI au format [B, H, W, C].")

        batch_size, crop_h, crop_w, channels = cropped_image.shape

        canvas_width = int(max(1, canvas_width))
        canvas_height = int(max(1, canvas_height))
        safe_x = int(max(0, min(int(x), canvas_width)))
        safe_y = int(max(0, min(int(y), canvas_height)))

        paste_width = int(max(0, min(crop_w, canvas_width - safe_x)))
        paste_height = int(max(0, min(crop_h, canvas_height - safe_y)))

        rgb = torch.zeros(
            (batch_size, canvas_height, canvas_width, 3),
            dtype=cropped_image.dtype,
            device=cropped_image.device,
        )

        if str(background_type) == "hex_color":
            color = _parse_hex_color(hex_color)
            bg = torch.tensor(
                color,
                dtype=cropped_image.dtype,
                device=cropped_image.device,
            ).view(1, 1, 1, 3)
            rgb[:] = bg

        mask = torch.zeros(
            (batch_size, canvas_height, canvas_width),
            dtype=cropped_image.dtype,
            device=cropped_image.device,
        )

        if paste_width > 0 and paste_height > 0:
            crop = cropped_image[:, :paste_height, :paste_width, :].clamp(0, 1)
            crop_rgb = _ensure_rgb(crop)

            if channels >= 4:
                alpha = crop[..., 3].clamp(0, 1)
            else:
                alpha = torch.ones(
                    (batch_size, paste_height, paste_width),
                    dtype=cropped_image.dtype,
                    device=cropped_image.device,
                )

            alpha_4d = alpha.unsqueeze(-1)
            dst = rgb[:, safe_y:safe_y + paste_height, safe_x:safe_x + paste_width, :]
            rgb[:, safe_y:safe_y + paste_height, safe_x:safe_x + paste_width, :] = (
                crop_rgb * alpha_4d + dst * (1.0 - alpha_4d)
            )

            mask[:, safe_y:safe_y + paste_height, safe_x:safe_x + paste_width] = alpha

        rgba = torch.zeros(
            (batch_size, canvas_height, canvas_width, 4),
            dtype=cropped_image.dtype,
            device=cropped_image.device,
        )
        rgba[..., :3] = rgb
        rgba[..., 3] = mask

        return (rgb.contiguous(), mask.contiguous(), rgba.contiguous())



def _parse_aspect_ratio(aspect_ratio):
    """Parse labels such as '16:9 (Panorama)' or '210:297 (A4 Portrait)'."""
    value = str(aspect_ratio or "Free").strip()
    if not value or value.lower().startswith("free"):
        return 0.0

    if value in _ASPECT_RATIOS:
        return float(_ASPECT_RATIOS[value])

    match = re.search(r"(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)", value)
    if not match:
        return 0.0

    w = float(match.group(1))
    h = float(match.group(2))
    if w <= 0 or h <= 0:
        return 0.0
    return w / h


def _fit_aspect_ratio(width, height, max_width, max_height, aspect_ratio):
    ratio = _parse_aspect_ratio(aspect_ratio)
    width = int(max(1, min(width, max_width)))
    height = int(max(1, min(height, max_height)))

    if not ratio:
        return width, height

    fitted_height = max(1, int(round(width / ratio)))
    if fitted_height <= max_height:
        return width, fitted_height

    fitted_width = max(1, int(round(max_height * ratio)))
    return min(fitted_width, max_width), max_height


def _resize_bhwc(image, width, height):
    # BHWC -> BCHW -> interpolate -> BHWC
    nchw = image.movedim(-1, 1)
    try:
        resized = F.interpolate(nchw, size=(height, width), mode="bilinear", align_corners=False, antialias=True)
    except TypeError:
        resized = F.interpolate(nchw, size=(height, width), mode="bilinear", align_corners=False)
    return resized.movedim(1, -1)


def _ensure_rgb(image):
    channels = image.shape[-1]
    if channels >= 3:
        return image[..., :3]
    if channels == 1:
        return image.repeat(1, 1, 1, 3)
    if channels == 2:
        return torch.cat([image[..., :2], image[..., 1:2]], dim=-1)
    raise ValueError("L'image doit contenir au moins un canal.")


def _parse_hex_color(hex_color):
    value = str(hex_color or "#000000").strip().lstrip("#")

    try:
        if len(value) == 3:
            r = int(value[0] * 2, 16)
            g = int(value[1] * 2, 16)
            b = int(value[2] * 2, 16)
        elif len(value) == 6:
            r = int(value[0:2], 16)
            g = int(value[2:4], 16)
            b = int(value[4:6], 16)
        else:
            r, g, b = 0, 0, 0
    except ValueError:
        r, g, b = 0, 0, 0

    return (r / 255.0, g / 255.0, b / 255.0)


NODE_CLASS_MAPPINGS = {
    "InteractiveCropNode": InteractiveCropNode,
    "PasteCroppedImageNode": PasteCroppedImageNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "InteractiveCropNode": "Interactive Crop",
    "PasteCroppedImageNode": "Paste Cropped Image",
}
