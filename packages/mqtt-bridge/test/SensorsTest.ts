/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    deviceStateOf,
    isDeviceLevelStateAttribute,
    isStateAttribute,
    relevantEndpointsOf,
} from "../src/DeviceState.js";
import { discoveryMessagesOf } from "../src/Discovery.js";
import { lightCapabilitiesOf } from "../src/LightCapabilities.js";
import { Topics } from "../src/Topics.js";

const topics = new Topics("matter2mqtt");

function stateOf(attributes: Record<string, unknown>) {
    return deviceStateOf(attributes, relevantEndpointsOf(attributes), ep => lightCapabilitiesOf(attributes, ep));
}

function entitiesOf(attributes: Record<string, unknown>) {
    const messages = discoveryMessagesOf(
        { device: "9" },
        attributes,
        relevantEndpointsOf(attributes),
        ep => lightCapabilitiesOf(attributes, ep),
        topics,
    );
    return new Map(
        messages.map(m => [
            m.topic.replace("homeassistant/", "").replace("/matter2mqtt_9/", "/").replace("/config", ""),
            JSON.parse(m.payload),
        ]),
    );
}

describe("Sensors", () => {
    describe("measurements", () => {
        it("converts pressure, flow and soil moisture to zigbee2mqtt units", () => {
            const attributes = { "1/1027/0": 1013, "2/1028/0": 125, "3/1072/1": 42 };
            expect(stateOf(attributes)).to.deep.equal({ pressure: 1013, flow: 12.5, soil_moisture: 42 });
            const entities = entitiesOf(attributes);
            expect(entities.get("sensor/pressure")).to.include({
                device_class: "pressure",
                unit_of_measurement: "hPa",
            });
            expect(entities.get("sensor/flow")).to.include({
                device_class: "volume_flow_rate",
                unit_of_measurement: "m³/h",
            });
            expect(entities.get("sensor/soil_moisture")).to.include({
                device_class: "moisture",
                unit_of_measurement: "%",
            });
        });

        it("skips a measurement the device reports as unknown (null)", () => {
            expect(stateOf({ "1/1027/0": null })).to.deep.equal({});
            expect(entitiesOf({ "1/1027/0": null }).has("sensor/pressure")).to.equal(true);
        });

        it("publishes air quality as an enum", () => {
            const attributes = { "1/91/0": 5 };
            expect(stateOf(attributes)).to.deep.equal({ air_quality: "very_poor" });
            const entity = entitiesOf(attributes).get("sensor/air_quality");
            expect(entity.device_class).to.equal("enum");
            expect(entity.options).to.deep.equal([
                "unknown",
                "good",
                "fair",
                "moderate",
                "poor",
                "very_poor",
                "extremely_poor",
            ]);
        });
    });

    describe("concentrations", () => {
        it("publishes CO2 in ppm with the carbon_dioxide class", () => {
            const attributes = { "1/1037/0": 612.4, "1/1037/8": 0 };
            expect(stateOf(attributes)).to.deep.equal({ co2: 612.4 });
            expect(entitiesOf(attributes).get("sensor/co2")).to.include({
                device_class: "carbon_dioxide",
                unit_of_measurement: "ppm",
                state_class: "measurement",
            });
        });

        it("converts within a dimension to the zigbee2mqtt unit", () => {
            expect(stateOf({ "1/1037/0": 612400, "1/1037/8": 1 })).to.deep.equal({ co2: 612.4 });
            expect(stateOf({ "1/1066/0": 0.0123, "1/1066/8": 3 })).to.deep.equal({ pm25: 12.3 });
        });

        it("keeps a unit from another dimension as is, without a device class", () => {
            const attributes = { "1/1037/0": 1.1, "1/1037/8": 3 };
            expect(stateOf(attributes)).to.deep.equal({ co2: 1.1 });
            const entity = entitiesOf(attributes).get("sensor/co2");
            expect(entity.unit_of_measurement).to.equal("mg/m³");
            expect(entity.device_class).to.equal(undefined);
        });

        it("assumes the cluster's usual unit when the device names none", () => {
            expect(entitiesOf({ "1/1066/0": 8 }).get("sensor/pm25")).to.include({
                device_class: "pm25",
                unit_of_measurement: "µg/m³",
            });
        });

        it("uses the parts class for VOC reported in ppb", () => {
            const attributes = { "1/1070/0": 220, "1/1070/8": 1 };
            expect(stateOf(attributes)).to.deep.equal({ voc: 220 });
            expect(entitiesOf(attributes).get("sensor/voc")).to.include({
                device_class: "volatile_organic_compounds_parts",
                unit_of_measurement: "ppb",
            });
        });

        it("publishes the level of a level-only sensor without a value", () => {
            const attributes = { "1/1067/10": 3 };
            expect(stateOf(attributes)).to.deep.equal({ formaldehyd_level: "high" });
            const entities = entitiesOf(attributes);
            expect(entities.has("sensor/formaldehyd")).to.equal(false);
            expect(entities.get("sensor/formaldehyd_level").options).to.deep.equal([
                "unknown",
                "low",
                "medium",
                "high",
                "critical",
            ]);
        });
    });

    describe("smoke and CO alarm", () => {
        const ALARM = {
            "1/92/0": 1,
            "1/92/1": 2,
            "1/92/2": 0,
            "1/92/3": 1,
            "1/92/4": 0,
            "1/92/5": false,
            "1/92/6": false,
            "1/92/7": 1,
        };

        it("derives the zigbee2mqtt alarm properties", () => {
            expect(stateOf(ALARM)).to.deep.equal({
                smoke: true,
                smoke_state: "critical",
                carbon_monoxide: false,
                co_state: "normal",
                alarm_state: "smoke_alarm",
                test: false,
                muted: false,
                battery_low: true,
                hardware_fault: false,
                end_of_service: true,
            });
        });

        it("announces the alarms with their classes", () => {
            const entities = entitiesOf(ALARM);
            expect(entities.get("binary_sensor/smoke")).to.include({
                device_class: "smoke",
                payload_on: true,
                payload_off: false,
                value_template: "{{ value_json.smoke }}",
            });
            expect(entities.get("binary_sensor/carbon_monoxide").device_class).to.equal("carbon_monoxide");
            expect(entities.get("binary_sensor/end_of_service")).to.include({
                device_class: "problem",
                entity_category: "diagnostic",
            });
        });

        it("omits the CO properties of a smoke-only alarm", () => {
            const state = stateOf({ "1/92/0": 0, "1/92/1": 0 });
            expect(state).to.deep.equal({ smoke: false, smoke_state: "normal", alarm_state: "normal" });
        });
    });

    describe("electrical measurement", () => {
        it("converts power, voltage, current, frequency and energy", () => {
            const attributes = {
                "1/144/8": 23456,
                "1/144/4": 229800,
                "1/144/5": 102,
                "1/144/14": 50010,
                "1/145/1": { "0": 1234567890, "1": 1700000000 },
                "1/145/2": { energy: 5000000n },
            };
            expect(stateOf(attributes)).to.deep.equal({
                power: 23.46,
                voltage: 229.8,
                current: 0.102,
                ac_frequency: 50.01,
                energy: 1234.568,
                produced_energy: 5,
            });
            const entities = entitiesOf(attributes);
            expect(entities.get("sensor/energy")).to.include({
                device_class: "energy",
                unit_of_measurement: "kWh",
                state_class: "total_increasing",
            });
            expect(entities.get("sensor/power")).to.include({ device_class: "power", unit_of_measurement: "W" });
        });

        it("falls back to the RMS values", () => {
            expect(stateOf({ "1/144/11": 120000, "1/144/12": 1500 })).to.deep.equal({ voltage: 120, current: 1.5 });
        });
    });

    describe("device-level power source", () => {
        it("adds battery, battery_low and battery voltage", () => {
            const attributes = { "1/1026/0": 2000, "0/47/12": 150, "0/47/14": 0, "0/47/11": 2950 };
            expect(stateOf(attributes)).to.deep.equal({
                temperature: 20,
                battery: 75,
                battery_low: false,
                voltage: 2950,
            });
            const entities = entitiesOf(attributes);
            expect(entities.get("binary_sensor/battery_low")).to.include({ device_class: "battery" });
            expect(entities.get("sensor/voltage")).to.include({
                unit_of_measurement: "mV",
                unique_id: "matter2mqtt_9_voltage",
            });
        });

        it("lets an endpoint property take precedence over the device-level one", () => {
            const attributes = { "1/144/4": 230000, "0/47/11": 3000, "1/92/3": 0, "0/47/14": 2 };
            expect(stateOf(attributes)).to.deep.include({ voltage: 230, battery_low: false });
            const entities = entitiesOf(attributes);
            expect(entities.get("sensor/voltage").unit_of_measurement).to.equal("V");
            expect(entities.get("binary_sensor/battery_low").unique_id).to.equal("matter2mqtt_9_battery_low_1");
        });

        it("treats power source attributes as device-level state", () => {
            expect(isDeviceLevelStateAttribute(47, 14)).to.equal(true);
            expect(isDeviceLevelStateAttribute(47, 11)).to.equal(true);
            expect(isStateAttribute(1037, 8)).to.equal(true);
            expect(isStateAttribute(92, 1)).to.equal(true);
            expect(isStateAttribute(145, 1)).to.equal(true);
        });
    });

    it("counts sensor-only endpoints as relevant", () => {
        expect(relevantEndpointsOf({ "0/47/12": 100, "2/1027/0": 1000, "3/144/8": 0, "4/29/0": [] })).to.deep.equal([
            2, 3,
        ]);
    });
});
