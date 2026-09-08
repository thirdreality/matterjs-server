/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { hexToRgb, hslToHsv, type Rgb, type Xy } from "./ColorMath.js";

/**
 * A `color` payload normalized to exactly one color space, mirroring zigbee-herdsman-converters
 * `Color.fromConverterArg`: HSV components may be partial (hue or saturation alone is meaningful),
 * RGB and xy are always complete.
 */
export type ParsedColor =
    | {
          kind: "hsv";
          hue?: number;
          saturation?: number;
          /** HSV value 0-100. zigbee2mqtt maps it to the light level, not to the color. */
          value?: number;
          /** Hue move direction, passed through for hue-only commands. */
          direction?: number;
      }
    | { kind: "rgb"; rgb: Rgb }
    | { kind: "xy"; xy: Xy };

function numberOf(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

/** Split the comma-separated forms (`"255,0,0"`), which zigbee2mqtt parses as integers. */
function tripleOf(value: unknown): [number, number, number] | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const parts = value.split(",").map(part => parseInt(part, 10));
    if (parts.length !== 3 || parts.some(part => Number.isNaN(part))) {
        return undefined;
    }
    return [parts[0], parts[1], parts[2]];
}

function rgbOf(r: unknown, g: unknown, b: unknown): ParsedColor | undefined {
    const red = numberOf(r);
    const green = numberOf(g);
    const blue = numberOf(b);
    if (red === undefined || green === undefined || blue === undefined) {
        return undefined;
    }
    const scale = (component: number) => Math.min(1, Math.max(0, component / 255));
    return { kind: "rgb", rgb: { r: scale(red), g: scale(green), b: scale(blue) } };
}

function hsvOf(hue: unknown, saturation: unknown, value: unknown, direction: unknown): ParsedColor | undefined {
    const given = (component: unknown) => component !== undefined && component !== null;
    const parsed = {
        kind: "hsv" as const,
        hue: numberOf(hue),
        saturation: numberOf(saturation),
        value: numberOf(value),
        direction: numberOf(direction),
    };
    // A form that named a component we could not read is an error, not a partial color
    if (
        (given(hue) && parsed.hue === undefined) ||
        (given(saturation) && parsed.saturation === undefined) ||
        (given(value) && parsed.value === undefined)
    ) {
        return undefined;
    }
    if (parsed.hue === undefined && parsed.saturation === undefined) {
        return undefined;
    }
    return parsed;
}

/**
 * Normalize a `color` payload, following the exact precedence of zigbee-herdsman-converters
 * `Color.fromConverterArg`:
 *
 * `{x,y}`, `{r,g,b}`, `{rgb:"r,g,b"}`, `{hex}`, `"#RRGGBB"`, `{h,s,l}`, `{hsl:"h,s,l"}`,
 * `{h,s,b}`, `{hsb:"h,s,b"}`, `{h,s,v}`, `{hsv:"h,s,v"}`, `{h,s}`, `{h}`, `{s}`,
 * `{hue,saturation}`.
 *
 * Returns undefined for anything else, including forms whose components are not numbers.
 */
export function parseColorInput(input: unknown): ParsedColor | undefined {
    if (typeof input === "string") {
        const rgb = hexToRgb(input);
        return input.trim().startsWith("#") && rgb !== undefined ? { kind: "rgb", rgb } : undefined;
    }
    if (typeof input !== "object" || input === null) {
        return undefined;
    }
    const color = input as Record<string, unknown>;
    const { x, y, r, g, b, h, s, l, v, hue, saturation, direction } = color;
    // zigbee2mqtt's checks are null-tolerant, so an explicit null falls through to the next form
    const has = (value: unknown) => value !== undefined && value !== null;

    if (has(x) && has(y)) {
        const parsedX = numberOf(x);
        const parsedY = numberOf(y);
        return parsedX === undefined || parsedY === undefined
            ? undefined
            : { kind: "xy", xy: { x: parsedX, y: parsedY } };
    }
    if (has(r) && has(g) && has(b)) {
        return rgbOf(r, g, b);
    }
    if (has(color.rgb)) {
        const triple = tripleOf(color.rgb);
        return triple === undefined ? undefined : rgbOf(...triple);
    }
    if (has(color.hex)) {
        const rgb = typeof color.hex === "string" ? hexToRgb(color.hex) : undefined;
        return rgb === undefined ? undefined : { kind: "rgb", rgb };
    }
    if (has(h) && has(s) && has(l)) {
        return fromHsl(numberOf(h), numberOf(s), numberOf(l), direction);
    }
    if (has(color.hsl)) {
        const triple = tripleOf(color.hsl);
        return triple === undefined ? undefined : fromHsl(triple[0], triple[1], triple[2], direction);
    }
    // {h,s,b}: zigbee2mqtt treats "b" as the HSV value when hue and saturation are present
    if (has(h) && has(s) && has(b)) {
        return hsvOf(h, s, b, direction);
    }
    if (has(color.hsb)) {
        const triple = tripleOf(color.hsb);
        return triple === undefined ? undefined : hsvOf(triple[0], triple[1], triple[2], direction);
    }
    if (has(h) && has(s) && has(v)) {
        return hsvOf(h, s, v, direction);
    }
    if (has(color.hsv)) {
        const triple = tripleOf(color.hsv);
        return triple === undefined ? undefined : hsvOf(triple[0], triple[1], triple[2], direction);
    }
    if (has(h) || has(s)) {
        return hsvOf(h, s, undefined, direction);
    }
    if (has(hue) || has(saturation)) {
        return hsvOf(hue, saturation, undefined, direction);
    }
    return undefined;
}

function fromHsl(
    hue: number | undefined,
    saturation: number | undefined,
    lightness: number | undefined,
    direction: unknown,
): ParsedColor | undefined {
    if (hue === undefined || saturation === undefined || lightness === undefined) {
        return undefined;
    }
    const hsv = hslToHsv(hue, saturation, lightness);
    return hsvOf(hsv.hue, hsv.saturation, hsv.value, direction);
}
