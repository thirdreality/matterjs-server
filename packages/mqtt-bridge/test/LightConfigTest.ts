/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseEndpointSet } from "../src/Controls.js";
import { deviceStateOf, relevantEndpointsOf } from "../src/DeviceState.js";
import { discoveryMessagesOf } from "../src/Discovery.js";
import { exposesOf, type Expose } from "../src/Exposes.js";
import { lightCapabilitiesOf } from "../src/LightCapabilities.js";
import { Topics } from "../src/Topics.js";

// Color temperature bulb with the OnOff Lighting feature, Identify and the startup attributes
const BULB = {
    "1/3/0": 0,
    "1/6/0": true,
    "1/6/65532": 1,
    "1/6/16387": null,
    "1/8/0": 200,
    "1/8/15": 0,
    "1/8/16": 5,
    "1/8/17": null,
    "1/8/16384": 254,
    "1/768/65532": 16,
    "1/768/15": 2,
    "1/768/16395": 153,
    "1/768/16396": 454,
    "1/768/16400": 300,
};

const capsOf = (attributes: Record<string, unknown>) => (ep: number) => lightCapabilitiesOf(attributes, ep);

function stateOf(attributes: Record<string, unknown>) {
    return deviceStateOf(attributes, relevantEndpointsOf(attributes), capsOf(attributes));
}

