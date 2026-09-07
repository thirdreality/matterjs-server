/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { hsvToXY } from "../src/ColorMath.js";
import { bridgeDiscoveryMessagesOf, discoveryMessagesOf } from "../src/Discovery.js";
import { lightCapabilitiesOf } from "../src/LightCapabilities.js";
import { Topics } from "../src/Topics.js";

// ThirdReality night light: ep1 full-color light, ep2 illuminance, ep3 occupancy
const NIGHT_LIGHT = {
    "1/6/0": true,
    "1/8/0": 200,
    "1/768/65532": 31,
    "1/768/16395": 25,
    "1/768/16396": 1000,
    "2/1024/0": 21336,
    "3/1030/0": 1,
};

const topics = new Topics("matter2mqtt");
const capsOf = (attributes: Record<string, unknown>) => (endpoint: number) => lightCapabilitiesOf(attributes, endpoint);

function messagesFor(attributes: Record<string, unknown>, endpoints: number[], device = "8") {
    return discoveryMessagesOf(
        {
            device,
            vendorName: "ThirdReality",
            productName: "Smart Color Night Light",
            serialNumber: "3RM01-4115-00210",
            serverVersion: "1.4.0-tr.1",
        },
        attributes,
        endpoints,
        capsOf(attributes),
        topics,
    );
}

describe("ColorMath", () => {
    it("converts primary hues to the expected xy region", () => {
        const red = hsvToXY(0, 100);
        expect(red.x).to.be.greaterThan(0.6);
        const green = hsvToXY(120, 100);
        expect(green.y).to.be.greaterThan(0.6);
        const blue = hsvToXY(240, 100);
        expect(blue.x).to.be.lessThan(0.2);
        expect(blue.y).to.be.lessThan(0.1);
    });

    it("maps white (zero saturation) to the D65-ish center", () => {
        const { x, y } = hsvToXY(0, 0);
        expect(Math.abs(x - 0.3227)).to.be.lessThan(0.02);
        expect(Math.abs(y - 0.329)).to.be.lessThan(0.02);
    });
});

describe("bridgeDiscoveryMessagesOf", () => {
    it("announces the bridge device with connectivity, version and commission entities", () => {
        const messages = bridgeDiscoveryMessagesOf("1.4.0-tr.1", topics);
        expect(messages.map(m => m.topic)).to.deep.equal([
            "homeassistant/binary_sensor/matter2mqtt_bridge/connection_state/config",
            "homeassistant/sensor/matter2mqtt_bridge/version/config",
            "homeassistant/text/matter2mqtt_bridge/commission_code/config",
            "homeassistant/sensor/matter2mqtt_bridge/commission_status/config",
            "homeassistant/button/matter2mqtt_bridge/restart/config",
        ]);
        const commission = JSON.parse(messages[2].payload);
        expect(commission.command_topic).to.equal("matter2mqtt/bridge/request/commission");
        expect(commission.command_template).to.equal('{"code":"{{ value }}"}');
        expect(commission.state_topic).to.equal("matter2mqtt/bridge/commission_code");
        const status = JSON.parse(messages[3].payload);
        expect(status.state_topic).to.equal("matter2mqtt/bridge/commission_status");
        const restart = JSON.parse(messages[4].payload);
        expect(restart.command_topic).to.equal("matter2mqtt/bridge/request/restart");
        expect(restart.device_class).to.equal("restart");
        const connection = JSON.parse(messages[0].payload);
        expect(connection.state_topic).to.equal("matter2mqtt/bridge/state");
        expect(connection.payload_on).to.equal("online");
        expect(connection.device_class).to.equal("connectivity");
        expect(connection.device.identifiers).to.deep.equal(["matter2mqtt_bridge"]);
        const version = JSON.parse(messages[1].payload);
        expect(version.value_template).to.equal("{{ value_json.version }}");
        expect(version.device.sw_version).to.equal("1.4.0-tr.1");
    });
});

