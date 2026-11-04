/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { controllableEndpointsOf, parseEndpointSet } from "../src/Controls.js";
import { deviceStateOf, relevantEndpointsOf } from "../src/DeviceState.js";
import { discoveryMessagesOf } from "../src/Discovery.js";
import { exposesOf, type Expose } from "../src/Exposes.js";
import { lightCapabilitiesOf } from "../src/LightCapabilities.js";
import { Topics } from "../src/Topics.js";

const topics = new Topics("matter2mqtt");
const capsFor = (attributes: Record<string, unknown>) => (ep: number) => lightCapabilitiesOf(attributes, ep);

function stateOf(attributes: Record<string, unknown>) {
    return deviceStateOf(attributes, relevantEndpointsOf(attributes), capsFor(attributes));
}

function discoveryOf(attributes: Record<string, unknown>) {
    return discoveryMessagesOf(
        { device: "4" },
        attributes,
        relevantEndpointsOf(attributes),
        capsFor(attributes),
        topics,
    ).map(m => ({ topic: m.topic, config: JSON.parse(m.payload) }));
}

// Position-aware lift and tilt (FeatureMap 0b10111), a central curtain, 25% closed, tilt fully open
const CURTAIN = {
    "1/258/65532": 0b10111,
    "1/258/10": 0,
    "1/258/13": 16,
    "1/258/14": 2500,
    "1/258/15": 0,
};

describe("Controls", () => {
    describe("cover", () => {
        it("publishes zigbee2mqtt position (open = 100) and state", () => {
            expect(stateOf(CURTAIN)).to.deep.equal({ state: "OPEN", position: 75, tilt: 100, moving: "STOP" });
            expect(stateOf({ ...CURTAIN, "1/258/14": 10000, "1/258/15": 10000 })).to.include({
                state: "CLOSE",
                position: 0,
            });
        });

        it("reads the moving direction from a number or a decoded bitmap", () => {
            expect(stateOf({ ...CURTAIN, "1/258/10": 0b100101 }).moving).to.equal("UP");
            expect(stateOf({ ...CURTAIN, "1/258/10": { global: 2, lift: 2, tilt: 0 } }).moving).to.equal("DOWN");
        });

        it("maps open, close, stop and positions to WindowCovering commands", () => {
            expect(parseEndpointSet({ state: "open" }, CURTAIN, 1)?.actions).to.deep.equal([
                { clusterId: 258, commandName: "upOrOpen", data: {} },
            ]);
            expect(parseEndpointSet({ state: "STOP" }, CURTAIN, 1)?.actions[0]).to.include({
                commandName: "stopMotion",
            });
            expect(parseEndpointSet({ position: 30, tilt: "40" }, CURTAIN, 1)?.actions).to.deep.equal([
                { clusterId: 258, commandName: "goToLiftPercentage", data: { liftPercent100thsValue: 7000 } },
                { clusterId: 258, commandName: "goToTiltPercentage", data: { tiltPercent100thsValue: 6000 } },
            ]);
        });

        it("refuses what the cover cannot do", () => {
            const liftOnly = { "1/258/65532": 0b101, "1/258/14": 0 };
            expect(parseEndpointSet({ tilt: 50 }, liftOnly, 1)).to.deep.equal({
                actions: [],
                warnings: ["tilt not supported by this cover"],
            });
            expect(parseEndpointSet({ state: "ON", position: 120 }, CURTAIN, 1)?.warnings).to.deep.equal([
                'invalid cover state "ON": expected OPEN, CLOSE or STOP',
                "invalid position 120: expected 0-100",
            ]);
        });

        it("announces a Home Assistant cover with position and tilt", () => {
            const [cover] = discoveryOf(CURTAIN);
            expect(cover.topic).to.equal("homeassistant/cover/matter2mqtt_4/cover/config");
            expect(cover.config).to.include({
                name: "Cover",
                unique_id: "matter2mqtt_4_cover_1",
                device_class: "curtain",
                command_topic: "matter2mqtt/4/set",
                state_topic: "matter2mqtt/4",
                value_template: "{{ value_json.state }}",
                payload_open: '{"state":"OPEN"}',
                position_template: "{{ value_json.position }}",
                set_position_template: '{"position": {{ position }}}',
                tilt_command_template: '{"tilt": {{ tilt_position }}}',
            });
        });

        it("leaves position out for a cover that does not track it", () => {
            const [cover] = discoveryOf({ "1/258/65532": 1 });
            expect(cover.config.position_template).to.equal(undefined);
            expect(cover.config.device_class).to.equal(undefined);
        });

        it("exposes a zigbee2mqtt cover", () => {
            const exposes = exposesOf(CURTAIN, relevantEndpointsOf(CURTAIN), capsFor(CURTAIN));
            expect(exposes[0].type).to.equal("cover");
            expect((exposes[0].features as Expose[]).map(f => [f.name, f.access])).to.deep.equal([
                ["state", 7],
                ["position", 7],
                ["tilt", 7],
            ]);
            expect(exposes[1]).to.include({ name: "moving", type: "enum", access: 5 });
        });
    });

    describe("routing", () => {
        it("accepts /set on control endpoints without OnOff", () => {
            expect(controllableEndpointsOf({ ...CURTAIN, "2/6/0": true, "3/1026/0": 2000 })).to.deep.equal([1, 2]);
        });

        it("still hands light properties to the light parser", () => {
            const light = { "1/6/0": false };
            expect(parseEndpointSet({ state: "ON" }, light, 1)?.actions).to.deep.equal([
                { clusterId: 6, commandName: "on", data: {} },
            ]);
        });

        it("reports properties nobody on the endpoint takes", () => {
            expect(parseEndpointSet({ position: 10, brightness: 5 }, CURTAIN, 1)?.warnings).to.deep.equal([
                'unsupported attribute "brightness"',
            ]);
        });
    });
});
