/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LightCapabilities } from "../src/LightCapabilities.js";
import { parseSetMessage } from "../src/SetCommands.js";

const FULL_COLOR: LightCapabilities = {
    onOff: true,
    brightness: true,
    minLevel: 1,
    maxLevel: 254,
    hueSaturation: true,
    enhancedHue: true,
    xy: true,
    colorTemp: true,
    colorTempMinMireds: 25,
    colorTempMaxMireds: 1000,
};

const PLAIN_HS: LightCapabilities = { ...FULL_COLOR, enhancedHue: false };
const ONOFF_ONLY: LightCapabilities = {
    onOff: true,
    brightness: false,
    minLevel: 1,
    maxLevel: 254,
    hueSaturation: false,
    enhancedHue: false,
    xy: false,
    colorTemp: false,
};

describe("SetCommands", () => {
    describe("state", () => {
        it("parses bare payloads and JSON forms", () => {
            for (const payload of ["ON", '"ON"', '{"state":"ON"}', "true"]) {
                const result = parseSetMessage(payload, undefined, ONOFF_ONLY);
                expect(result?.commands).to.deep.equal([{ clusterId: 6, commandName: "on", data: {} }]);
            }
            expect(parseSetMessage(" Toggle ", undefined, ONOFF_ONLY)?.commands[0]?.commandName).to.equal("toggle");
            expect(parseSetMessage("false", undefined, ONOFF_ONLY)?.commands[0]?.commandName).to.equal("off");
        });

        it("parses the /set/state bare-payload form", () => {
            const result = parseSetMessage("OFF", "state", ONOFF_ONLY);
            expect(result?.commands).to.deep.equal([{ clusterId: 6, commandName: "off", data: {} }]);
        });

        it("rejects unusable payloads", () => {
            expect(parseSetMessage("banana", undefined, ONOFF_ONLY)).to.equal(undefined);
            expect(parseSetMessage("42", undefined, ONOFF_ONLY)).to.equal(undefined);
            expect(parseSetMessage("", undefined, ONOFF_ONLY)).to.equal(undefined);
        });

        it("warns on invalid state values", () => {
            const result = parseSetMessage('{"state":"banana"}', undefined, ONOFF_ONLY);
            expect(result?.commands).to.deep.equal([]);
            expect(result?.warnings[0]).to.contain("invalid state");
        });
    });

    describe("brightness (zigbee2mqtt light_onoff_brightness rules)", () => {
        it("uses moveToLevelWithOnOff and infers state from brightness", () => {
            const result = parseSetMessage('{"brightness":128}', undefined, FULL_COLOR);
            expect(result?.commands).to.deep.equal([
                {
                    clusterId: 8,
                    commandName: "moveToLevelWithOnOff",
                    data: { level: 128, transitionTime: 0, optionsMask: 0, optionsOverride: 0 },
                },
            ]);
        });

        it("treats brightness 0 without state as off", () => {
            const result = parseSetMessage('{"brightness":0}', undefined, FULL_COLOR);
            expect(result?.commands[0]?.data.level).to.equal(0);
            expect(result?.commands[0]?.commandName).to.equal("moveToLevelWithOnOff");
        });

        it("raises brightness 0 with explicit ON to 1", () => {
            const result = parseSetMessage('{"state":"ON","brightness":0}', undefined, FULL_COLOR);
            expect(result?.commands[0]?.data.level).to.equal(1);
        });

        it("clamps 255 to 254 and rejects other out-of-range values", () => {
            expect(parseSetMessage('{"brightness":255}', undefined, FULL_COLOR)?.commands[0]?.data.level).to.equal(254);
            const bad = parseSetMessage('{"brightness":300}', undefined, FULL_COLOR);
            expect(bad?.commands).to.deep.equal([]);
            expect(bad?.warnings[0]).to.contain("invalid brightness");
        });

        it("maps brightness_percent to 0-255", () => {
            const result = parseSetMessage('{"brightness_percent":50}', undefined, FULL_COLOR);
            expect(result?.commands[0]?.data.level).to.equal(128);
        });

        it("adjusts level only for explicit state null", () => {
            const result = parseSetMessage('{"state":null,"brightness":10}', undefined, FULL_COLOR);
            expect(result?.commands[0]?.commandName).to.equal("moveToLevel");
        });

        it("resolves toggle with brightness against the cached state", () => {
            const on = parseSetMessage('{"state":"TOGGLE","brightness":100}', undefined, FULL_COLOR, false);
            expect(on?.commands[0]?.data.level).to.equal(100);
            const off = parseSetMessage('{"state":"TOGGLE","brightness":100}', undefined, FULL_COLOR, true);
            expect(off?.commands[0]?.data.level).to.equal(0);
        });

        it("supports the /set/brightness bare-payload form", () => {
            const result = parseSetMessage("200", "brightness", FULL_COLOR);
            expect(result?.commands[0]?.data.level).to.equal(200);
        });

        it("warns when the endpoint has no LevelControl", () => {
            const result = parseSetMessage('{"brightness":100}', undefined, ONOFF_ONLY);
            expect(result?.commands).to.deep.equal([]);
            expect(result?.warnings[0]).to.contain("brightness not supported");
        });
    });

    describe("transition", () => {
        it("converts seconds to 0.1s units", () => {
            const result = parseSetMessage('{"brightness":100,"transition":2}', undefined, FULL_COLOR);
            expect(result?.commands[0]?.data.transitionTime).to.equal(20);
        });

        it("simulates OFF with transition via moveToLevelWithOnOff", () => {
            const result = parseSetMessage('{"state":"OFF","transition":1.5}', undefined, FULL_COLOR);
            expect(result?.commands).to.deep.equal([
                {
                    clusterId: 8,
                    commandName: "moveToLevelWithOnOff",
                    data: { level: 0, transitionTime: 15, optionsMask: 0, optionsOverride: 0 },
                },
            ]);
        });
    });

    describe("color_temp", () => {
        it("sends moveToColorTemperature with device-range clamping", () => {
            const result = parseSetMessage('{"color_temp":370}', undefined, FULL_COLOR);
            expect(result?.commands).to.deep.equal([
                {
                    clusterId: 768,
                    commandName: "moveToColorTemperature",
                    data: { colorTemperatureMireds: 370, transitionTime: 0, optionsMask: 0, optionsOverride: 0 },
                },
            ]);
            expect(
                parseSetMessage('{"color_temp":5000}', undefined, FULL_COLOR)?.commands[0]?.data.colorTemperatureMireds,
            ).to.equal(1000);
            expect(
                parseSetMessage('{"color_temp":1}', undefined, FULL_COLOR)?.commands[0]?.data.colorTemperatureMireds,
            ).to.equal(25);
        });

        it("resolves presets, coolest/warmest to the device range", () => {
            expect(
                parseSetMessage('{"color_temp":"coolest"}', undefined, FULL_COLOR)?.commands[0]?.data
                    .colorTemperatureMireds,
            ).to.equal(25);
            expect(
                parseSetMessage('{"color_temp":"warmest"}', undefined, FULL_COLOR)?.commands[0]?.data
                    .colorTemperatureMireds,
            ).to.equal(1000);
            expect(
                parseSetMessage('{"color_temp":"neutral"}', undefined, FULL_COLOR)?.commands[0]?.data
                    .colorTemperatureMireds,
            ).to.equal(370);
        });

        it("warns when unsupported", () => {
            const result = parseSetMessage('{"color_temp":300}', undefined, ONOFF_ONLY);
            expect(result?.commands).to.deep.equal([]);
            expect(result?.warnings[0]).to.contain("color_temp not supported");
        });
    });

    describe("color", () => {
        it("maps xy to moveToColor on the 0-65535 scale", () => {
            const result = parseSetMessage('{"color":{"x":0.5,"y":0.25}}', undefined, FULL_COLOR);
            expect(result?.commands).to.deep.equal([
                {
                    clusterId: 768,
                    commandName: "moveToColor",
                    data: { colorX: 32768, colorY: 16384, transitionTime: 0, optionsMask: 0, optionsOverride: 0 },
                },
            ]);
        });

        it("prefers enhanced hue when supported (hue 0-360 to 0-65535)", () => {
            const result = parseSetMessage('{"color":{"hue":120,"saturation":100}}', undefined, FULL_COLOR);
            expect(result?.commands).to.deep.equal([
                {
                    clusterId: 768,
                    commandName: "enhancedMoveToHueAndSaturation",
                    data: {
                        enhancedHue: 21845,
                        saturation: 254,
                        transitionTime: 0,
                        optionsMask: 0,
                        optionsOverride: 0,
                    },
                },
            ]);
        });

        it("falls back to moveToHueAndSaturation without enhanced hue (hue to 0-254)", () => {
            const result = parseSetMessage('{"color":{"h":240,"s":50}}', undefined, PLAIN_HS);
            expect(result?.commands).to.deep.equal([
                {
                    clusterId: 768,
                    commandName: "moveToHueAndSaturation",
                    data: { hue: 169, saturation: 127, transitionTime: 0, optionsMask: 0, optionsOverride: 0 },
                },
            ]);
        });

        it("supports hue or saturation alone", () => {
            expect(parseSetMessage('{"color":{"hue":90}}', undefined, PLAIN_HS)?.commands[0]?.commandName).to.equal(
                "moveToHue",
            );
            expect(parseSetMessage('{"color":{"s":80}}', undefined, PLAIN_HS)?.commands[0]?.commandName).to.equal(
                "moveToSaturation",
            );
        });

        it("sends RGB forms as xy, like zigbee2mqtt", () => {
            // Red: the wide-gamut primary, well outside the sRGB corner
            for (const payload of [
                '{"color":"#FF0000"}',
                '{"color":{"r":255,"g":0,"b":0}}',
                '{"color":{"rgb":"255,0,0"}}',
                '{"color":{"hex":"#FF0000"}}',
            ]) {
                const result = parseSetMessage(payload, undefined, FULL_COLOR);
                expect(result?.warnings, payload).to.deep.equal([]);
                // x/y 0.7006/0.2993: the wide-gamut red primary this matrix produces
                expect(result?.commands, payload).to.deep.equal([
                    {
                        clusterId: 768,
                        commandName: "moveToColor",
                        data: { colorX: 45914, colorY: 19615, transitionTime: 0, optionsMask: 0, optionsOverride: 0 },
                    },
                ]);
            }
        });

        it("converts HSL to hue/saturation", () => {
            // HSL 120/100/50 is pure green: HSV 120/100/100
            const result = parseSetMessage('{"color":{"h":120,"s":100,"l":50}}', undefined, FULL_COLOR);
            expect(result?.commands.map(c => c.commandName)).to.deep.equal([
                "moveToLevelWithOnOff",
                "enhancedMoveToHueAndSaturation",
            ]);
            expect(result?.commands[1].data).to.deep.include({ enhancedHue: 21845, saturation: 254 });
            const asString = parseSetMessage('{"color":{"hsl":"120,100,50"}}', undefined, FULL_COLOR);
            expect(asString?.commands).to.deep.equal(result?.commands);
        });

        it("maps the HSV value component to the light level (zigbee2mqtt behaviour)", () => {
            for (const payload of ['{"color":{"h":120,"s":50,"v":80}}', '{"color":{"hsv":"120,50,80"}}']) {
                const result = parseSetMessage(payload, undefined, FULL_COLOR);
                expect(result?.warnings, payload).to.deep.equal([]);
                expect(result?.commands[0], payload).to.deep.equal({
                    clusterId: 8,
                    commandName: "moveToLevelWithOnOff",
                    data: { level: 203, transitionTime: 0, optionsMask: 0, optionsOverride: 0 },
                });
                expect(result?.commands[1].commandName, payload).to.equal("enhancedMoveToHueAndSaturation");
            }
            // {h,s,b} spells the same thing
            const hsb = parseSetMessage('{"color":{"hsb":"120,50,80"}}', undefined, FULL_COLOR);
            expect(hsb?.commands[0].data).to.deep.include({ level: 203 });
        });

        it("falls back to xy when an endpoint has no hue/saturation support", () => {
            const xyOnly: LightCapabilities = { ...FULL_COLOR, hueSaturation: false, enhancedHue: false };
            const result = parseSetMessage('{"color":{"hue":120,"saturation":100}}', undefined, xyOnly);
            expect(result?.warnings).to.deep.equal([]);
            expect(result?.commands[0].commandName).to.equal("moveToColor");
        });

        it("falls back to hue/saturation when an endpoint has no xy support", () => {
            const hsOnly: LightCapabilities = { ...FULL_COLOR, xy: false };
            const result = parseSetMessage('{"color":{"x":0.7,"y":0.3}}', undefined, hsOnly);
            expect(result?.warnings).to.deep.equal([]);
            expect(result?.commands[0].commandName).to.equal("enhancedMoveToHueAndSaturation");
        });

        it("passes a hue move direction through", () => {
            const result = parseSetMessage('{"color":{"h":90,"direction":1}}', undefined, PLAIN_HS);
            expect(result?.commands[0].data).to.deep.include({ direction: 1 });
        });

        it("warns on color payloads it cannot read", () => {
            for (const payload of [
                '{"color":"red"}',
                '{"color":{"foo":1}}',
                '{"color":{"r":1,"g":2}}',
                '{"color":5}',
            ]) {
                const result = parseSetMessage(payload, undefined, FULL_COLOR);
                expect(result?.commands, payload).to.deep.equal([]);
                expect(result?.warnings[0], payload).to.contain("unsupported color format");
            }
        });

        it("reports color as unsupported on an endpoint without any color feature", () => {
            const result = parseSetMessage('{"color":{"hue":10}}', undefined, ONOFF_ONLY);
            expect(result?.commands).to.deep.equal([]);
            expect(result?.warnings[0]).to.contain("color not supported");
        });
    });

    describe("combined messages", () => {
        it("orders color before state when turning on", () => {
            const result = parseSetMessage(
                '{"state":"ON","brightness":200,"color_temp":300,"color":{"hue":10,"saturation":10}}',
                undefined,
                FULL_COLOR,
            );
            expect(result?.commands.map(c => c.commandName)).to.deep.equal([
                "moveToColorTemperature",
                "enhancedMoveToHueAndSaturation",
                "moveToLevelWithOnOff",
            ]);
        });

        it("orders state first when turning off", () => {
            const result = parseSetMessage('{"state":"OFF","color_temp":300}', undefined, FULL_COLOR);
            expect(result?.commands.map(c => c.commandName)).to.deep.equal(["off", "moveToColorTemperature"]);
        });

        it("warns on unknown attributes but executes the known ones", () => {
            const result = parseSetMessage('{"state":"ON","banana":1}', undefined, FULL_COLOR);
            expect(result?.commands.map(c => c.commandName)).to.deep.equal(["on"]);
            expect(result?.warnings[0]).to.contain('unsupported attribute "banana"');
        });
    });
});