describe("Light configuration", () => {
    it("publishes the zigbee2mqtt light options", () => {
        expect(stateOf(BULB)).to.deep.include({
            power_on_behavior: "previous",
            color_temp_startup: 300,
            level_config: {
                on_off_transition_time: 5,
                on_level: 255,
                current_level_startup: 254,
                execute_if_off: false,
            },
            color_options: { execute_if_off: false },
        });
        expect(stateOf({ ...BULB, "1/6/16387": 1, "1/768/16400": null })).to.deep.include({
            power_on_behavior: "on",
            color_temp_startup: 65535,
        });
    });

    it("writes power_on_behavior, with previous as null", () => {
        expect(parseEndpointSet({ power_on_behavior: "toggle" }, BULB, 1)?.actions).to.deep.equal([
            { clusterId: 6, attributeId: 16387, value: 2 },
        ]);
        expect(parseEndpointSet({ power_on_behavior: "previous" }, BULB, 1)?.actions).to.deep.equal([
            { clusterId: 6, attributeId: 16387, value: null },
        ]);
    });

    it("writes color_temp_startup from mireds, presets and previous", () => {
        const write = (value: unknown) => parseEndpointSet({ color_temp_startup: value }, BULB, 1);
        expect(write(250)?.actions[0]).to.deep.equal({ clusterId: 768, attributeId: 16400, value: 250 });
        expect(write("warmest")?.actions[0]).to.include({ value: 454 });
        expect(write("previous")?.actions[0]).to.include({ value: null });
        expect(write(65535)?.actions[0]).to.include({ value: null });
        expect(write(600)?.warnings).to.deep.equal(["invalid color_temp_startup 600: expected 153-454"]);
    });

    it("writes level_config fields and keeps the other option bits", () => {
        const bulb = { ...BULB, "1/8/15": 2 };
        expect(
            parseEndpointSet(
                { level_config: { on_level: "previous", current_level_startup: "minimum", execute_if_off: true } },
                bulb,
                1,
            ),
        ).to.deep.equal({
            actions: [
                { clusterId: 8, attributeId: 17, value: null },
                { clusterId: 8, attributeId: 16384, value: 0 },
                { clusterId: 8, attributeId: 15, value: 3 },
            ],
            warnings: [],
        });
        expect(parseEndpointSet({ level_config: { on_transition_time: 10 } }, BULB, 1)?.warnings).to.deep.equal([
            "level_config.on_transition_time not supported by this endpoint",
        ]);
    });

    it("writes color_options.execute_if_off", () => {
        expect(parseEndpointSet({ color_options: { execute_if_off: true } }, BULB, 1)?.actions).to.deep.equal([
            { clusterId: 768, attributeId: 15, value: 3 },
        ]);
    });

    it("triggers effects and identify", () => {
        expect(parseEndpointSet({ state: "ON", effect: "breathe" }, BULB, 1)?.actions).to.deep.equal([
            { clusterId: 6, commandName: "on", data: {} },
            { clusterId: 3, commandName: "triggerEffect", data: { effectIdentifier: 1, effectVariant: 0 } },
        ]);
        expect(parseEndpointSet({ identify: "identify" }, BULB, 1)?.actions).to.deep.equal([
            { clusterId: 3, commandName: "identify", data: { identifyTime: 3 } },
        ]);
        expect(parseEndpointSet({ effect: "disco" }, BULB, 1)?.warnings[0]).to.contain("invalid effect");
    });

    describe("on_time", () => {
        it("turns on with a timed off", () => {
            expect(parseEndpointSet({ state: "ON", on_time: 30, off_wait_time: 5 }, BULB, 1)).to.deep.equal({
                actions: [
                    {
                        clusterId: 6,
                        commandName: "onWithTimedOff",
                        data: { onOffControl: 0, onTime: 300, offWaitTime: 50 },
                    },
                ],
                warnings: [],
            });
        });

        it("keeps a brightness change and adds the timed on", () => {
            const actions = parseEndpointSet({ brightness: 100, on_time: 10 }, BULB, 1)?.actions ?? [];
            expect(actions.map(a => ("commandName" in a ? a.commandName : ""))).to.deep.equal([
                "moveToLevelWithOnOff",
                "onWithTimedOff",
            ]);
        });

        it("needs the Lighting feature", () => {
            const plain = { "1/6/0": false };
            expect(parseEndpointSet({ state: "ON", on_time: 10 }, plain, 1)?.warnings).to.deep.equal([
                "on_time not supported by this endpoint",
            ]);
            expect(parseEndpointSet({ off_wait_time: 10 }, BULB, 1)?.warnings).to.deep.equal([
                "off_wait_time needs on_time",
            ]);
        });
    });

    it("announces the options to Home Assistant", () => {
        const messages = discoveryMessagesOf(
            { device: "3" },
            BULB,
            relevantEndpointsOf(BULB),
            capsOf(BULB),
            new Topics("matter2mqtt"),
        ).map(m => ({
            topic: m.topic.replace("homeassistant/", "").replace("/matter2mqtt_3/", "/").replace("/config", ""),
            config: JSON.parse(m.payload),
        }));
        const byTopic = new Map(messages.map(m => [m.topic, m.config]));
        expect(byTopic.get("light/light")).to.include({ effect: true });
        expect(byTopic.get("light/light").effect_list).to.deep.equal([
            "blink",
            "breathe",
            "okay",
            "channel_change",
            "finish_effect",
            "stop_effect",
        ]);
        expect(byTopic.get("select/power_on_behavior").options).to.deep.equal(["off", "on", "toggle", "previous"]);
        expect(byTopic.get("number/color_temp_startup")).to.include({ min: 153, max: 454, entity_category: "config" });
        expect(byTopic.get("button/identify")).to.include({
            device_class: "identify",
            payload_press: '{"identify": "identify"}',
        });
        expect([...byTopic.keys()].some(topic => topic.includes("level_config"))).to.equal(false);
    });

    it("exposes the options the zigbee2mqtt way", () => {
        const exposes = exposesOf(BULB, relevantEndpointsOf(BULB), capsOf(BULB));
        const names = exposes.map(e => e.name ?? e.type);
        expect(names).to.include.members([
            "power_on_behavior",
            "color_temp_startup",
            "level_config",
            "color_options",
            "effect",
            "identify",
        ]);
        const level = exposes.find(e => e.name === "level_config") as Expose;
        expect((level.features as Expose[]).map(f => f.name)).to.deep.equal([
            "on_off_transition_time",
            "on_level",
            "current_level_startup",
            "execute_if_off",
        ]);
        const startup = exposes.find(e => e.name === "color_temp_startup") as Expose;
        expect((startup.presets as Expose[]).at(-1)).to.deep.equal({ name: "previous", value: 65535 });
    });

    describe("on a ThirdReality night light", () => {
        // Identify on all three endpoints (light, light sensor, occupancy), StartUpColorTemperatureMireds 0
        const NIGHT_LIGHT = {
            "1/3/0": 0,
            "1/6/0": true,
            "1/8/0": 128,
            "1/768/65532": 31,
            "1/768/16395": 153,
            "1/768/16396": 370,
            "1/768/16400": 0,
            "2/3/0": 0,
            "2/1024/0": 0,
            "3/3/0": 0,
            "3/1030/0": 0,
        };

        it("offers effect and identify once, on the light", () => {
            const exposes = exposesOf(NIGHT_LIGHT, relevantEndpointsOf(NIGHT_LIGHT), capsOf(NIGHT_LIGHT));
            expect(
                exposes
                    .filter(e => e.name === "effect" || e.name === "identify")
                    .map(e => [e.name, e.property, e.endpoint]),
            ).to.deep.equal([
                ["effect", "effect", undefined],
                ["identify", "identify", undefined],
            ]);
            const buttons = discoveryMessagesOf(
                { device: "1" },
                NIGHT_LIGHT,
                relevantEndpointsOf(NIGHT_LIGHT),
                capsOf(NIGHT_LIGHT),
                new Topics("matter2mqtt"),
            )
                .filter(m => m.topic.includes("/button/"))
                .map(m => [m.topic, JSON.parse(m.payload).unique_id]);
            expect(buttons).to.deep.equal([
                ["homeassistant/button/matter2mqtt_1/identify/config", "matter2mqtt_1_identify_1"],
            ]);
        });

        it("leaves an out-of-range startup color temperature out, and reports darkness as 0 lx", () => {
            const state = stateOf(NIGHT_LIGHT);
            expect(state.color_temp_startup).to.equal(undefined);
            expect(state.illuminance).to.equal(0);
        });

        it("identifies a sensor-only device once, on its lowest endpoint", () => {
            const sensor = { "1/3/0": 0, "1/1026/0": 2000, "2/3/0": 0, "2/1029/0": 4000 };
            const exposes = exposesOf(sensor, relevantEndpointsOf(sensor), capsOf(sensor));
            expect(exposes.filter(e => e.name === "identify").map(e => e.property)).to.deep.equal(["identify"]);
        });

        it("suffixes effect and identify of a device with two lights", () => {
            const dual = { "1/3/0": 0, "1/6/0": true, "1/8/0": 1, "2/3/0": 0, "2/6/0": true, "2/8/0": 1 };
            const exposes = exposesOf(dual, relevantEndpointsOf(dual), capsOf(dual));
            expect(exposes.filter(e => e.name === "identify").map(e => [e.property, e.endpoint])).to.deep.equal([
                ["identify_1", "1"],
                ["identify_2", "2"],
            ]);
            expect(parseEndpointSet({ identify: "identify" }, dual, 2)?.actions[0]).to.deep.include({
                clusterId: 3,
                commandName: "identify",
            });
        });
    });
});
