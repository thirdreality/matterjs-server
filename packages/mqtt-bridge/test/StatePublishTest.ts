/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { lightCapabilitiesOf } from "../src/LightCapabilities.js";
import { parseSetObject } from "../src/SetCommands.js";
import { harness } from "./BridgeHarness.js";

// Color light, currently off, last set to red in xy mode
const LIGHT = {
    "1/6/0": false,
    "1/8/0": 200,
    "1/768/65532": 31,
    "1/768/16395": 25,
    "1/768/16396": 1000,
    "1/768/8": 1,
    "1/768/3": 45914,
    "1/768/4": 19615,
};
const CAPS = lightCapabilitiesOf(LIGHT, 1);

describe("State publishing", () => {
    it("publishes one state for a burst of attribute reports, not each half-updated color", async () => {
        const h = harness(LIGHT, { isBridge: false });
        await h.bridge.start();
        const states = () => h.published.filter(p => p.topic === "matter2mqtt/12");
        const before = states().length;
        // Green arrives as currentX, then currentY, a millisecond apart
        h.setAttributes({ ...LIGHT, "1/768/3": 11141 });
        h.events.attributeChanged.emit(h.nodeId, {
            path: { endpointId: 1, clusterId: 768, attributeId: 3 },
            value: 11141,
        });
        h.setAttributes({ ...LIGHT, "1/768/3": 11141, "1/768/4": 45875 });
        h.events.attributeChanged.emit(h.nodeId, {
            path: { endpointId: 1, clusterId: 768, attributeId: 4 },
            value: 45875,
        });
        expect(states().length).to.equal(before);
        await h.settle();
        expect(states().length).to.equal(before + 1);
        expect(JSON.parse(states().at(-1)?.payload ?? "{}").color).to.include({ x: 0.17, y: 0.7 });
        await h.bridge.stop();
    });

    it("does not publish a state again when nothing in it changed, but answers /get", async () => {
        const h = harness(LIGHT, { isBridge: false });
        await h.bridge.start();
        const states = () => h.published.filter(p => p.topic === "matter2mqtt/12");
        const before = states().length;
        h.events.attributeChanged.emit(h.nodeId, {
            path: { endpointId: 1, clusterId: 6, attributeId: 0 },
            value: false,
        });
        await h.settle();
        expect(states().length).to.equal(before);
        h.send("matter2mqtt/12/get", "");
        await h.settle();
        expect(states().length).to.equal(before + 1);
        await h.bridge.stop();
    });
});

describe("Turning on with a color", () => {
    const optionsOf = (message: Record<string, unknown>) =>
        (parseSetObject(message, CAPS, false)?.commands ?? []).map(c => [
            c.commandName,
            c.data.optionsMask,
            c.data.optionsOverride,
        ]);

    it("has the still-off light execute the color commands, then turns it on", () => {
        expect(optionsOf({ state: "ON", color_temp: 250 })).to.deep.equal([
            ["moveToColorTemperature", 1, 1],
            ["on", undefined, undefined],
        ]);
        expect(optionsOf({ brightness: 128, color: { hue: 240, saturation: 100 } })).to.deep.equal([
            ["enhancedMoveToHueAndSaturation", 1, 1],
            ["moveToLevelWithOnOff", 0, 0],
        ]);
        expect(optionsOf({ state: "TOGGLE", color_temp: 250 })[0]).to.deep.equal(["moveToColorTemperature", 1, 1]);
    });

    it("leaves the device's own setting in charge when the message does not turn the light on", () => {
        expect(optionsOf({ color_temp: 250 })).to.deep.equal([["moveToColorTemperature", 0, 0]]);
        expect(optionsOf({ state: "OFF", color_temp: 250 })).to.deep.equal([
            ["off", undefined, undefined],
            ["moveToColorTemperature", 0, 0],
        ]);
    });
});
