/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HSV to CIE xy conversion, ported from zigbee-herdsman-converters lib/color.js
 * (ColorHSV.toRGB + ColorRGB.gammaCorrected + ColorRGB.toXY, Philips wide-gamut matrix).
 *
 * Home Assistant's MQTT JSON light only understands the short color keys (h/s, x/y, r/g/b),
 * and its color wheel works best from x/y; zigbee2mqtt ships x/y alongside hue/saturation in
 * its state for the same reason.
 */

/** hue 0-360, saturation 0-100 (zigbee2mqtt MQTT API scale) to CIE 1931 xy. */
export function hsvToXY(hue: number, saturation: number): { x: number; y: number } {
    // HSV -> RGB (value = 100%)
    const h = (((hue % 360) + 360) % 360) / 360;
    const s = Math.min(100, Math.max(0, saturation)) / 100;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = 1 - s;
    const q = 1 - f * s;
    const t = 1 - (1 - f) * s;
    let r: number, g: number, b: number;
    switch (i % 6) {
        case 0:
            [r, g, b] = [1, t, p];
            break;
        case 1:
            [r, g, b] = [q, 1, p];
            break;
        case 2:
            [r, g, b] = [p, 1, t];
            break;
        case 3:
            [r, g, b] = [p, q, 1];
            break;
        case 4:
            [r, g, b] = [t, p, 1];
            break;
        default:
            [r, g, b] = [1, p, q];
            break;
    }

    // inverse sRGB gamma
    const gamma = (v: number) => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92);
    r = gamma(r);
    g = gamma(g);
    b = gamma(b);

    // RGB -> XYZ, Philips wide-gamut D65 matrix (as used by zigbee-herdsman-converters)
    const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
    const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
    const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;

    const sum = X + Y + Z;
    if (sum === 0) {
        return { x: 0, y: 0 };
    }
    const round4 = (v: number) => Math.round(v * 10000) / 10000;
    return { x: round4(X / sum), y: round4(Y / sum) };
}
