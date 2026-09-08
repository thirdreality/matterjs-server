/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseColorInput } from "../src/ColorInput.js";
import { hexToRgb, hslToHsv, hsvToXY, miredsToXY, rgbToHsv, rgbToXY, xyToHsv, xyToMireds } from "../src/ColorMath.js";

describe("parseColorInput", () => {
    it("takes xy first, as zigbee2mqtt does", () => {
        expect(parseColorInput({ x: 0.5, y: 0.25, h: 120, s: 50 })).to.deep.equal({
            kind: "xy",
            xy: { x: 0.5, y: 0.25 },
        });
    });

    it("reads the RGB forms", () => {
        const red = { kind: "rgb", rgb: { r: 1, g: 0, b: 0 } };
        expect(parseColorInput({ r: 255, g: 0, b: 0 })).to.deep.equal(red);
        expect(parseColorInput({ rgb: "255,0,0" })).to.deep.equal(red);
        expect(parseColorInput({ hex: "#FF0000" })).to.deep.equal(red);
        expect(parseColorInput({ hex: "ff0000" })).to.deep.equal(red);
        expect(parseColorInput("#FF0000")).to.deep.equal(red);
    });

    it("clamps RGB components to the 0-255 input range", () => {
        expect(parseColorInput({ r: 300, g: -20, b: 128 })).to.deep.equal({
            kind: "rgb",
            rgb: { r: 1, g: 0, b: 128 / 255 },
        });
    });

    it("converts HSL to HSV", () => {
        // HSL 120/100/50 is pure green
        expect(parseColorInput({ h: 120, s: 100, l: 50 })).to.deep.equal({
            kind: "hsv",
            hue: 120,
            saturation: 100,
            value: 100,
            direction: undefined,
        });
        expect(parseColorInput({ hsl: "120,100,50" })).to.deep.equal(parseColorInput({ h: 120, s: 100, l: 50 }));
    });

    it("treats the third component of hsb/hsv as the HSV value", () => {
        const expected = { kind: "hsv", hue: 120, saturation: 50, value: 80, direction: undefined };
        expect(parseColorInput({ h: 120, s: 50, v: 80 })).to.deep.equal(expected);
        expect(parseColorInput({ h: 120, s: 50, b: 80 })).to.deep.equal(expected);
        expect(parseColorInput({ hsv: "120,50,80" })).to.deep.equal(expected);
        expect(parseColorInput({ hsb: "120,50,80" })).to.deep.equal(expected);
    });

    it("accepts partial hue/saturation in both key styles", () => {
        expect(parseColorInput({ h: 120, s: 50 })).to.deep.include({ kind: "hsv", hue: 120, saturation: 50 });
        expect(parseColorInput({ hue: 120, saturation: 50 })).to.deep.include({ hue: 120, saturation: 50 });
        expect(parseColorInput({ h: 120 })).to.deep.include({ hue: 120, saturation: undefined });
        expect(parseColorInput({ s: 50 })).to.deep.include({ hue: undefined, saturation: 50 });
        expect(parseColorInput({ saturation: 50 })).to.deep.include({ saturation: 50 });
    });

    it("keeps a hue move direction", () => {
        expect(parseColorInput({ h: 90, direction: 1 })).to.deep.include({ hue: 90, direction: 1 });
    });

    it("accepts numeric strings, which HA templates produce", () => {
        expect(parseColorInput({ x: "0.5", y: "0.25" })).to.deep.equal({ kind: "xy", xy: { x: 0.5, y: 0.25 } });
        expect(parseColorInput({ h: "120", s: "50" })).to.deep.include({ hue: 120, saturation: 50 });
    });

    it("skips a form whose keys are explicitly null", () => {
        expect(parseColorInput({ x: null, y: null, h: 120, s: 50 })).to.deep.include({ kind: "hsv", hue: 120 });
    });

    it("rejects payloads that carry no readable color", () => {
        for (const input of [
            "red",
            "#GGHHII",
            5,
            null,
            undefined,
            {},
            { foo: 1 },
            { r: 1, g: 2 },
            { x: 0.5 },
            { h: "warm", s: 50 },
            { rgb: "255,0" },
            { hsl: "bad,values,here" },
            { hex: 16711680 },
        ]) {
            expect(parseColorInput(input), JSON.stringify(input)).to.equal(undefined);
        }
    });
});

