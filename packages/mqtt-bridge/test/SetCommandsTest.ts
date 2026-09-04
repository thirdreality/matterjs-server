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

        it("warns on stage-3 color forms and invalid values", () => {
            const hex = parseSetMessage('{"color":"#FF0000"}', undefined, FULL_COLOR);
            expect(hex?.commands).to.deep.equal([]);
            expect(hex?.warnings[0]).to.contain("unsupported color format");
            const rgb = parseSetMessage('{"color":{"r":255,"g":0,"b":0}}', undefined, FULL_COLOR);
            expect(rgb?.warnings[0]).to.contain("unsupported color format");
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
