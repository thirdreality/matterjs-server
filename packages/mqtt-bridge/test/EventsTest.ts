/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { relevantEndpointsOf } from "../src/DeviceState.js";
import { deviceStateOf } from "../src/DeviceState.js";
import { discoveryMessagesOf } from "../src/Discovery.js";
import { deviceActionsOf, switchActionOf } from "../src/Events.js";
import { exposesOf } from "../src/Exposes.js";
import { lightCapabilitiesOf } from "../src/LightCapabilities.js";
import { Topics } from "../src/Topics.js";

// Momentary button with release, long press and multi-press up to 2 (MS | MSR | MSL | MSM)
const BUTTON = { "1/59/65532": 0b11110, "1/59/0": 2, "1/59/1": 0, "1/59/2": 2 };
// Simple momentary button without release reporting (doorbell)
const DOORBELL = { "1/59/65532": 0b10, "1/59/0": 2 };
// Two-position latching rocker
const ROCKER = { "1/59/65532": 0b1, "1/59/0": 2, "1/59/1": 1 };

describe("Events", () => {
    it("lists the actions a button can report", () => {
        expect(deviceActionsOf(BUTTON)).to.deep.equal(["single", "double", "hold", "release"]);
        expect(deviceActionsOf(DOORBELL)).to.deep.equal(["single"]);
        expect(deviceActionsOf(ROCKER)).to.deep.equal(["position_0", "position_1"]);
        expect(deviceActionsOf({ "1/6/0": true })).to.deep.equal([]);
    });

    it("reports a multi-press button once, on MultiPressComplete", () => {
        expect(switchActionOf(BUTTON, 1, 1, { newPosition: 1 })).to.equal(undefined);
        expect(switchActionOf(BUTTON, 1, 3, { previousPosition: 1 })).to.equal(undefined);
        expect(switchActionOf(BUTTON, 1, 6, { previousPosition: 1, totalNumberOfPressesCounted: 2 })).to.equal(
            "double",
        );
        expect(switchActionOf(BUTTON, 1, 6, { "0": 1, "1": 7 })).to.equal("many");
        expect(switchActionOf(BUTTON, 1, 2, { newPosition: 1 })).to.equal("hold");
        expect(switchActionOf(BUTTON, 1, 4, { previousPosition: 1 })).to.equal("release");
    });

    it("reports a button without multi-press on release, or on press without release reporting", () => {
        const releasing = { "1/59/65532": 0b110 };
        expect(switchActionOf(releasing, 1, 1, {})).to.equal(undefined);
        expect(switchActionOf(releasing, 1, 3, {})).to.equal("single");
        expect(switchActionOf(DOORBELL, 1, 1, { newPosition: 1 })).to.equal("single");
    });

    it("reports a latching switch position", () => {
        expect(switchActionOf(ROCKER, 1, 0, { newPosition: 0 })).to.equal("position_0");
        expect(deviceStateOf(ROCKER, relevantEndpointsOf(ROCKER), ep => lightCapabilitiesOf(ROCKER, ep))).to.deep.equal(
            {
                switch_position: 1,
            },
        );
    });

    it("suffixes the actions of a multi-button device with the endpoint", () => {
        const twoButtons = { "1/59/65532": 0b10, "2/59/65532": 0b10 };
        expect(deviceActionsOf(twoButtons)).to.deep.equal(["single_1", "single_2"]);
        expect(switchActionOf(twoButtons, 2, 1, {})).to.equal("single_2");
    });

    it("announces an event entity and a trigger per action", () => {
        const messages = discoveryMessagesOf(
            { device: "7" },
            BUTTON,
            relevantEndpointsOf(BUTTON),
            ep => lightCapabilitiesOf(BUTTON, ep),
            new Topics("matter2mqtt"),
        ).map(m => ({ topic: m.topic, config: JSON.parse(m.payload) }));
        const event = messages.find(m => m.topic === "homeassistant/event/matter2mqtt_7/action/config");
        expect(event?.config).to.include({
            state_topic: "matter2mqtt/7/action",
            value_template: '{ "event_type": "{{ value }}" }',
        });
        expect(event?.config.event_types).to.deep.equal(["single", "double", "hold", "release"]);
        const trigger = messages.find(
            m => m.topic === "homeassistant/device_automation/matter2mqtt_7/action_hold/config",
        );
        expect(trigger?.config).to.include({
            automation_type: "trigger",
            type: "action",
            subtype: "hold",
            payload: "hold",
            topic: "matter2mqtt/7/action",
        });
    });

    it("exposes the action enum", () => {
        const exposes = exposesOf(BUTTON, relevantEndpointsOf(BUTTON), ep => lightCapabilitiesOf(BUTTON, ep));
        expect(exposes).to.deep.include({
            type: "enum",
            name: "action",
            label: "Action",
            property: "action",
            access: 1,
            values: ["single", "double", "hold", "release"],
        });
    });
});