describe("Discovery", () => {
    it("generates light, illuminance and occupancy entities for the night light", () => {
        const messages = messagesFor(NIGHT_LIGHT, [1, 2, 3]);
        expect(messages.map(m => m.topic)).to.deep.equal([
            "homeassistant/light/matter2mqtt_8/light/config",
            "homeassistant/sensor/matter2mqtt_8/illuminance/config",
            "homeassistant/binary_sensor/matter2mqtt_8/occupancy/config",
        ]);
    });

    it("describes the light with json schema and device capabilities", () => {
        const messages = messagesFor(NIGHT_LIGHT, [1, 2, 3]);
        const light = JSON.parse(messages[0].payload);
        expect(light.schema).to.equal("json");
        expect(light.state_topic).to.equal("matter2mqtt/8");
        expect(light.command_topic).to.equal("matter2mqtt/8/set");
        expect(light.brightness_scale).to.equal(254);
        expect(light.supported_color_modes).to.deep.equal(["hs", "xy", "color_temp"]);
        expect(light.min_mireds).to.equal(25);
        expect(light.max_mireds).to.equal(1000);
        expect(light.unique_id).to.equal("matter2mqtt_8_light_1");
        expect(light.device.identifiers).to.deep.equal(["matter2mqtt_8"]);
        expect(light.device.manufacturer).to.equal("ThirdReality");
        expect(light.origin.sw_version).to.equal("1.4.0-tr.1");
        expect(light.availability_mode).to.equal("all");
        expect(light.availability[0].topic).to.equal("matter2mqtt/bridge/state");
        expect(light.availability[0].value_template).to.equal("{{ value_json.state }}");
        expect(light.availability[1].topic).to.equal("matter2mqtt/8/availability");
    });

    it("uses templates matching the state payload for sensors", () => {
        const messages = messagesFor(NIGHT_LIGHT, [1, 2, 3]);
        const illuminance = JSON.parse(messages[1].payload);
        expect(illuminance.value_template).to.equal("{{ value_json.illuminance }}");
        expect(illuminance.device_class).to.equal("illuminance");
        expect(illuminance.unit_of_measurement).to.equal("lx");
        const occupancy = JSON.parse(messages[2].payload);
        expect(occupancy.device_class).to.equal("motion");
        expect(occupancy.payload_on).to.equal(true);
    });

    it("generates a switch for an OnOff-only device", () => {
        const attributes = { "1/6/0": false };
        const messages = messagesFor(attributes, [1], "2");
        expect(messages).to.have.length(1);
        const config = JSON.parse(messages[0].payload);
        expect(messages[0].topic).to.equal("homeassistant/switch/matter2mqtt_2/switch/config");
        expect(config.command_topic).to.equal("matter2mqtt/2/set");
        expect(config.payload_on).to.equal('{"state":"ON"}');
        expect(config.value_template).to.equal("{{ value_json.state }}");
    });

    it("suffixes colliding switch entities and their templates", () => {
        const attributes = { "1/6/0": true, "2/6/0": false };
        const messages = messagesFor(attributes, [1, 2], "5");
        expect(messages.map(m => m.topic)).to.deep.equal([
            "homeassistant/switch/matter2mqtt_5/switch_1/config",
            "homeassistant/switch/matter2mqtt_5/switch_2/config",
        ]);
        const first = JSON.parse(messages[0].payload);
        expect(first.value_template).to.equal("{{ value_json.state_1 }}");
        expect(first.command_topic).to.equal("matter2mqtt/5/1/set");
    });

    it("adds a device-level battery sensor from PowerSource", () => {
        const attributes = { "1/6/0": true, "0/47/12": 187 };
        const messages = messagesFor(attributes, [1], "3");
        const battery = messages.find(m => m.topic.includes("/battery/"));
        expect(battery).to.exist;
        const config = JSON.parse((battery as { payload: string }).payload);
        expect(config.device_class).to.equal("battery");
        expect(config.entity_category).to.equal("diagnostic");
    });
});