describe("ColorMath", () => {
    it("converts hex to RGB and back through HSV", () => {
        expect(hexToRgb("#00FF00")).to.deep.equal({ r: 0, g: 1, b: 0 });
        expect(hexToRgb("#zzz")).to.equal(undefined);
        expect(rgbToHsv({ r: 0, g: 1, b: 0 })).to.deep.equal({ hue: 120, saturation: 100, value: 100 });
        expect(rgbToHsv({ r: 0, g: 0, b: 0 })).to.deep.equal({ hue: 0, saturation: 0, value: 0 });
    });

    it("maps HSL lightness onto HSV value", () => {
        expect(hslToHsv(120, 100, 50)).to.deep.equal({ hue: 120, saturation: 100, value: 100 });
        // Lighter than 50% desaturates in HSV
        const light = hslToHsv(120, 100, 75);
        expect(light.value).to.equal(100);
        expect(light.saturation).to.equal(50);
        expect(hslToHsv(120, 100, 0)).to.deep.equal({ hue: 120, saturation: 0, value: 0 });
    });

    it("agrees between the RGB and HSV paths for saturated primaries", () => {
        // Both paths linearize, so a fully saturated primary lands on the same point
        expect(rgbToXY({ r: 1, g: 0, b: 0 })).to.deep.equal(hsvToXY(0, 100));
        expect(rgbToXY({ r: 0, g: 1, b: 0 })).to.deep.equal(hsvToXY(120, 100));
        expect(rgbToXY({ r: 0, g: 0, b: 1 })).to.deep.equal(hsvToXY(240, 100));
    });

    it("recovers hue from xy well enough to drive a hue/saturation-only light", () => {
        for (const hue of [0, 60, 120, 180, 240, 300]) {
            const recovered = xyToHsv(hsvToXY(hue, 100));
            const delta = Math.abs(((recovered.hue - hue + 540) % 360) - 180);
            expect(delta, `hue ${hue}`).to.be.lessThan(3);
            expect(recovered.saturation, `hue ${hue}`).to.be.greaterThan(90);
        }
    });

    it("round-trips mireds through xy", () => {
        for (const mireds of [153, 250, 370, 454, 500]) {
            const recovered = xyToMireds(miredsToXY(mireds));
            expect(Math.abs(recovered - mireds), `${mireds} mireds`).to.be.lessThan(mireds * 0.05);
        }
    });

    it("places known color temperatures on the Planckian locus", () => {
        // 6500 K (154 mireds) blackbody is (0.3135, 0.3237) - close to but not the D65 daylight
        // point (0.3128, 0.3290), which sits slightly off the blackbody locus
        const cool = miredsToXY(154);
        expect(cool.x).to.be.closeTo(0.3135, 0.005);
        expect(cool.y).to.be.closeTo(0.3237, 0.005);
        // 2700 K (370 mireds), an incandescent lamp, is a true blackbody radiator
        const warm = miredsToXY(370);
        expect(warm.x).to.be.closeTo(0.4593, 0.005);
        expect(warm.y).to.be.closeTo(0.4106, 0.005);
        expect(warm.x).to.be.greaterThan(cool.x);
    });

    it("keeps white near the D65 center on both paths", () => {
        const white = rgbToXY({ r: 1, g: 1, b: 1 });
        expect(Math.abs(white.x - 0.3227)).to.be.lessThan(0.02);
        expect(Math.abs(white.y - 0.329)).to.be.lessThan(0.02);
        expect(hsvToXY(0, 0)).to.deep.equal(white);
    });
});
