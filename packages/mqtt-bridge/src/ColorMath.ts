/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Color space conversions, ported from zigbee-herdsman-converters lib/color.js so the MQTT API
 * accepts the same color forms as zigbee2mqtt (ColorRGB/ColorXY/ColorHSV, Philips wide-gamut matrix).
 *
 * Deviation: zigbee2mqtt linearizes ("gamma corrects") RGB before the matrix but not HSV, which makes
 * the same color land on different xy depending on the form it arrived in. We linearize on both paths
 * — the matrix expects linear RGB — so our HSV to xy fallback can differ slightly from z2m's for
 * unsaturated colors. Fully saturated primaries are identical either way.
 */

/** RGB components, each 0..1. */
export interface Rgb {
    r: number;
    g: number;
    b: number;
}

/** CIE 1931 xy chromaticity, each 0..1. */
export interface Xy {
    x: number;
    y: number;
}

/** hue 0-360, saturation 0-100, value 0-100 (the zigbee2mqtt MQTT API scale). */
export interface Hsv {
    hue: number;
    saturation: number;
    value: number;
}

const round4 = (value: number): number => Math.round(value * 10000) / 10000;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** sRGB to linear RGB, which is what the wide-gamut matrix expects. */
function linearize(value: number): number {
    return value > 0.04045 ? ((value + 0.055) / 1.055) ** 2.4 : value / 12.92;
}

/** Linear RGB to CIE xy, Wide RGB D65 matrix (as used by zigbee-herdsman-converters). */
function linearRgbToXY({ r, g, b }: Rgb): Xy {
    const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
    const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
    const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
    const sum = X + Y + Z;
    if (sum === 0) {
        return { x: 0, y: 0 };
    }
    return { x: round4(X / sum), y: round4(Y / sum) };
}

/** hue 0-360, saturation 0-100 to RGB at full value. */
export function hsvToRgb(hue: number, saturation: number, value = 100): Rgb {
    const h = ((((hue % 360) + 360) % 360) / 360) * 6;
    const s = clamp(saturation, 0, 100) / 100;
    const v = clamp(value, 0, 100) / 100;
    const i = Math.floor(h);
    const f = h - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0:
            return { r: v, g: t, b: p };
        case 1:
            return { r: q, g: v, b: p };
        case 2:
            return { r: p, g: v, b: t };
        case 3:
            return { r: p, g: q, b: v };
        case 4:
            return { r: t, g: p, b: v };
        default:
            return { r: v, g: p, b: q };
    }
}

/** hue 0-360, saturation 0-100 to CIE xy. */
export function hsvToXY(hue: number, saturation: number): Xy {
    return rgbToXY(hsvToRgb(hue, saturation));
}

/** RGB (0..1 components) to CIE xy. */
export function rgbToXY(rgb: Rgb): Xy {
    return linearRgbToXY({ r: linearize(rgb.r), g: linearize(rgb.g), b: linearize(rgb.b) });
}

/** RGB (0..1 components) to hue 0-360 / saturation 0-100 / value 0-100. */
export function rgbToHsv({ r, g, b }: Rgb): Hsv {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue: number;
    if (delta === 0) {
        hue = 0;
    } else if (max === r) {
        hue = (g - b + delta * (g < b ? 6 : 0)) / (6 * delta);
    } else if (max === g) {
        hue = (b - r + delta * 2) / (6 * delta);
    } else {
        hue = (r - g + delta * 4) / (6 * delta);
    }
    return {
        hue: round4(hue * 360),
        saturation: round4(max === 0 ? 0 : (delta / max) * 100),
        value: round4(max * 100),
    };
}

/** HSL (hue 0-360, saturation/lightness 0-100) to HSV. */
export function hslToHsv(hue: number, saturation: number, lightness: number): Hsv {
    const value = (saturation * Math.min(lightness, 100 - lightness)) / 100 + lightness;
    return {
        hue,
        saturation: value === 0 ? 0 : round4(200 * (1 - lightness / value)),
        value: round4(value),
    };
}

/** `#RRGGBB` (or bare `RRGGBB`) to RGB, or undefined when the string is not a hex color. */
export function hexToRgb(hex: string): Rgb | undefined {
    const digits = hex.trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(digits)) {
        return undefined;
    }
    const value = parseInt(digits, 16);
    return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255 };
}

/** CIE xy to RGB at full brightness (zigbee-herdsman-converters ColorXY.toRGB). */
export function xyToRgb({ x, y }: Xy): Rgb {
    const z = 1 - x - y;
    const Y = 1;
    const X = (Y / y) * x;
    const Z = (Y / y) * z;
    let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
    let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
    let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
    // Scale back into range rather than clipping, which would shift the hue
    const max = Math.max(r, g, b);
    if (max > 1) {
        r /= max;
        g /= max;
        b /= max;
    }
    const sane = (value: number) => (Number.isNaN(value) || value < 0 ? 0 : value);
    return { r: sane(r), g: sane(g), b: sane(b) };
}

/** CIE xy to hue 0-360 / saturation 0-100 (value carries no chromaticity information). */
export function xyToHsv(xy: Xy): Hsv {
    return rgbToHsv(xyToRgb(xy));
}
