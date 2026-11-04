/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { relevantEndpointsOf } from "../src/DeviceState.js";
import { deviceDescriptionOf, exposesOf, powerSourceOf, type Expose } from "../src/Exposes.js";
import { lightCapabilitiesOf } from "../src/LightCapabilities.js";

// ThirdReality night light: ep1 full-color light, ep2 illuminance, ep3 occupancy, battery on ep0
const NIGHT_LIGHT = {
    "1/6/0": true,
    "1/8/0": 200,
    "1/768/65532": 31,
    "1/768/16395": 153,
    "1/768/16396": 500,
    "2/1024/0": 21336,
    "3/1030/0": 1,
    "0/47/12": 180,
};

function exposesFor(attributes: Record<string, unknown>): Expose[] {
    return exposesOf(attributes, relevantEndpointsOf(attributes), ep => lightCapabilitiesOf(attributes, ep));
}

describe("Exposes", () => {
    it("describes a color light the way zigbee2mqtt does", () => {
        const [light] = exposesFor(NIGHT_LIGHT);
        expect(light.type).to.equal("light");
        expect(light.endpoint).to.equal(undefined);
        const features = light.features as Expose[];
        expect(features.map(f => f.name)).to.deep.equal(["state", "brightness", "color_temp", "color_xy", "color_hs"]);
        expect(features[0]).to.deep.equal({
            name: "state",
            label: "State",
            property: "state",
            access: 7,
            type: "binary",
            value_on: "ON",
            value_off: "OFF",
            value_toggle: "TOGGLE",
        });
        expect(features[1]).to.include({ type: "numeric", value_min: 0, value_max: 254, access: 7 });
        expect(features[2]).to.include({ unit: "mired", value_min: 153, value_max: 500 });
        expect(features[2].presets).to.deep.equal([
            { name: "coolest", value: 153 },
            { name: "cool", value: 250 },
            { name: "neutral", value: 370 },
            { name: "warm", value: 454 },
            { name: "warmest", value: 500 },
        ]);
        expect(features[3]).to.include({ type: "composite", property: "color" });
        expect((features[4].features as Expose[]).map(f => f.property)).to.deep.equal(["hue", "saturation"]);
    });

    it("drops color_temp presets outside the device range", () => {
        const attributes = { "1/6/0": true, "1/8/0": 1, "1/768/65532": 16, "1/768/16395": 200, "1/768/16396": 400 };
        const [light] = exposesFor(attributes);
        const colorTemp = (light.features as Expose[]).find(f => f.name === "color_temp") as Expose;
        expect((colorTemp.presets as Expose[]).map(p => p.name)).to.deep.equal([
            "coolest",
            "cool",
            "neutral",
            "warmest",
        ]);
    });

    it("lists sensors as read-only, then the device-level battery", () => {
        const exposes = exposesFor(NIGHT_LIGHT).slice(1);
        expect(exposes).to.deep.equal([
            {
                type: "numeric",
                name: "illuminance",
                label: "Illuminance",
                property: "illuminance",
                access: 5,
                unit: "lx",
            },
            {
                type: "binary",
                name: "occupancy",
                label: "Occupancy",
                property: "occupancy",
                access: 5,
                value_on: true,
                value_off: false,
            },
            { type: "numeric", name: "battery", label: "Battery", property: "battery", access: 5, unit: "%" },
        ]);
    });

    it("names the endpoint of suffixed properties", () => {
        const attributes = { "1/6/0": true, "2/6/0": false };
        const exposes = exposesFor(attributes);
        expect(exposes.map(e => [e.type, e.endpoint])).to.deep.equal([
            ["switch", "1"],
            ["switch", "2"],
        ]);
        expect((exposes[1].features as Expose[])[0]).to.include({ property: "state_2", endpoint: "2" });
    });

    it("keeps the contact inversion and enum values", () => {
        const attributes = { "1/29/0": [{ "0": 0x0015, "1": 1 }], "1/69/0": true, "2/91/0": 1 };
        expect(exposesFor(attributes)).to.deep.equal([
            {
                type: "binary",
                name: "contact",
                label: "Contact",
                property: "contact",
                access: 5,
                value_on: false,
                value_off: true,
            },
            {
                type: "enum",
                name: "air_quality",
                label: "Air quality",
                property: "air_quality",
                access: 5,
                values: ["unknown", "good", "fair", "moderate", "poor", "very_poor", "extremely_poor"],
            },
        ]);
    });

    it("omits a device-level property an endpoint already provides", () => {
        const attributes = { "1/144/4": 230000, "0/47/11": 3000 };
        expect(exposesFor(attributes).map(e => [e.name, e.unit])).to.deep.equal([["voltage", "V"]]);
    });

    describe("powerSourceOf", () => {
        it("reports a battery source", () => {
            expect(powerSourceOf({ "0/47/65532": 2, "0/47/1": 0 })).to.equal("Battery");
        });

        it("reports wired AC and DC sources", () => {
            expect(powerSourceOf({ "0/47/65532": 1, "0/47/5": 0 })).to.equal("Mains (single phase)");
            expect(powerSourceOf({ "0/47/65532": 1, "0/47/5": 1 })).to.equal("DC Source");
        });

        it("uses the source with the lowest order", () => {
            const attributes = { "1/47/65532": 2, "1/47/1": 1, "2/47/65532": 1, "2/47/1": 0 };
            expect(powerSourceOf(attributes)).to.equal("Mains (single phase)");
        });

        it("reports nothing without a PowerSource", () => {
            expect(powerSourceOf({ "1/6/0": true })).to.equal(undefined);
        });
    });

    it("assembles the zigbee2mqtt device description", () => {
        const attributes = {
            ...NIGHT_LIGHT,
            "0/40/1": "ThirdReality",
            "0/40/3": "Smart Color Night Light",
            "0/40/10": "1.0.4",
            "0/47/65532": 2,
        };
        const description = deviceDescriptionOf(
            "8",
            attributes,
            relevantEndpointsOf(attributes),
            ep => lightCapabilitiesOf(attributes, ep),
            true,
        );
        expect(description).to.deep.include({
            friendly_name: "8",
            supported: true,
            manufacturer: "ThirdReality",
            model_id: "Smart Color Night Light",
            software_build_id: "1.0.4",
            power_source: "Battery",
        });
        const definition = description.definition as Expose;
        expect(definition).to.include({ model: "Smart Color Night Light", vendor: "ThirdReality", supports_ota: true });
        expect((definition.exposes as Expose[]).length).to.equal(4);
    });
});
