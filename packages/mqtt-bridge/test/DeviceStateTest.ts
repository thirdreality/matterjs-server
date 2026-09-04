/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { deviceStateOf, endpointStateOf, isStateAttribute, relevantEndpointsOf } from "../src/DeviceState.js";
import { lightCapabilitiesOf } from "../src/LightCapabilities.js";
import { splitByEndpointSuffix } from "../src/SetCommands.js";

// Attribute snapshot modeled on the ThirdReality Smart Color Night Light:
// ep1 = full-color light (hs mode), ep2 = illuminance, ep3 = occupancy, battery on ep0
const NIGHT_LIGHT = {
    "1/6/0": true,
    "1/8/0": 200,
    "1/8/2": 1,
    "1/8/3": 254,
    "1/768/65532": 31,
    "1/768/0": 170,
    "1/768/1": 254,
    "1/768/3": 24939,
    "1/768/4": 24701,
    "1/768/7": 250,
    "1/768/8": 0,
    "1/768/16384": 43690,
    "1/768/16395": 25,
    "1/768/16396": 1000,
    "2/1024/0": 21336,
    "3/1030/0": 1,
};

const capsOf = (endpoint: number) => lightCapabilitiesOf(NIGHT_LIGHT, endpoint);

describe("DeviceState", () => {
    describe("relevantEndpointsOf", () => {
        it("finds light and sensor endpoints", () => {
            expect(relevantEndpointsOf(NIGHT_LIGHT)).to.deep.equal([1, 2, 3]);
        });

        it("ignores nodes without mapped clusters", () => {
            expect(relevantEndpointsOf({ "0/40/1": "Vendor" })).to.deep.equal([]);
        });
    });

    describe("isStateAttribute", () => {
        it("matches mapped attribute paths only", () => {
            expect(isStateAttribute(6, 0)).to.equal(true);
            expect(isStateAttribute(768, 7)).to.equal(true);
            expect(isStateAttribute(1030, 0)).to.equal(true);
            expect(isStateAttribute(6, 16384)).to.equal(false);
            expect(isStateAttribute(40, 1)).to.equal(false);
        });
    });

    describe("endpointStateOf", () => {
        it("assembles light state in hs mode with enhanced hue precision", () => {
            expect(endpointStateOf(NIGHT_LIGHT, 1, capsOf(1))).to.deep.equal({
                state: "ON",
                brightness: 200,
                color_mode: "hs",
                // enhancedCurrentHue 43690/65535 = 240°, saturation 254/254 = 100
                color: { hue: 240, saturation: 100 },
                color_temp: 250,
            });
        });

        it("uses xy representation in xy color mode", () => {
            const attributes = { ...NIGHT_LIGHT, "1/768/8": 1 };
            const state = endpointStateOf(attributes, 1, capsOf(1));
            expect(state.color_mode).to.equal("xy");
            expect(state.color).to.deep.equal({ x: 0.3805, y: 0.3769 });
        });

        it("reports color_temp mode without a color object", () => {
            const attributes = { ...NIGHT_LIGHT, "1/768/8": 2 };
            const state = endpointStateOf(attributes, 1, capsOf(1));
            expect(state.color_mode).to.equal("color_temp");
            expect(state.color).to.equal(undefined);
            expect(state.color_temp).to.equal(250);
        });

        it("converts illuminance raw to lux", () => {
            // 10^((21336-1)/10000) = 136 lx
            expect(endpointStateOf(NIGHT_LIGHT, 2, capsOf(2))).to.deep.equal({ illuminance: 136 });
        });

        it("reads occupancy from bitmap number or decoded object", () => {
            expect(endpointStateOf(NIGHT_LIGHT, 3, capsOf(3))).to.deep.equal({ occupancy: true });
            const decoded = { "3/1030/0": { occupied: false } };
            expect(endpointStateOf(decoded, 3, lightCapabilitiesOf(decoded, 3))).to.deep.equal({ occupancy: false });
        });

        it("converts temperature, humidity and contact", () => {
            const attributes = { "4/1026/0": 2153, "4/1029/0": 4587, "4/69/0": true };
            expect(endpointStateOf(attributes, 4, lightCapabilitiesOf(attributes, 4))).to.deep.equal({
                temperature: 21.53,
                humidity: 45.87,
                contact: true,
            });
        });
    });

    describe("deviceStateOf", () => {
        it("keeps properties plain when each capability lives on its own endpoint", () => {
            const state = deviceStateOf(NIGHT_LIGHT, [1, 2, 3], capsOf);
            expect(state.state).to.equal("ON");
            expect(state.brightness).to.equal(200);
            expect(state.illuminance).to.equal(136);
            expect(state.occupancy).to.equal(true);
            expect(state.state_1).to.equal(undefined);
        });

        it("suffixes only the properties that collide across endpoints", () => {
            const attributes = { "1/6/0": true, "2/6/0": false, "3/1030/0": 1 };
            const state = deviceStateOf(attributes, [1, 2, 3], ep => lightCapabilitiesOf(attributes, ep));
            expect(state).to.deep.equal({ state_1: "ON", state_2: "OFF", occupancy: true });
        });

        it("uses plain properties for a single relevant endpoint", () => {
            const attributes = { "1/6/0": false };
            const state = deviceStateOf(attributes, [1], ep => lightCapabilitiesOf(attributes, ep));
            expect(state).to.deep.equal({ state: "OFF" });
        });

        it("adds device-level battery from PowerSource", () => {
            const attributes = { "1/6/0": true, "0/47/12": 187 };
            const state = deviceStateOf(attributes, [1], ep => lightCapabilitiesOf(attributes, ep));
            expect(state.battery).to.equal(94);
        });
    });

    describe("splitByEndpointSuffix", () => {
        it("routes suffixed keys to their endpoint and plain keys to the default", () => {
            const split = splitByEndpointSuffix(
                { state_1: "ON", brightness_1: 10, state_3: "OFF", color_temp: 300 },
                [1, 3],
                1,
            );
            expect(split.get(1)).to.deep.equal({ state: "ON", brightness: 10, color_temp: 300 });
            expect(split.get(3)).to.deep.equal({ state: "OFF" });
        });

        it("keeps unknown suffixes as part of the property name", () => {
            const split = splitByEndpointSuffix({ state_9: "ON" }, [1], 1);
            expect(split.get(1)).to.deep.equal({ state_9: "ON" });
        });
    });
});
