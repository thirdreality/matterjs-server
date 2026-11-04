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

    describe("lock", () => {
        const LOCK = { "1/257/0": 1, "1/257/3": 1 };

        it("publishes state, lock_state and door_state", () => {
            expect(stateOf(LOCK)).to.deep.equal({ state: "LOCK", lock_state: "locked", door_state: "closed" });
            expect(stateOf({ "1/257/0": 3 })).to.deep.equal({ state: "UNLOCK", lock_state: "unlatched" });
            expect(stateOf({ "1/257/0": null })).to.deep.equal({});
        });

        it("locks and unlocks, with an optional pin code", () => {
            expect(parseEndpointSet({ state: "lock" }, LOCK, 1)).to.deep.equal({
                actions: [{ clusterId: 257, commandName: "lockDoor", data: {} }],
                warnings: [],
            });
            expect(parseEndpointSet({ state: "UNLOCK", pin_code: "1234" }, LOCK, 1)?.actions).to.deep.equal([
                { clusterId: 257, commandName: "unlockDoor", data: { pinCode: "hex:31323334" } },
            ]);
        });

        it("warns when the lock wants a pin and none is given", () => {
            const pinLock = { ...LOCK, "1/257/51": true };
            expect(parseEndpointSet({ state: "UNLOCK" }, pinLock, 1)?.warnings).to.deep.equal([
                "this lock requires a pin_code for remote operation",
            ]);
            expect(parseEndpointSet({ state: "OPEN" }, LOCK, 1)?.warnings).to.deep.equal([
                'invalid lock state "OPEN": expected LOCK or UNLOCK',
            ]);
        });

        it("announces a Home Assistant lock and the door state", () => {
            const [lockEntity, door] = discoveryOf(LOCK);
            expect(lockEntity.topic).to.equal("homeassistant/lock/matter2mqtt_4/lock/config");
            expect(lockEntity.config).to.include({
                payload_lock: '{"state":"LOCK"}',
                state_unlocked: "UNLOCK",
                value_template: "{{ value_json.state }}",
            });
            expect(door.topic).to.equal("homeassistant/sensor/matter2mqtt_4/door_state/config");
            expect(door.config.options).to.include("jammed");
        });

        it("exposes a zigbee2mqtt lock", () => {
            const exposes = exposesOf(LOCK, relevantEndpointsOf(LOCK), capsFor(LOCK));
            expect(exposes.map(e => e.type)).to.deep.equal(["lock", "enum"]);
            expect((exposes[0].features as Expose[])[0]).to.include({ value_on: "LOCK", value_off: "UNLOCK" });
        });
    });

    describe("thermostat", () => {
        // Heating and cooling with auto mode (FeatureMap HEAT | COOL | AUTO), currently heating
        const THERMOSTAT = {
            "1/513/65532": 0b100011,
            "1/513/0": 2150,
            "1/513/3": 700,
            "1/513/4": 3000,
            "1/513/5": 1600,
            "1/513/6": 3200,
            "1/513/8": 40,
            "1/513/16": -5,
            "1/513/17": 2600,
            "1/513/18": 2050,
            "1/513/28": 4,
            "1/513/41": 1,
        };

        it("publishes the zigbee2mqtt thermostat properties", () => {
            expect(stateOf(THERMOSTAT)).to.deep.equal({
                local_temperature: 21.5,
                pi_heating_demand: 40,
                occupied_heating_setpoint: 20.5,
                occupied_cooling_setpoint: 26,
                system_mode: "heat",
                running_state: "heat",
                local_temperature_calibration: -0.5,
            });
        });

        it("reads the running state from a number or a decoded bitmap", () => {
            expect(stateOf({ ...THERMOSTAT, "1/513/41": 0b10000 }).running_state).to.equal("cool");
            expect(stateOf({ ...THERMOSTAT, "1/513/41": { fan: true } }).running_state).to.equal("fan_only");
            expect(stateOf({ ...THERMOSTAT, "1/513/41": 0 }).running_state).to.equal("idle");
        });

        it("writes setpoints, the system mode and the calibration", () => {
            expect(
                parseEndpointSet(
                    { occupied_heating_setpoint: 21.5, system_mode: "COOL", local_temperature_calibration: "1.2" },
                    THERMOSTAT,
                    1,
                ),
            ).to.deep.equal({
                actions: [
                    { clusterId: 513, attributeId: 18, value: 2150 },
                    { clusterId: 513, attributeId: 28, value: 3 },
                    { clusterId: 513, attributeId: 16, value: 12 },
                ],
                warnings: [],
            });
        });

        it("refuses setpoints and modes the thermostat cannot take", () => {
            const heatOnly = { "1/513/65532": 1, "1/513/18": 2000 };
            expect(
                parseEndpointSet({ occupied_cooling_setpoint: 24, system_mode: "turbo" }, heatOnly, 1)?.warnings,
            ).to.deep.equal([
                "occupied_cooling_setpoint not supported by this thermostat",
                'invalid system_mode "turbo": expected one of off, auto, cool, heat, emergency_heating, precooling, fan_only, dry, sleep',
            ]);
            expect(parseEndpointSet({ local_temperature_calibration: 4 }, THERMOSTAT, 1)?.warnings).to.deep.equal([
                "local_temperature_calibration 4 out of range -2.5..2.5",
            ]);
        });

        it("announces a heat/cool climate entity with low and high targets", () => {
            const [climate, demand] = discoveryOf(THERMOSTAT);
            expect(climate.topic).to.equal("homeassistant/climate/matter2mqtt_4/climate/config");
            expect(climate.config).to.include({
                min_temp: 7,
                max_temp: 32,
                mode_command_template: '{"system_mode": "{{ value }}"}',
                current_temperature_template: "{{ value_json.local_temperature }}",
                temperature_low_command_template: '{"occupied_heating_setpoint": {{ value }}}',
                temperature_high_state_template: "{{ value_json.occupied_cooling_setpoint }}",
            });
            expect(climate.config.modes).to.deep.equal(["off", "auto", "cool", "heat"]);
            expect(climate.config.temperature_command_template).to.equal(undefined);
            expect(demand.topic).to.equal("homeassistant/sensor/matter2mqtt_4/pi_heating_demand/config");
        });

        it("uses a single target for a cooling-only air conditioner and adds its modes", () => {
            const ac = {
                "1/29/0": [{ "0": 0x0072, "1": 2 }],
                "1/513/65532": 2,
                "1/513/17": 2400,
                "1/513/28": 3,
            };
            const [climate] = discoveryOf(ac).filter(m => m.topic.includes("/climate/"));
            expect(climate.config.temperature_command_template).to.equal('{"occupied_cooling_setpoint": {{ value }}}');
            expect(climate.config.modes).to.deep.equal(["off", "cool", "fan_only", "dry"]);
        });

        it("exposes a zigbee2mqtt climate", () => {
            const exposes = exposesOf(THERMOSTAT, relevantEndpointsOf(THERMOSTAT), capsFor(THERMOSTAT));
            expect(exposes[0].type).to.equal("climate");
            const features = exposes[0].features as Expose[];
            expect(features.map(f => f.name)).to.deep.equal([
                "local_temperature",
                "occupied_heating_setpoint",
                "occupied_cooling_setpoint",
                "system_mode",
                "running_state",
                "local_temperature_calibration",
            ]);
            expect(features[1]).to.include({ value_min: 7, value_max: 30, value_step: 0.5, access: 7 });
            expect(exposes[1]).to.include({ name: "pi_heating_demand", unit: "%" });
        });
    });

    describe("fan", () => {
        // Off/low/medium/high/auto, percent and multi-speed, rocking and airflow direction
        const FAN = {
            "1/514/0": 2,
            "1/514/1": 2,
            "1/514/2": 50,
            "1/514/3": 48,
            "1/514/4": 10,
            "1/514/5": 5,
            "1/514/6": 5,
            "1/514/7": 3,
            "1/514/8": 0,
            "1/514/11": 1,
        };

        it("publishes zigbee2mqtt fan properties", () => {
            expect(stateOf(FAN)).to.deep.equal({
                fan_state: "ON",
                fan_mode: "medium",
                percentage: 48,
                fan_speed: 5,
                oscillation: false,
                airflow_direction: "reverse",
            });
            expect(stateOf({ "1/514/0": 0 })).to.deep.equal({ fan_state: "OFF", fan_mode: "off" });
        });

        it("writes the fan attributes", () => {
            expect(
                parseEndpointSet(
                    {
                        fan_state: "ON",
                        fan_mode: "HIGH",
                        percentage: "30",
                        oscillation: true,
                        airflow_direction: "forward",
                    },
                    FAN,
                    1,
                )?.actions,
            ).to.deep.equal([
                { clusterId: 514, attributeId: 0, value: 4 },
                { clusterId: 514, attributeId: 0, value: 3 },
                { clusterId: 514, attributeId: 2, value: 30 },
                { clusterId: 514, attributeId: 8, value: 3 },
                { clusterId: 514, attributeId: 11, value: 0 },
            ]);
            expect(parseEndpointSet({ fan_speed: 11 }, FAN, 1)?.warnings).to.deep.equal([
                "invalid fan_speed 11: expected 0-10",
            ]);
            expect(parseEndpointSet({ oscillation: true }, { "1/514/0": 1 }, 1)?.warnings).to.deep.equal([
                "oscillation not supported by this fan",
            ]);
        });

        it("announces a Home Assistant fan", () => {
            const [entity] = discoveryOf(FAN);
            expect(entity.topic).to.equal("homeassistant/fan/matter2mqtt_4/fan/config");
            expect(entity.config).to.include({
                payload_on: '{"fan_state":"ON"}',
                state_value_template: "{{ value_json.fan_state }}",
                percentage_command_template: '{"percentage": {{ value }}}',
                payload_oscillation_on: "true",
                direction_value_template: "{{ value_json.airflow_direction }}",
            });
            expect(entity.config.preset_modes).to.deep.equal(["auto"]);
        });

        it("exposes the modes the fan's sequence allows", () => {
            const exposes = exposesOf(FAN, [1], capsFor(FAN));
            const mode = (exposes[0].features as Expose[]).find(f => f.name === "fan_mode") as Expose;
            expect(mode.values).to.deep.equal(["off", "low", "medium", "high", "auto"]);
        });
    });

    describe("valve", () => {
        const VALVE = { "1/129/4": 1, "1/129/6": 60, "1/129/3": 120 };

        it("publishes state, position and remaining duration", () => {
            expect(stateOf(VALVE)).to.deep.equal({ state: "OPEN", position: 60, remaining_duration: 120 });
            expect(stateOf({ "1/129/4": 2 })).to.deep.equal({});
        });

        it("opens with a level and duration, and closes", () => {
            expect(parseEndpointSet({ state: "OPEN", position: 40, duration: 600 }, VALVE, 1)?.actions).to.deep.equal([
                { clusterId: 129, commandName: "open", data: { openDuration: 600, targetLevel: 40 } },
            ]);
            expect(parseEndpointSet({ position: 0 }, VALVE, 1)?.actions[0]).to.include({ commandName: "close" });
            expect(parseEndpointSet({ state: "close" }, VALVE, 1)?.actions[0]).to.include({ commandName: "close" });
            expect(parseEndpointSet({ position: 40 }, { "1/129/4": 0 }, 1)?.warnings).to.deep.equal([
                "position not supported by this valve",
            ]);
        });

        it("announces a Home Assistant valve with position", () => {
            const [entity, remaining] = discoveryOf(VALVE);
            expect(entity.topic).to.equal("homeassistant/valve/matter2mqtt_4/valve/config");
            expect(entity.config).to.include({ reports_position: true, device_class: "water" });
            expect(remaining.config).to.include({ device_class: "duration", unit_of_measurement: "s" });
        });
    });

    describe("mode select", () => {
        const MODES = {
            "1/80/0": "Wash program",
            "1/80/2": [
                { "0": "Normal", "1": 0, "2": [] },
                { "0": "Eco", "1": 4, "2": [] },
            ],
            "1/80/3": 4,
        };

        it("publishes the current mode by label and changes it by label or number", () => {
            expect(stateOf(MODES)).to.deep.equal({ mode: "Eco" });
            expect(parseEndpointSet({ mode: "Normal" }, MODES, 1)?.actions).to.deep.equal([
                { clusterId: 80, commandName: "changeToMode", data: { newMode: 0 } },
            ]);
            expect(parseEndpointSet({ mode: 4 }, MODES, 1)?.actions[0]).to.deep.include({ data: { newMode: 4 } });
            expect(parseEndpointSet({ mode: "Turbo" }, MODES, 1)?.warnings).to.deep.equal([
                'invalid mode "Turbo": expected one of Normal, Eco',
            ]);
        });

        it("announces a select named after the cluster description", () => {
            const [entity] = discoveryOf(MODES);
            expect(entity.topic).to.equal("homeassistant/select/matter2mqtt_4/mode/config");
            expect(entity.config).to.include({ name: "Wash program", command_template: '{"mode": "{{ value }}"}' });
            expect(entity.config.options).to.deep.equal(["Normal", "Eco"]);
        });
    });

    describe("settings", () => {
        it("writes pump modes by name", () => {
            const pump = { "1/6/0": true, "1/512/32": 0, "1/512/33": 7 };
            expect(stateOf(pump)).to.include({ pump_operation_mode: "normal", pump_control_mode: "automatic" });
            expect(parseEndpointSet({ pump_operation_mode: "maximum" }, pump, 1)?.actions).to.deep.equal([
                { clusterId: 512, attributeId: 32, value: 2 },
            ]);
            const select = discoveryOf(pump).find(m => m.topic.endsWith("/pump_control_mode/config"));
            expect(select?.config).to.include({ entity_category: "config" });
        });

        it("starts a smoke alarm self test and sets the sensitivity", () => {
            const alarm = { "1/92/0": 0, "1/92/1": 0, "1/92/11": 1 };
            expect(stateOf(alarm)).to.include({ smoke_sensitivity: "standard" });
            expect(parseEndpointSet({ self_test: true, smoke_sensitivity: "high" }, alarm, 1)?.actions).to.deep.equal([
                { clusterId: 92, attributeId: 11, value: 0 },
                { clusterId: 92, commandName: "selfTestRequest", data: {} },
            ]);
            const button = discoveryOf(alarm).find(m => m.topic.includes("/button/"));
            expect(button?.config).to.include({ payload_press: '{"self_test": true}' });
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
