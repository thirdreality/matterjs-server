/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { lightCapabilitiesOf } from "../src/LightCapabilities.js";

describe("LightCapabilities", () => {
    // Attribute snapshot of a ThirdReality Smart Color Night Light, endpoint 1
    const nightLight = {
        "1/6/0": true,
        "1/8/0": 254,
        "1/8/2": 1,
        "1/8/3": 254,
        "1/768/65532": 31,
        "1/768/16395": 25,
        "1/768/16396": 1000,
    };

    it("derives full color capabilities from the feature map", () => {
        expect(lightCapabilitiesOf(nightLight, 1)).to.deep.equal({
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
        });
    });

    it("reports an onoff-only endpoint", () => {
        expect(lightCapabilitiesOf({ "1/6/0": false }, 1)).to.deep.equal({
            onOff: true,
            brightness: false,
            minLevel: 1,
            maxLevel: 254,
            hueSaturation: false,
            enhancedHue: false,
            xy: false,
            colorTemp: false,
            colorTempMinMireds: undefined,
            colorTempMaxMireds: undefined,
        });
    });

    it("reports nothing for an endpoint without OnOff", () => {
        const caps = lightCapabilitiesOf({ "2/1024/0": 21336 }, 2);
        expect(caps.onOff).to.equal(false);
        expect(caps.brightness).to.equal(false);
    });
});
