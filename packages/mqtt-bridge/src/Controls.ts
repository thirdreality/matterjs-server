/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AttributesData } from "@matter-server/ws-controller";
import {
    ColorControl,
    DoorLock,
    FanControl,
    Identify,
    LevelControl,
    OnOff,
    ModeSelect,
    PumpConfigurationAndControl,
    SmokeCoAlarm,
    Thermostat,
    ValveConfigurationAndControl,
    WindowCovering,
} from "@matter/main/clusters";
import type { Expose } from "./Exposes.js";
import { lightCapabilitiesOf, ONOFF_CLUSTER_ID } from "./LightCapabilities.js";
import { COLOR_TEMP_PRESETS, parseSetObject, type DeviceCommand } from "./SetCommands.js";

/** An attribute write, for zigbee2mqtt properties that map onto a writable Matter attribute. */
export interface DeviceWrite {
    clusterId: number;
    attributeId: number;
    value: unknown;
}

export type DeviceAction = DeviceCommand | DeviceWrite;

export function isDeviceWrite(action: DeviceAction): action is DeviceWrite {
    return "attributeId" in action;
}

/** What a control needs to build its Home Assistant entities. */
export interface ControlDiscoveryContext {
    /** Published name of a state property of this endpoint, with its `_<endpoint>` suffix if any. */
    nameOf(key: string): string;
    /** `/set` topic addressing this endpoint, where properties are given without suffix. */
    commandTopic: string;
    /** Entity name, numbered when the device has several endpoints of this kind. */
    entityName(base: string): string;
}

export interface ControlEntity {
    component: string;
    /** Object id before the `_<endpoint>` suffix. */
    objectId: string;
    config: Record<string, unknown>;
}

/**
 * A controllable zigbee2mqtt device type (cover, lock, climate, ...) on one endpoint: its state
 * properties, the `/set` properties it accepts, and its Home Assistant entity and exposes.
 */
export interface Control {
    present(attributes: AttributesData, endpoint: number): boolean;
    /** State property names the endpoint publishes, from capabilities rather than current values. */
    keys(attributes: AttributesData, endpoint: number): string[];
    /** `<cluster>/<attribute>` paths whose changes require a re-publish. */
    paths: readonly string[];
    state(attributes: AttributesData, endpoint: number): Record<string, unknown>;
    /** `/set` properties this control takes on its endpoint; what is left goes to the light parser. */
    setKeys: readonly string[];
    parse(message: Record<string, unknown>, attributes: AttributesData, endpoint: number): ParsedActions;
    /** The suffix decision follows this key: the entity is numbered when it is. */
    primaryKey: string;
    discovery(attributes: AttributesData, endpoint: number, ctx: ControlDiscoveryContext): ControlEntity[];
    exposes(attributes: AttributesData, endpoint: number, property: (key: string) => string): Expose[];
}

export interface ParsedActions {
    actions: DeviceAction[];
    warnings: string[];
}

const READ_WRITE = 7;
const READ_ONLY = 5;

function raw(attributes: AttributesData, endpoint: number, cluster: number, attribute: number): unknown {
    return attributes[`${endpoint}/${cluster}/${attribute}`];
}

function numberAt(attributes: AttributesData, endpoint: number, cluster: number, attribute: number) {
    const value = raw(attributes, endpoint, cluster, attribute);
    return typeof value === "number" ? value : undefined;
}

function percentOf(value: unknown, key: string, warnings: string[]): number | undefined {
    const number = typeof value === "string" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 100) {
        warnings.push(`invalid ${key} ${JSON.stringify(value)}: expected 0-100`);
        return undefined;
    }
    return number;
}

// Cover. zigbee2mqtt counts position from closed (0) to open (100); Matter counts closure in 1/100 %
// from open (0) to closed (10000).

const COVER = WindowCovering.Cluster.id;
const COVER_OPERATIONAL_STATUS = 10;
const COVER_END_PRODUCT_TYPE = 13;
const COVER_LIFT_PERCENT_100THS = 14;
const COVER_TILT_PERCENT_100THS = 15;
const FEATURE_MAP = 65532;

/** Home Assistant cover device class per EndProductType. */
function coverDeviceClassOf(endProductType: number | undefined): string | undefined {
    if (endProductType === undefined) {
        return undefined;
    }
    if (endProductType <= 8 || endProductType === 18) {
        return "shade";
    }
    if (endProductType <= 13) {
        return endProductType === 11 ? "curtain" : "blind";
    }
    if (endProductType <= 16) {
        return "curtain";
    }
    if (endProductType === 17 || endProductType === 22 || endProductType === 23) {
        return "shutter";
    }
    if (endProductType <= 21) {
        return "awning";
    }
    return undefined;
}

function coverPositionOf(attributes: AttributesData, endpoint: number, attribute: number): number | undefined {
    const closed = numberAt(attributes, endpoint, COVER, attribute);
    return closed === undefined ? undefined : Math.round(100 - closed / 100);
}

/** OperationalStatus global field (bits 0-1): 0 stopped, 1 opening, 2 closing. */
function coverMovingOf(attributes: AttributesData, endpoint: number): string | undefined {
    const status = raw(attributes, endpoint, COVER, COVER_OPERATIONAL_STATUS);
    let global: unknown;
    if (typeof status === "number") {
        global = status & 3;
    } else if (typeof status === "object" && status !== null) {
        const record = status as Record<string, unknown>;
        global = record.global ?? record["0"];
    }
    return global === 1 ? "UP" : global === 2 ? "DOWN" : global === 0 ? "STOP" : undefined;
}

const cover: Control = {
    present: (attributes, endpoint) => raw(attributes, endpoint, COVER, FEATURE_MAP) !== undefined,
    keys: (attributes, endpoint) => {
        const keys = ["state"];
        if (raw(attributes, endpoint, COVER, COVER_LIFT_PERCENT_100THS) !== undefined) {
            keys.push("position");
        }
        if (raw(attributes, endpoint, COVER, COVER_TILT_PERCENT_100THS) !== undefined) {
            keys.push("tilt");
        }
        if (raw(attributes, endpoint, COVER, COVER_OPERATIONAL_STATUS) !== undefined) {
            keys.push("moving");
        }
        return keys;
    },
    paths: [
        `${COVER}/${COVER_OPERATIONAL_STATUS}`,
        `${COVER}/${COVER_LIFT_PERCENT_100THS}`,
        `${COVER}/${COVER_TILT_PERCENT_100THS}`,
    ],
    state: (attributes, endpoint) => {
        const state: Record<string, unknown> = {};
        const position = coverPositionOf(attributes, endpoint, COVER_LIFT_PERCENT_100THS);
        const tilt = coverPositionOf(attributes, endpoint, COVER_TILT_PERCENT_100THS);
        const moving = coverMovingOf(attributes, endpoint);
        // zigbee2mqtt reports a cover as open unless it is fully closed
        const openness = position ?? tilt;
        if (openness !== undefined) {
            state.state = openness > 0 ? "OPEN" : "CLOSE";
        }
        if (position !== undefined) {
            state.position = position;
        }
        if (tilt !== undefined) {
            state.tilt = tilt;
        }
        if (moving !== undefined) {
            state.moving = moving;
        }
        return state;
    },
    setKeys: ["state", "position", "tilt"],
    parse: (message, attributes, endpoint) => {
        const actions: DeviceAction[] = [];
        const warnings: string[] = [];
        const features = numberAt(attributes, endpoint, COVER, FEATURE_MAP) ?? 0;
        if (message.state !== undefined) {
            const state = typeof message.state === "string" ? message.state.toUpperCase() : message.state;
            const commandName = { OPEN: "upOrOpen", CLOSE: "downOrClose", STOP: "stopMotion" }[String(state)];
            if (commandName === undefined) {
                warnings.push(`invalid cover state ${JSON.stringify(message.state)}: expected OPEN, CLOSE or STOP`);
            } else {
                actions.push({ clusterId: COVER, commandName, data: {} });
            }
        }
        const goTo = (key: "position" | "tilt", feature: number, commandName: string, field: string) => {
            if (message[key] === undefined) {
                return;
            }
            if ((features & feature) === 0) {
                warnings.push(`${key} not supported by this cover`);
                return;
            }
            const percent = percentOf(message[key], key, warnings);
            if (percent !== undefined) {
                actions.push({ clusterId: COVER, commandName, data: { [field]: Math.round((100 - percent) * 100) } });
            }
        };
        // FeatureMap: bit 2 PositionAwareLift, bit 4 PositionAwareTilt
        goTo("position", 4, "goToLiftPercentage", "liftPercent100thsValue");
        goTo("tilt", 16, "goToTiltPercentage", "tiltPercent100thsValue");
        return { actions, warnings };
    },
    primaryKey: "state",
    discovery: (attributes, endpoint, ctx) => {
        const keys = cover.keys(attributes, endpoint);
        const config: Record<string, unknown> = {
            name: ctx.entityName("Cover"),
            command_topic: ctx.commandTopic,
            value_template: `{{ value_json.${ctx.nameOf("state")} }}`,
            state_open: "OPEN",
            state_closed: "CLOSE",
            payload_open: '{"state":"OPEN"}',
            payload_close: '{"state":"CLOSE"}',
            payload_stop: '{"state":"STOP"}',
        };
        const deviceClass = coverDeviceClassOf(numberAt(attributes, endpoint, COVER, COVER_END_PRODUCT_TYPE));
        if (deviceClass !== undefined) {
            config.device_class = deviceClass;
        }
        if (keys.includes("position")) {
            Object.assign(config, {
                position_template: `{{ value_json.${ctx.nameOf("position")} }}`,
                set_position_topic: ctx.commandTopic,
                set_position_template: '{"position": {{ position }}}',
            });
        }
        if (keys.includes("tilt")) {
            Object.assign(config, {
                tilt_status_template: `{{ value_json.${ctx.nameOf("tilt")} }}`,
                tilt_command_topic: ctx.commandTopic,
                tilt_command_template: '{"tilt": {{ tilt_position }}}',
            });
        }
        return [{ component: "cover", objectId: "cover", config }];
    },
    exposes: (attributes, endpoint, property) => {
        const keys = cover.keys(attributes, endpoint);
        const features: Expose[] = [
            {
                type: "enum",
                name: "state",
                label: "State",
                property: property("state"),
                access: READ_WRITE,
                values: ["OPEN", "CLOSE", "STOP"],
            },
        ];
        for (const [key, label] of [
            ["position", "Position"],
            ["tilt", "Tilt"],
        ] as const) {
            if (keys.includes(key)) {
                features.push({
                    type: "numeric",
                    name: key,
                    label,
                    property: property(key),
                    access: READ_WRITE,
                    value_min: 0,
                    value_max: 100,
                    unit: "%",
                });
            }
        }
        const exposes: Expose[] = [{ type: "cover", features }];
        if (keys.includes("moving")) {
            exposes.push({
                type: "enum",
                name: "moving",
                label: "Moving",
                property: property("moving"),
                access: READ_ONLY,
                values: ["UP", "DOWN", "STOP"],
            });
        }
        return exposes;
    },
};

// Lock. zigbee2mqtt publishes `state` LOCK/UNLOCK plus the detailed `lock_state`.

const LOCK = DoorLock.Cluster.id;
const LOCK_STATE = 0;
const LOCK_DOOR_STATE = 3;
const LOCK_REQUIRE_PIN_FOR_REMOTE = 51;
const LOCK_STATE_NAMES = ["not_fully_locked", "locked", "unlocked", "unlatched"] as const;
const DOOR_STATE_NAMES = ["open", "closed", "jammed", "forced_open", "error", "ajar"] as const;

/** An octet-string command field, in the `hex:` form the controller's converter takes. */
function octetString(text: string): string {
    const hex = [...new TextEncoder().encode(text)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return `hex:${hex}`;
}

const lock: Control = {
    present: (attributes, endpoint) => raw(attributes, endpoint, LOCK, LOCK_STATE) !== undefined,
    keys: (attributes, endpoint) =>
        raw(attributes, endpoint, LOCK, LOCK_DOOR_STATE) !== undefined
            ? ["state", "lock_state", "door_state"]
            : ["state", "lock_state"],
    paths: [`${LOCK}/${LOCK_STATE}`, `${LOCK}/${LOCK_DOOR_STATE}`],
    state: (attributes, endpoint) => {
        const state: Record<string, unknown> = {};
        const lockState = numberAt(attributes, endpoint, LOCK, LOCK_STATE);
        if (lockState !== undefined && LOCK_STATE_NAMES[lockState] !== undefined) {
            state.state = lockState === 1 ? "LOCK" : "UNLOCK";
            state.lock_state = LOCK_STATE_NAMES[lockState];
        }
        const doorState = numberAt(attributes, endpoint, LOCK, LOCK_DOOR_STATE);
        if (doorState !== undefined && DOOR_STATE_NAMES[doorState] !== undefined) {
            state.door_state = DOOR_STATE_NAMES[doorState];
        }
        return state;
    },
    setKeys: ["state", "pin_code"],
    parse: (message, attributes, endpoint) => {
        const warnings: string[] = [];
        if (message.state === undefined) {
            return { actions: [], warnings: ["pin_code given without a state to apply it to"] };
        }
        const state = typeof message.state === "string" ? message.state.toUpperCase() : message.state;
        const commandName = { LOCK: "lockDoor", UNLOCK: "unlockDoor" }[String(state)];
        if (commandName === undefined) {
            return {
                actions: [],
                warnings: [`invalid lock state ${JSON.stringify(message.state)}: expected LOCK or UNLOCK`],
            };
        }
        const pin = message.pin_code;
        if (pin !== undefined && typeof pin !== "string" && typeof pin !== "number") {
            warnings.push("invalid pin_code: expected a string of digits");
        }
        const data = typeof pin === "string" || typeof pin === "number" ? { pinCode: octetString(String(pin)) } : {};
        if (Object.keys(data).length === 0 && raw(attributes, endpoint, LOCK, LOCK_REQUIRE_PIN_FOR_REMOTE) === true) {
            warnings.push("this lock requires a pin_code for remote operation");
        }
        return { actions: [{ clusterId: LOCK, commandName, data }], warnings };
    },
    primaryKey: "state",
    discovery: (attributes, endpoint, ctx) => {
        const entities: ControlEntity[] = [
            {
                component: "lock",
                objectId: "lock",
                config: {
                    name: ctx.entityName("Lock"),
                    command_topic: ctx.commandTopic,
                    value_template: `{{ value_json.${ctx.nameOf("state")} }}`,
                    payload_lock: '{"state":"LOCK"}',
                    payload_unlock: '{"state":"UNLOCK"}',
                    state_locked: "LOCK",
                    state_unlocked: "UNLOCK",
                },
            },
        ];
        if (lock.keys(attributes, endpoint).includes("door_state")) {
            entities.push({
                component: "sensor",
                objectId: "door_state",
                config: {
                    name: ctx.entityName("Door state"),
                    value_template: `{{ value_json.${ctx.nameOf("door_state")} }}`,
                    device_class: "enum",
                    options: DOOR_STATE_NAMES,
                },
            });
        }
        return entities;
    },
    exposes: (attributes, endpoint, property) => {
        const exposes: Expose[] = [
            {
                type: "lock",
                features: [
                    {
                        type: "binary",
                        name: "state",
                        label: "State",
                        property: property("state"),
                        access: READ_WRITE,
                        value_on: "LOCK",
                        value_off: "UNLOCK",
                    },
                    {
                        type: "enum",
                        name: "lock_state",
                        label: "Lock state",
                        property: property("lock_state"),
                        access: READ_ONLY,
                        values: LOCK_STATE_NAMES,
                    },
                ],
            },
        ];
        if (lock.keys(attributes, endpoint).includes("door_state")) {
            exposes.push({
                type: "enum",
                name: "door_state",
                label: "Door state",
                property: property("door_state"),
                access: READ_ONLY,
                values: DOOR_STATE_NAMES,
            });
        }
        return exposes;
    },
};

// Thermostat. Temperatures are in 0.01 °C, the calibration in 0.1 °C; setpoints and the system mode are
// attribute writes.

const THERMOSTAT = Thermostat.Cluster.id;
const TH_LOCAL_TEMPERATURE = 0;
const TH_OUTDOOR_TEMPERATURE = 1;
const TH_ABS_MIN_HEAT = 3;
const TH_ABS_MAX_HEAT = 4;
const TH_ABS_MIN_COOL = 5;
const TH_ABS_MAX_COOL = 6;
const TH_PI_COOLING_DEMAND = 7;
const TH_PI_HEATING_DEMAND = 8;
const TH_CALIBRATION = 16;
const TH_SYSTEM_MODE = 28;
const TH_RUNNING_STATE = 41;

/** SystemModeEnum by value, with zigbee2mqtt's names; 2 is reserved. */
const SYSTEM_MODES: Readonly<Record<number, string>> = {
    0: "off",
    1: "auto",
    3: "cool",
    4: "heat",
    5: "emergency_heating",
    6: "precooling",
    7: "fan_only",
    8: "dry",
    9: "sleep",
};
const RUNNING_STATES = ["idle", "heat", "cool", "fan_only"] as const;

/** Writable setpoints: zigbee2mqtt name, attribute, and the FeatureMap bit the attribute depends on. */
const SETPOINTS = [
    { key: "occupied_heating_setpoint", attribute: 18, feature: 1, min: TH_ABS_MIN_HEAT, max: TH_ABS_MAX_HEAT },
    { key: "occupied_cooling_setpoint", attribute: 17, feature: 2, min: TH_ABS_MIN_COOL, max: TH_ABS_MAX_COOL },
    { key: "unoccupied_heating_setpoint", attribute: 20, feature: 1, min: TH_ABS_MIN_HEAT, max: TH_ABS_MAX_HEAT },
    { key: "unoccupied_cooling_setpoint", attribute: 19, feature: 2, min: TH_ABS_MIN_COOL, max: TH_ABS_MAX_COOL },
] as const;

/** Read-only temperatures and demands. */
const THERMOSTAT_READINGS = [
    { key: "local_temperature", attribute: TH_LOCAL_TEMPERATURE, scale: 100, unit: "°C" },
    { key: "outdoor_temperature", attribute: TH_OUTDOOR_TEMPERATURE, scale: 100, unit: "°C" },
    { key: "pi_heating_demand", attribute: TH_PI_HEATING_DEMAND, scale: 1, unit: "%" },
    { key: "pi_cooling_demand", attribute: TH_PI_COOLING_DEMAND, scale: 1, unit: "%" },
] as const;

const SETPOINT_STEP = 0.5;

function thermostatFeatures(attributes: AttributesData, endpoint: number): number {
    return numberAt(attributes, endpoint, THERMOSTAT, FEATURE_MAP) ?? 0;
}

function supportedSetpoints(attributes: AttributesData, endpoint: number) {
    const features = thermostatFeatures(attributes, endpoint);
    return SETPOINTS.filter(
        setpoint =>
            (features & setpoint.feature) !== 0 &&
            raw(attributes, endpoint, THERMOSTAT, setpoint.attribute) !== undefined,
    );
}

const ROOM_AIR_CONDITIONER = 0x0072;

function hasDeviceType(attributes: AttributesData, endpoint: number, deviceType: number): boolean {
    const list = raw(attributes, endpoint, 29, 0);
    return (
        Array.isArray(list) &&
        list.some(entry => {
            const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
            return Number(record["0"] ?? record.deviceType) === deviceType;
        })
    );
}

/**
 * System modes the thermostat can be put in: off, plus heat/cool/auto per FeatureMap (HEAT, COOL, AUTO),
 * and fan only and dry for a room air conditioner, which the FeatureMap cannot tell.
 */
function systemModesOf(attributes: AttributesData, endpoint: number): string[] {
    const features = thermostatFeatures(attributes, endpoint);
    const modes = ["off"];
    if (features & 32) {
        modes.push("auto");
    }
    if (features & 2) {
        modes.push("cool");
    }
    if (features & 1) {
        modes.push("heat");
    }
    if (hasDeviceType(attributes, endpoint, ROOM_AIR_CONDITIONER)) {
        modes.push("fan_only", "dry");
    }
    return modes;
}

/** Setpoint limits in °C: AbsMin/AbsMax for the setpoint's direction, else Matter's defaults. */
function setpointRangeOf(attributes: AttributesData, endpoint: number, minAttribute: number, maxAttribute: number) {
    const min = numberAt(attributes, endpoint, THERMOSTAT, minAttribute);
    const max = numberAt(attributes, endpoint, THERMOSTAT, maxAttribute);
    return { min: min === undefined ? 7 : min / 100, max: max === undefined ? 30 : max / 100 };
}

/** ThermostatRunningState bits: 0 heat, 1 cool, 2 fan, 3 heat stage 2, 4 cool stage 2, 5-6 fan stages 2-3. */
function runningStateOf(value: unknown): string | undefined {
    let bits: number | undefined;
    if (typeof value === "number") {
        bits = value;
    } else if (typeof value === "object" && value !== null) {
        const record = value as Record<string, unknown>;
        bits =
            (record.heat || record.heatStage2 ? 1 : 0) |
            (record.cool || record.coolStage2 ? 2 : 0) |
            (record.fan || record.fanStage2 || record.fanStage3 ? 4 : 0);
    }
    if (bits === undefined) {
        return undefined;
    }
    if (bits & 0b1001) {
        return "heat";
    }
    if (bits & 0b10010) {
        return "cool";
    }
    if (bits & 0b1100100) {
        return "fan_only";
    }
    return "idle";
}

function temperatureOf(value: unknown, key: string, warnings: string[]): number | undefined {
    const number = typeof value === "string" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number)) {
        warnings.push(`invalid ${key} ${JSON.stringify(value)}: expected a temperature in °C`);
        return undefined;
    }
    return number;
}

const thermostat: Control = {
    present: (attributes, endpoint) => raw(attributes, endpoint, THERMOSTAT, FEATURE_MAP) !== undefined,
    keys: (attributes, endpoint) => {
        const keys: string[] = THERMOSTAT_READINGS.filter(
            reading => raw(attributes, endpoint, THERMOSTAT, reading.attribute) !== undefined,
        ).map(reading => reading.key);
        keys.push(...supportedSetpoints(attributes, endpoint).map(setpoint => setpoint.key));
        for (const [key, attribute] of [
            ["system_mode", TH_SYSTEM_MODE],
            ["running_state", TH_RUNNING_STATE],
            ["local_temperature_calibration", TH_CALIBRATION],
        ] as const) {
            if (raw(attributes, endpoint, THERMOSTAT, attribute) !== undefined) {
                keys.push(key);
            }
        }
        return keys;
    },
    paths: [
        ...THERMOSTAT_READINGS.map(reading => `${THERMOSTAT}/${reading.attribute}`),
        ...SETPOINTS.map(setpoint => `${THERMOSTAT}/${setpoint.attribute}`),
        `${THERMOSTAT}/${TH_SYSTEM_MODE}`,
        `${THERMOSTAT}/${TH_RUNNING_STATE}`,
        `${THERMOSTAT}/${TH_CALIBRATION}`,
    ],
    state: (attributes, endpoint) => {
        const state: Record<string, unknown> = {};
        for (const { key, attribute, scale } of THERMOSTAT_READINGS) {
            const value = numberAt(attributes, endpoint, THERMOSTAT, attribute);
            if (value !== undefined) {
                state[key] = Math.round((value / scale) * 100) / 100;
            }
        }
        for (const { key, attribute } of supportedSetpoints(attributes, endpoint)) {
            const value = numberAt(attributes, endpoint, THERMOSTAT, attribute);
            if (value !== undefined) {
                state[key] = value / 100;
            }
        }
        const mode = numberAt(attributes, endpoint, THERMOSTAT, TH_SYSTEM_MODE);
        if (mode !== undefined && SYSTEM_MODES[mode] !== undefined) {
            state.system_mode = SYSTEM_MODES[mode];
        }
        const running = runningStateOf(raw(attributes, endpoint, THERMOSTAT, TH_RUNNING_STATE));
        if (running !== undefined) {
            state.running_state = running;
        }
        const calibration = numberAt(attributes, endpoint, THERMOSTAT, TH_CALIBRATION);
        if (calibration !== undefined) {
            state.local_temperature_calibration = calibration / 10;
        }
        return state;
    },
    setKeys: [...SETPOINTS.map(setpoint => setpoint.key), "system_mode", "local_temperature_calibration"],
    parse: (message, attributes, endpoint) => {
        const actions: DeviceAction[] = [];
        const warnings: string[] = [];
        const supported = supportedSetpoints(attributes, endpoint);
        for (const setpoint of SETPOINTS) {
            if (message[setpoint.key] === undefined) {
                continue;
            }
            if (!supported.includes(setpoint)) {
                warnings.push(`${setpoint.key} not supported by this thermostat`);
                continue;
            }
            const celsius = temperatureOf(message[setpoint.key], setpoint.key, warnings);
            if (celsius !== undefined) {
                actions.push({
                    clusterId: THERMOSTAT,
                    attributeId: setpoint.attribute,
                    value: Math.round(celsius * 100),
                });
            }
        }
        if (message.system_mode !== undefined) {
            const name = String(message.system_mode).toLowerCase();
            const entry = Object.entries(SYSTEM_MODES).find(([, mode]) => mode === name);
            if (entry === undefined) {
                warnings.push(
                    `invalid system_mode ${JSON.stringify(message.system_mode)}: expected one of ${Object.values(SYSTEM_MODES).join(", ")}`,
                );
            } else {
                actions.push({ clusterId: THERMOSTAT, attributeId: TH_SYSTEM_MODE, value: Number(entry[0]) });
            }
        }
        if (message.local_temperature_calibration !== undefined) {
            const celsius = temperatureOf(
                message.local_temperature_calibration,
                "local_temperature_calibration",
                warnings,
            );
            if (celsius !== undefined) {
                // LocalTemperatureCalibration is int8 in 0.1 °C, specified for -2.5..2.5 °C
                const tenths = Math.round(celsius * 10);
                if (tenths < -25 || tenths > 25) {
                    warnings.push(`local_temperature_calibration ${celsius} out of range -2.5..2.5`);
                } else {
                    actions.push({ clusterId: THERMOSTAT, attributeId: TH_CALIBRATION, value: tenths });
                }
            }
        }
        return { actions, warnings };
    },
    primaryKey: "system_mode",
    discovery: (attributes, endpoint, ctx) => {
        const keys = thermostat.keys(attributes, endpoint);
        const modes = systemModesOf(attributes, endpoint);
        const heat = keys.includes("occupied_heating_setpoint");
        const cool = keys.includes("occupied_cooling_setpoint");
        const heatRange = setpointRangeOf(attributes, endpoint, TH_ABS_MIN_HEAT, TH_ABS_MAX_HEAT);
        const coolRange = setpointRangeOf(attributes, endpoint, TH_ABS_MIN_COOL, TH_ABS_MAX_COOL);
        const range =
            heat && cool
                ? { min: Math.min(heatRange.min, coolRange.min), max: Math.max(heatRange.max, coolRange.max) }
                : cool
                  ? coolRange
                  : heatRange;
        const value = (key: string) => `value_json.${ctx.nameOf(key)}`;
        const config: Record<string, unknown> = {
            name: ctx.entityName("Thermostat"),
            temperature_unit: "C",
            precision: 0.1,
            temp_step: SETPOINT_STEP,
            min_temp: range.min,
            max_temp: range.max,
            modes,
        };
        if (keys.includes("system_mode")) {
            // Matter modes without a Home Assistant counterpart are shown as the closest one
            Object.assign(config, {
                mode_command_topic: ctx.commandTopic,
                mode_command_template: '{"system_mode": "{{ value }}"}',
                mode_state_template:
                    `{{ {'emergency_heating': 'heat', 'precooling': 'cool', 'sleep': 'auto'}` +
                    `.get(${value("system_mode")}, ${value("system_mode")}) }}`,
            });
        }
        if (keys.includes("local_temperature")) {
            config.current_temperature_template = `{{ ${value("local_temperature")} }}`;
        }
        const target = (prefix: string, key: string) => ({
            [`${prefix}_command_topic`]: ctx.commandTopic,
            [`${prefix}_command_template`]: `{"${key}": {{ value }}}`,
            [`${prefix}_state_template`]: `{{ ${value(key)} }}`,
        });
        if (heat && cool) {
            Object.assign(
                config,
                target("temperature_low", "occupied_heating_setpoint"),
                target("temperature_high", "occupied_cooling_setpoint"),
            );
        } else if (heat || cool) {
            Object.assign(
                config,
                target("temperature", heat ? "occupied_heating_setpoint" : "occupied_cooling_setpoint"),
            );
        }
        if (keys.includes("running_state")) {
            config.action_template =
                `{% if ${value("system_mode")} == 'off' %}off{% else %}` +
                `{{ {'heat': 'heating', 'cool': 'cooling', 'fan_only': 'fan', 'idle': 'idle'}` +
                `.get(${value("running_state")}, 'idle') }}{% endif %}`;
        }
        const entities: ControlEntity[] = [{ component: "climate", objectId: "climate", config }];
        for (const { key, unit } of THERMOSTAT_READINGS.slice(1)) {
            if (keys.includes(key)) {
                const label = key.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
                entities.push({
                    component: "sensor",
                    objectId: key,
                    config: {
                        name: ctx.entityName(label),
                        value_template: `{{ ${value(key)} }}`,
                        unit_of_measurement: unit,
                        state_class: "measurement",
                        ...(unit === "°C" ? { device_class: "temperature" } : {}),
                    },
                });
            }
        }
        return entities;
    },
    exposes: (attributes, endpoint, property) => {
        const keys = thermostat.keys(attributes, endpoint);
        const features: Expose[] = [];
        const numeric = (key: string, label: string, access: number, extra: Expose = {}) =>
            features.push({ type: "numeric", name: key, label, property: property(key), access, ...extra });
        if (keys.includes("local_temperature")) {
            numeric("local_temperature", "Local temperature", READ_ONLY, { unit: "°C" });
        }
        for (const setpoint of supportedSetpoints(attributes, endpoint)) {
            const range = setpointRangeOf(attributes, endpoint, setpoint.min, setpoint.max);
            const label = setpoint.key.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
            numeric(setpoint.key, label, READ_WRITE, {
                unit: "°C",
                value_min: range.min,
                value_max: range.max,
                value_step: SETPOINT_STEP,
            });
        }
        if (keys.includes("system_mode")) {
            features.push({
                type: "enum",
                name: "system_mode",
                label: "System mode",
                property: property("system_mode"),
                access: READ_WRITE,
                values: systemModesOf(attributes, endpoint),
            });
        }
        if (keys.includes("running_state")) {
            features.push({
                type: "enum",
                name: "running_state",
                label: "Running state",
                property: property("running_state"),
                access: READ_ONLY,
                values: RUNNING_STATES,
            });
        }
        if (keys.includes("local_temperature_calibration")) {
            numeric("local_temperature_calibration", "Local temperature calibration", READ_WRITE, {
                unit: "°C",
                value_min: -2.5,
                value_max: 2.5,
                value_step: 0.1,
            });
        }
        const exposes: Expose[] = [{ type: "climate", features }];
        for (const { key, unit } of THERMOSTAT_READINGS.slice(1)) {
            if (keys.includes(key)) {
                const label = key.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
                exposes.push({ type: "numeric", name: key, label, property: property(key), access: READ_ONLY, unit });
            }
        }
        return exposes;
    },
};

// Fan. Matter's FanModeEnum matches the Zigbee fan cluster that zigbee2mqtt's fan_mode follows.

const FAN = FanControl.Cluster.id;
const FAN_MODE = 0;
const FAN_MODE_SEQUENCE = 1;
const FAN_PERCENT_SETTING = 2;
const FAN_PERCENT_CURRENT = 3;
const FAN_SPEED_MAX = 4;
const FAN_SPEED_SETTING = 5;
const FAN_SPEED_CURRENT = 6;
const FAN_ROCK_SUPPORT = 7;
const FAN_ROCK_SETTING = 8;
const FAN_AIRFLOW_DIRECTION = 11;
const FAN_MODES = ["off", "low", "medium", "high", "on", "auto", "smart"] as const;
const AIRFLOW_DIRECTIONS = ["forward", "reverse"] as const;

/** Writable fan modes per FanModeSequence; `on` and `smart` are always accepted by the cluster. */
const FAN_MODE_SEQUENCES: Readonly<Record<number, readonly string[]>> = {
    0: ["off", "low", "medium", "high"],
    1: ["off", "low", "high"],
    2: ["off", "low", "medium", "high", "auto"],
    3: ["off", "low", "high", "auto"],
    4: ["off", "high", "auto"],
    5: ["off", "high"],
};

function fanModesOf(attributes: AttributesData, endpoint: number): readonly string[] {
    const sequence = numberAt(attributes, endpoint, FAN, FAN_MODE_SEQUENCE);
    return FAN_MODE_SEQUENCES[sequence ?? 0] ?? FAN_MODE_SEQUENCES[0];
}

function bitmapOf(value: unknown): number | undefined {
    if (typeof value === "number") {
        return value;
    }
    if (typeof value === "object" && value !== null) {
        return Object.values(value).reduce<number>((bits, flag, index) => (flag ? bits | (1 << index) : bits), 0);
    }
    return undefined;
}

function boundedNumber(value: unknown, key: string, min: number, max: number, warnings: string[]): number | undefined {
    const number = typeof value === "string" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number) || number < min || number > max) {
        warnings.push(`invalid ${key} ${JSON.stringify(value)}: expected ${min}-${max}`);
        return undefined;
    }
    return Math.round(number);
}

function present(attributes: AttributesData, endpoint: number, cluster: number, attribute: number): boolean {
    return raw(attributes, endpoint, cluster, attribute) !== undefined;
}

const fan: Control = {
    present: (attributes, endpoint) => present(attributes, endpoint, FAN, FAN_MODE),
    keys: (attributes, endpoint) => {
        const keys = ["fan_state", "fan_mode"];
        if (present(attributes, endpoint, FAN, FAN_PERCENT_SETTING)) {
            keys.push("percentage");
        }
        if (present(attributes, endpoint, FAN, FAN_SPEED_SETTING)) {
            keys.push("fan_speed");
        }
        if (present(attributes, endpoint, FAN, FAN_ROCK_SETTING)) {
            keys.push("oscillation");
        }
        if (present(attributes, endpoint, FAN, FAN_AIRFLOW_DIRECTION)) {
            keys.push("airflow_direction");
        }
        return keys;
    },
    paths: [
        FAN_MODE,
        FAN_PERCENT_SETTING,
        FAN_PERCENT_CURRENT,
        FAN_SPEED_SETTING,
        FAN_SPEED_CURRENT,
        FAN_ROCK_SETTING,
        FAN_AIRFLOW_DIRECTION,
    ].map(attribute => `${FAN}/${attribute}`),
    state: (attributes, endpoint) => {
        const state: Record<string, unknown> = {};
        const mode = numberAt(attributes, endpoint, FAN, FAN_MODE);
        if (mode !== undefined && FAN_MODES[mode] !== undefined) {
            state.fan_mode = FAN_MODES[mode];
            state.fan_state = mode === 0 ? "OFF" : "ON";
        }
        const percentage =
            numberAt(attributes, endpoint, FAN, FAN_PERCENT_CURRENT) ??
            numberAt(attributes, endpoint, FAN, FAN_PERCENT_SETTING);
        if (percentage !== undefined) {
            state.percentage = percentage;
        }
        const speed =
            numberAt(attributes, endpoint, FAN, FAN_SPEED_CURRENT) ??
            numberAt(attributes, endpoint, FAN, FAN_SPEED_SETTING);
        if (speed !== undefined) {
            state.fan_speed = speed;
        }
        const rock = bitmapOf(raw(attributes, endpoint, FAN, FAN_ROCK_SETTING));
        if (rock !== undefined) {
            state.oscillation = rock !== 0;
        }
        const direction = numberAt(attributes, endpoint, FAN, FAN_AIRFLOW_DIRECTION);
        if (direction !== undefined && AIRFLOW_DIRECTIONS[direction] !== undefined) {
            state.airflow_direction = AIRFLOW_DIRECTIONS[direction];
        }
        return state;
    },
    setKeys: ["fan_state", "fan_mode", "percentage", "fan_speed", "oscillation", "airflow_direction"],
    parse: (message, attributes, endpoint) => {
        const actions: DeviceAction[] = [];
        const warnings: string[] = [];
        const write = (attributeId: number, value: unknown) => actions.push({ clusterId: FAN, attributeId, value });
        const keys = fan.keys(attributes, endpoint);
        if (message.fan_state !== undefined) {
            const state = String(message.fan_state).toUpperCase();
            if (state === "ON" || state === "OFF") {
                // FanMode On lets the fan pick its speed, which is what a bare "turn on" means
                write(FAN_MODE, state === "ON" ? 4 : 0);
            } else {
                warnings.push(`invalid fan_state ${JSON.stringify(message.fan_state)}: expected ON or OFF`);
            }
        }
        if (message.fan_mode !== undefined) {
            const name = String(message.fan_mode).toLowerCase();
            const index = FAN_MODES.indexOf(name as (typeof FAN_MODES)[number]);
            if (index < 0) {
                warnings.push(
                    `invalid fan_mode ${JSON.stringify(message.fan_mode)}: expected one of ${FAN_MODES.join(", ")}`,
                );
            } else {
                write(FAN_MODE, index);
            }
        }
        const numeric = (key: string, attributeId: number, max: number) => {
            if (message[key] === undefined) {
                return;
            }
            if (!keys.includes(key)) {
                warnings.push(`${key} not supported by this fan`);
                return;
            }
            const value = boundedNumber(message[key], key, 0, max, warnings);
            if (value !== undefined) {
                write(attributeId, value);
            }
        };
        numeric("percentage", FAN_PERCENT_SETTING, 100);
        numeric("fan_speed", FAN_SPEED_SETTING, numberAt(attributes, endpoint, FAN, FAN_SPEED_MAX) ?? 100);
        if (message.oscillation !== undefined) {
            if (!keys.includes("oscillation")) {
                warnings.push("oscillation not supported by this fan");
            } else {
                const on = message.oscillation === true || String(message.oscillation).toLowerCase() === "true";
                // Oscillating turns on every rocking motion the fan supports
                write(FAN_ROCK_SETTING, on ? (bitmapOf(raw(attributes, endpoint, FAN, FAN_ROCK_SUPPORT)) ?? 1) : 0);
            }
        }
        if (message.airflow_direction !== undefined) {
            const index = AIRFLOW_DIRECTIONS.indexOf(String(message.airflow_direction).toLowerCase() as "forward");
            if (!keys.includes("airflow_direction")) {
                warnings.push("airflow_direction not supported by this fan");
            } else if (index < 0) {
                warnings.push(
                    `invalid airflow_direction ${JSON.stringify(message.airflow_direction)}: expected forward or reverse`,
                );
            } else {
                write(FAN_AIRFLOW_DIRECTION, index);
            }
        }
        return { actions, warnings };
    },
    primaryKey: "fan_state",
    discovery: (attributes, endpoint, ctx) => {
        const keys = fan.keys(attributes, endpoint);
        const value = (key: string) => `value_json.${ctx.nameOf(key)}`;
        const presets = fanModesOf(attributes, endpoint).filter(mode => mode === "auto");
        const config: Record<string, unknown> = {
            name: ctx.entityName("Fan"),
            command_topic: ctx.commandTopic,
            state_value_template: `{{ ${value("fan_state")} }}`,
            payload_on: '{"fan_state":"ON"}',
            payload_off: '{"fan_state":"OFF"}',
        };
        if (keys.includes("percentage")) {
            Object.assign(config, {
                percentage_command_topic: ctx.commandTopic,
                percentage_command_template: '{"percentage": {{ value }}}',
                percentage_value_template: `{{ ${value("percentage")} }}`,
            });
        }
        if (presets.length > 0) {
            Object.assign(config, {
                preset_modes: presets,
                preset_mode_command_topic: ctx.commandTopic,
                preset_mode_command_template: '{"fan_mode": "{{ value }}"}',
                preset_mode_value_template: `{{ ${value("fan_mode")} if ${value("fan_mode")} in ${JSON.stringify(presets)} else 'None' }}`,
            });
        }
        if (keys.includes("oscillation")) {
            Object.assign(config, {
                oscillation_command_topic: ctx.commandTopic,
                oscillation_command_template: '{"oscillation": {{ value }}}',
                payload_oscillation_on: "true",
                payload_oscillation_off: "false",
                oscillation_value_template: `{{ ${value("oscillation")} | lower }}`,
            });
        }
        if (keys.includes("airflow_direction")) {
            Object.assign(config, {
                direction_command_topic: ctx.commandTopic,
                direction_command_template: '{"airflow_direction": "{{ value }}"}',
                direction_value_template: `{{ ${value("airflow_direction")} }}`,
            });
        }
        return [{ component: "fan", objectId: "fan", config }];
    },
    exposes: (attributes, endpoint, property) => {
        const keys = fan.keys(attributes, endpoint);
        const features: Expose[] = [
            {
                type: "binary",
                name: "fan_state",
                label: "Fan state",
                property: property("fan_state"),
                access: READ_WRITE,
                value_on: "ON",
                value_off: "OFF",
            },
            {
                type: "enum",
                name: "fan_mode",
                label: "Fan mode",
                property: property("fan_mode"),
                access: READ_WRITE,
                values: fanModesOf(attributes, endpoint),
            },
        ];
        if (keys.includes("percentage")) {
            features.push({
                type: "numeric",
                name: "percentage",
                label: "Percentage",
                property: property("percentage"),
                access: READ_WRITE,
                value_min: 0,
                value_max: 100,
                unit: "%",
            });
        }
        if (keys.includes("fan_speed")) {
            const max = numberAt(attributes, endpoint, FAN, FAN_SPEED_MAX) ?? 100;
            features.push({
                type: "numeric",
                name: "fan_speed",
                label: "Fan speed",
                property: property("fan_speed"),
                access: READ_WRITE,
                value_min: 0,
                value_max: max,
            });
        }
        if (keys.includes("oscillation")) {
            features.push({
                type: "binary",
                name: "oscillation",
                label: "Oscillation",
                property: property("oscillation"),
                access: READ_WRITE,
                value_on: true,
                value_off: false,
            });
        }
        if (keys.includes("airflow_direction")) {
            features.push({
                type: "enum",
                name: "airflow_direction",
                label: "Airflow direction",
                property: property("airflow_direction"),
                access: READ_WRITE,
                values: AIRFLOW_DIRECTIONS,
            });
        }
        return [{ type: "fan", features }];
    },
};

// Valve. Published like a cover: state OPEN/CLOSE and, with the Level feature, position 0-100.

const VALVE = ValveConfigurationAndControl.Cluster.id;
const VALVE_REMAINING_DURATION = 3;
const VALVE_CURRENT_STATE = 4;
const VALVE_CURRENT_LEVEL = 6;

const valve: Control = {
    present: (attributes, endpoint) => present(attributes, endpoint, VALVE, VALVE_CURRENT_STATE),
    keys: (attributes, endpoint) => {
        const keys = ["state"];
        if (present(attributes, endpoint, VALVE, VALVE_CURRENT_LEVEL)) {
            keys.push("position");
        }
        if (present(attributes, endpoint, VALVE, VALVE_REMAINING_DURATION)) {
            keys.push("remaining_duration");
        }
        return keys;
    },
    paths: [VALVE_REMAINING_DURATION, VALVE_CURRENT_STATE, VALVE_CURRENT_LEVEL].map(
        attribute => `${VALVE}/${attribute}`,
    ),
    state: (attributes, endpoint) => {
        const state: Record<string, unknown> = {};
        const current = numberAt(attributes, endpoint, VALVE, VALVE_CURRENT_STATE);
        if (current === 0 || current === 1) {
            state.state = current === 1 ? "OPEN" : "CLOSE";
        }
        const level = numberAt(attributes, endpoint, VALVE, VALVE_CURRENT_LEVEL);
        if (level !== undefined) {
            state.position = level;
        }
        const remaining = numberAt(attributes, endpoint, VALVE, VALVE_REMAINING_DURATION);
        if (remaining !== undefined) {
            state.remaining_duration = remaining;
        }
        return state;
    },
    setKeys: ["state", "position", "duration"],
    parse: (message, attributes, endpoint) => {
        const warnings: string[] = [];
        const data: Record<string, unknown> = {};
        if (message.duration !== undefined) {
            const seconds = boundedNumber(message.duration, "duration", 1, 0xffffffff, warnings);
            if (seconds !== undefined) {
                data.openDuration = seconds;
            }
        }
        if (message.position !== undefined) {
            if (!present(attributes, endpoint, VALVE, VALVE_CURRENT_LEVEL)) {
                warnings.push("position not supported by this valve");
            } else {
                const level = boundedNumber(message.position, "position", 0, 100, warnings);
                if (level === 0) {
                    return { actions: [{ clusterId: VALVE, commandName: "close", data: {} }], warnings };
                }
                if (level !== undefined) {
                    data.targetLevel = level;
                }
            }
        }
        const state = message.state === undefined ? undefined : String(message.state).toUpperCase();
        if (state === "CLOSE") {
            return { actions: [{ clusterId: VALVE, commandName: "close", data: {} }], warnings };
        }
        if (state !== undefined && state !== "OPEN") {
            warnings.push(`invalid valve state ${JSON.stringify(message.state)}: expected OPEN or CLOSE`);
            return { actions: [], warnings };
        }
        if (state === undefined && Object.keys(data).length === 0) {
            return { actions: [], warnings };
        }
        return { actions: [{ clusterId: VALVE, commandName: "open", data }], warnings };
    },
    primaryKey: "state",
    discovery: (attributes, endpoint, ctx) => {
        const keys = valve.keys(attributes, endpoint);
        const config: Record<string, unknown> = {
            name: ctx.entityName("Valve"),
            command_topic: ctx.commandTopic,
            value_template: `{{ value_json.${ctx.nameOf("state")} }}`,
            payload_open: '{"state":"OPEN"}',
            payload_close: '{"state":"CLOSE"}',
            state_open: "OPEN",
            state_closed: "CLOSE",
            device_class: "water",
        };
        if (keys.includes("position")) {
            Object.assign(config, {
                reports_position: true,
                position_template: `{{ value_json.${ctx.nameOf("position")} }}`,
                set_position_template: '{"position": {{ position }}}',
            });
        }
        const entities: ControlEntity[] = [{ component: "valve", objectId: "valve", config }];
        if (keys.includes("remaining_duration")) {
            entities.push({
                component: "sensor",
                objectId: "remaining_duration",
                config: {
                    name: ctx.entityName("Remaining duration"),
                    value_template: `{{ value_json.${ctx.nameOf("remaining_duration")} }}`,
                    device_class: "duration",
                    unit_of_measurement: "s",
                },
            });
        }
        return entities;
    },
    exposes: (attributes, endpoint, property) => {
        const keys = valve.keys(attributes, endpoint);
        const features: Expose[] = [
            {
                type: "enum",
                name: "state",
                label: "State",
                property: property("state"),
                access: READ_WRITE,
                values: ["OPEN", "CLOSE"],
            },
        ];
        if (keys.includes("position")) {
            features.push({
                type: "numeric",
                name: "position",
                label: "Position",
                property: property("position"),
                access: READ_WRITE,
                value_min: 0,
                value_max: 100,
                unit: "%",
            });
        }
        const exposes: Expose[] = [{ type: "valve", features }];
        if (keys.includes("remaining_duration")) {
            exposes.push({
                type: "numeric",
                name: "remaining_duration",
                label: "Remaining duration",
                property: property("remaining_duration"),
                access: READ_ONLY,
                unit: "s",
            });
        }
        return exposes;
    },
};

/**
 * A writable enum attribute as a zigbee2mqtt enum property and a Home Assistant select (pump modes,
 * smoke sensitivity, ...). `nullName` names the attribute's null value where it has a meaning.
 */
function enumSetting(
    key: string,
    label: string,
    cluster: number,
    attribute: number,
    names: Readonly<Record<number, string>>,
    nullName?: string,
): Control {
    const values = [...Object.values(names), ...(nullName === undefined ? [] : [nullName])];
    return {
        present: (attributes, endpoint) => present(attributes, endpoint, cluster, attribute),
        keys: () => [key],
        paths: [`${cluster}/${attribute}`],
        state: (attributes, endpoint) => {
            if (nullName !== undefined && raw(attributes, endpoint, cluster, attribute) === null) {
                return { [key]: nullName };
            }
            const value = numberAt(attributes, endpoint, cluster, attribute);
            return value !== undefined && names[value] !== undefined ? { [key]: names[value] } : {};
        },
        setKeys: [key],
        parse: message => {
            const name = String(message[key]).toLowerCase();
            if (nullName !== undefined && name === nullName) {
                return { actions: [{ clusterId: cluster, attributeId: attribute, value: null }], warnings: [] };
            }
            const entry = Object.entries(names).find(([, value]) => value === name);
            if (entry === undefined) {
                return {
                    actions: [],
                    warnings: [`invalid ${key} ${JSON.stringify(message[key])}: expected one of ${values.join(", ")}`],
                };
            }
            return { actions: [{ clusterId: cluster, attributeId: attribute, value: Number(entry[0]) }], warnings: [] };
        },
        primaryKey: key,
        discovery: (_attributes, _endpoint, ctx) => [
            {
                component: "select",
                objectId: key,
                config: {
                    name: ctx.entityName(label),
                    command_topic: ctx.commandTopic,
                    command_template: `{"${key}": "{{ value }}"}`,
                    value_template: `{{ value_json.${ctx.nameOf(key)} }}`,
                    options: values,
                    entity_category: "config",
                },
            },
        ],
        exposes: (_attributes, _endpoint, property) => [
            { type: "enum", name: key, label, property: property(key), access: READ_WRITE, values },
        ],
    };
}

const PUMP = PumpConfigurationAndControl.Cluster.id;
const pumpOperationMode = enumSetting("pump_operation_mode", "Pump operation mode", PUMP, 32, {
    0: "normal",
    1: "minimum",
    2: "maximum",
    3: "local",
});
const pumpControlMode = enumSetting("pump_control_mode", "Pump control mode", PUMP, 33, {
    0: "constant_speed",
    1: "constant_pressure",
    2: "proportional_pressure",
    3: "constant_flow",
    5: "constant_temperature",
    7: "automatic",
});

const SMOKE_CO = SmokeCoAlarm.Cluster.id;
const smokeSensitivity = enumSetting("smoke_sensitivity", "Smoke sensitivity", SMOKE_CO, 11, {
    0: "high",
    1: "standard",
    2: "low",
});

/** The SelfTestRequest command, as a write-only property and a Home Assistant button. */
const smokeSelfTest: Control = {
    present: (attributes, endpoint) => present(attributes, endpoint, SMOKE_CO, 0),
    keys: () => [],
    paths: [],
    state: () => ({}),
    setKeys: ["self_test"],
    parse: () => ({ actions: [{ clusterId: SMOKE_CO, commandName: "selfTestRequest", data: {} }], warnings: [] }),
    primaryKey: "self_test",
    discovery: (_attributes, _endpoint, ctx) => [
        {
            component: "button",
            objectId: "self_test",
            config: {
                name: ctx.entityName("Self test"),
                command_topic: ctx.commandTopic,
                payload_press: '{"self_test": true}',
                entity_category: "diagnostic",
            },
        },
    ],
    exposes: (_attributes, _endpoint, property) => [
        {
            type: "enum",
            name: "self_test",
            label: "Self test",
            property: property("self_test"),
            access: 2,
            values: ["start"],
        },
    ],
};

// ModeSelect: the device names its own modes, so options come from SupportedModes.

const MODE_SELECT = ModeSelect.Cluster.id;
const MODE_SUPPORTED = 2;
const MODE_CURRENT = 3;

function supportedModesOf(attributes: AttributesData, endpoint: number): { label: string; mode: number }[] {
    const list = raw(attributes, endpoint, MODE_SELECT, MODE_SUPPORTED);
    if (!Array.isArray(list)) {
        return [];
    }
    return list.flatMap(entry => {
        const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
        const label = record["0"] ?? record.label;
        const mode = record["1"] ?? record.mode;
        return typeof label === "string" && typeof mode === "number" ? [{ label, mode }] : [];
    });
}

const modeSelect: Control = {
    present: (attributes, endpoint) => present(attributes, endpoint, MODE_SELECT, MODE_CURRENT),
    keys: () => ["mode"],
    paths: [`${MODE_SELECT}/${MODE_CURRENT}`, `${MODE_SELECT}/${MODE_SUPPORTED}`],
    state: (attributes, endpoint) => {
        const current = numberAt(attributes, endpoint, MODE_SELECT, MODE_CURRENT);
        const option = supportedModesOf(attributes, endpoint).find(({ mode }) => mode === current);
        return option === undefined ? {} : { mode: option.label };
    },
    setKeys: ["mode"],
    parse: (message, attributes, endpoint) => {
        const modes = supportedModesOf(attributes, endpoint);
        const wanted = message.mode;
        const option = modes.find(({ label, mode }) => label === wanted || mode === wanted || String(mode) === wanted);
        if (option === undefined) {
            return {
                actions: [],
                warnings: [
                    `invalid mode ${JSON.stringify(wanted)}: expected one of ${modes.map(m => m.label).join(", ")}`,
                ],
            };
        }
        return {
            actions: [{ clusterId: MODE_SELECT, commandName: "changeToMode", data: { newMode: option.mode } }],
            warnings: [],
        };
    },
    primaryKey: "mode",
    discovery: (attributes, endpoint, ctx) => {
        const description = raw(attributes, endpoint, MODE_SELECT, 0);
        return [
            {
                component: "select",
                objectId: "mode",
                config: {
                    name: ctx.entityName(
                        typeof description === "string" && description.length > 0 ? description : "Mode",
                    ),
                    command_topic: ctx.commandTopic,
                    command_template: '{"mode": "{{ value }}"}',
                    value_template: `{{ value_json.${ctx.nameOf("mode")} }}`,
                    options: supportedModesOf(attributes, endpoint).map(({ label }) => label),
                },
            },
        ];
    },
    exposes: (attributes, endpoint, property) => [
        {
            type: "enum",
            name: "mode",
            label: "Mode",
            property: property("mode"),
            access: READ_WRITE,
            values: supportedModesOf(attributes, endpoint).map(({ label }) => label),
        },
    ],
};

// Light configuration (zigbee2mqtt's generic light options). Where Zigbee marks "previous" or "use the
// other attribute" with an all-ones value, Matter uses null; the published value follows zigbee2mqtt.

const powerOnBehavior = enumSetting(
    "power_on_behavior",
    "Power-on behavior",
    OnOff.Cluster.id,
    16387,
    { 0: "off", 1: "on", 2: "toggle" },
    "previous",
);

const IDENTIFY = Identify.Cluster.id;

/** zigbee2mqtt `effect` values and their Identify EffectIdentifier. */
export const IDENTIFY_EFFECTS: Readonly<Record<string, number>> = {
    blink: 0,
    breathe: 1,
    okay: 2,
    channel_change: 11,
    finish_effect: 254,
    stop_effect: 255,
};

/** Seconds a bare identify request lasts, as zigbee2mqtt's default. */
const IDENTIFY_SECONDS = 3;

export function hasIdentify(attributes: AttributesData, endpoint: number): boolean {
    return present(attributes, endpoint, IDENTIFY, 0);
}

const identify: Control = {
    present: hasIdentify,
    keys: () => [],
    paths: [],
    state: () => ({}),
    setKeys: ["effect", "identify"],
    parse: message => {
        const actions: DeviceAction[] = [];
        const warnings: string[] = [];
        if (message.effect !== undefined) {
            const effect = IDENTIFY_EFFECTS[String(message.effect).toLowerCase()];
            if (effect === undefined) {
                warnings.push(
                    `invalid effect ${JSON.stringify(message.effect)}: expected one of ${Object.keys(IDENTIFY_EFFECTS).join(", ")}`,
                );
            } else {
                actions.push({
                    clusterId: IDENTIFY,
                    commandName: "triggerEffect",
                    data: { effectIdentifier: effect, effectVariant: 0 },
                });
            }
        }
        if (message.identify !== undefined) {
            const seconds = typeof message.identify === "number" ? message.identify : IDENTIFY_SECONDS;
            actions.push({
                clusterId: IDENTIFY,
                commandName: "identify",
                data: { identifyTime: Math.max(0, Math.round(seconds)) },
            });
        }
        return { actions, warnings };
    },
    primaryKey: "identify",
    discovery: (_attributes, _endpoint, ctx) => [
        {
            component: "button",
            objectId: "identify",
            config: {
                name: ctx.entityName("Identify"),
                command_topic: ctx.commandTopic,
                payload_press: '{"identify": "identify"}',
                device_class: "identify",
                entity_category: "config",
            },
        },
    ],
    exposes: (_attributes, _endpoint, property) => [
        {
            type: "enum",
            name: "effect",
            label: "Effect",
            property: property("effect"),
            access: 2,
            values: Object.keys(IDENTIFY_EFFECTS),
        },
        {
            type: "enum",
            name: "identify",
            label: "Identify",
            property: property("identify"),
            access: 2,
            values: ["identify"],
        },
    ],
};

const COLOR = ColorControl.Cluster.id;
const COLOR_OPTIONS = 15;
const COLOR_TEMP_STARTUP = 16400;
/** zigbee2mqtt's value for "restore the previous color temperature" (Zigbee's 0xFFFF). */
const COLOR_TEMP_PREVIOUS = 65535;

function miredsRange(attributes: AttributesData, endpoint: number) {
    return {
        min: numberAt(attributes, endpoint, COLOR, 16395) ?? 153,
        max: numberAt(attributes, endpoint, COLOR, 16396) ?? 500,
    };
}

function colorTempPresets(attributes: AttributesData, endpoint: number) {
    const { min, max } = miredsRange(attributes, endpoint);
    return Object.entries(COLOR_TEMP_PRESETS)
        .map(([name, value]) => ({ name, value: value === "min" ? min : value === "max" ? max : value }))
        .filter(({ value }) => value >= min && value <= max);
}

const colorTempStartup: Control = {
    present: (attributes, endpoint) => present(attributes, endpoint, COLOR, COLOR_TEMP_STARTUP),
    keys: () => ["color_temp_startup"],
    paths: [`${COLOR}/${COLOR_TEMP_STARTUP}`],
    state: (attributes, endpoint) => {
        const value = raw(attributes, endpoint, COLOR, COLOR_TEMP_STARTUP);
        if (value === null) {
            return { color_temp_startup: COLOR_TEMP_PREVIOUS };
        }
        return typeof value === "number" ? { color_temp_startup: value } : {};
    },
    setKeys: ["color_temp_startup"],
    parse: (message, attributes, endpoint) => {
        const value = message.color_temp_startup;
        const write = (mireds: number | null): ParsedActions => ({
            actions: [{ clusterId: COLOR, attributeId: COLOR_TEMP_STARTUP, value: mireds }],
            warnings: [],
        });
        if (value === "previous" || value === COLOR_TEMP_PREVIOUS) {
            return write(null);
        }
        const preset = colorTempPresets(attributes, endpoint).find(({ name }) => name === value);
        if (preset !== undefined) {
            return write(preset.value);
        }
        const { min, max } = miredsRange(attributes, endpoint);
        const warnings: string[] = [];
        const mireds = boundedNumber(value, "color_temp_startup", min, max, warnings);
        return mireds === undefined ? { actions: [], warnings } : write(mireds);
    },
    primaryKey: "color_temp_startup",
    discovery: (attributes, endpoint, ctx) => {
        const { min, max } = miredsRange(attributes, endpoint);
        return [
            {
                component: "number",
                objectId: "color_temp_startup",
                config: {
                    name: ctx.entityName("Color temp startup"),
                    command_topic: ctx.commandTopic,
                    command_template: '{"color_temp_startup": {{ value }}}',
                    value_template: `{{ value_json.${ctx.nameOf("color_temp_startup")} }}`,
                    min,
                    max,
                    unit_of_measurement: "mired",
                    mode: "box",
                    entity_category: "config",
                },
            },
        ];
    },
    exposes: (attributes, endpoint, property) => {
        const { min, max } = miredsRange(attributes, endpoint);
        return [
            {
                type: "numeric",
                name: "color_temp_startup",
                label: "Color temp startup",
                property: property("color_temp_startup"),
                access: READ_WRITE,
                unit: "mired",
                value_min: min,
                value_max: max,
                presets: [...colorTempPresets(attributes, endpoint), { name: "previous", value: COLOR_TEMP_PREVIOUS }],
            },
        ];
    },
};

/** Options bitmap with bit 0 (ExecuteIfOff) set or cleared and the other bits kept. */
function withExecuteIfOff(current: unknown, on: boolean): number {
    const bits = bitmapOf(current) ?? 0;
    return on ? bits | 1 : bits & ~1;
}

const EXECUTE_IF_OFF_EXPOSE: Expose = {
    type: "binary",
    name: "execute_if_off",
    label: "Execute if off",
    property: "execute_if_off",
    access: READ_WRITE,
    value_on: true,
    value_off: false,
};

const LEVEL = LevelControl.Cluster.id;
const LEVEL_OPTIONS = 15;

/** level_config fields: attribute, valid range, and the zigbee2mqtt value that stands for null. */
const LEVEL_CONFIG_FIELDS = [
    { key: "on_off_transition_time", attribute: 16, min: 0, max: 65535, nullValue: undefined },
    { key: "on_transition_time", attribute: 18, min: 0, max: 65534, nullValue: 65535 },
    { key: "off_transition_time", attribute: 19, min: 0, max: 65534, nullValue: 65535 },
    { key: "on_level", attribute: 17, min: 1, max: 254, nullValue: 255 },
    { key: "current_level_startup", attribute: 16384, min: 0, max: 254, nullValue: 255 },
] as const;

/** zigbee2mqtt's words for current_level_startup / on_level. */
const LEVEL_CONFIG_WORDS: Readonly<Record<string, number>> = { previous: 255, minimum: 0 };

const levelConfig: Control = {
    present: (attributes, endpoint) =>
        LEVEL_CONFIG_FIELDS.some(({ attribute }) => present(attributes, endpoint, LEVEL, attribute)),
    keys: () => ["level_config"],
    paths: [...LEVEL_CONFIG_FIELDS.map(({ attribute }) => `${LEVEL}/${attribute}`), `${LEVEL}/${LEVEL_OPTIONS}`],
    state: (attributes, endpoint) => {
        const config: Record<string, unknown> = {};
        for (const { key, attribute, nullValue } of LEVEL_CONFIG_FIELDS) {
            const value = raw(attributes, endpoint, LEVEL, attribute);
            if (typeof value === "number") {
                config[key] = value;
            } else if (value === null && nullValue !== undefined) {
                config[key] = nullValue;
            }
        }
        const options = bitmapOf(raw(attributes, endpoint, LEVEL, LEVEL_OPTIONS));
        if (options !== undefined) {
            config.execute_if_off = (options & 1) !== 0;
        }
        return { level_config: config };
    },
    setKeys: ["level_config"],
    parse: (message, attributes, endpoint) => {
        const actions: DeviceAction[] = [];
        const warnings: string[] = [];
        const config = message.level_config;
        if (typeof config !== "object" || config === null) {
            return { actions, warnings: ["level_config must be an object"] };
        }
        for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
            if (key === "execute_if_off") {
                const options = withExecuteIfOff(raw(attributes, endpoint, LEVEL, LEVEL_OPTIONS), value === true);
                actions.push({ clusterId: LEVEL, attributeId: LEVEL_OPTIONS, value: options });
                continue;
            }
            const field = LEVEL_CONFIG_FIELDS.find(candidate => candidate.key === key);
            if (field === undefined || !present(attributes, endpoint, LEVEL, field.attribute)) {
                warnings.push(`level_config.${key} not supported by this endpoint`);
                continue;
            }
            const resolved =
                typeof value === "string" && value in LEVEL_CONFIG_WORDS ? LEVEL_CONFIG_WORDS[value] : value;
            if (field.nullValue !== undefined && resolved === field.nullValue) {
                actions.push({ clusterId: LEVEL, attributeId: field.attribute, value: null });
                continue;
            }
            const number = boundedNumber(resolved, `level_config.${key}`, field.min, field.max, warnings);
            if (number !== undefined) {
                actions.push({ clusterId: LEVEL, attributeId: field.attribute, value: number });
            }
        }
        return { actions, warnings };
    },
    primaryKey: "level_config",
    discovery: () => [],
    exposes: (attributes, endpoint, property) => [
        {
            type: "composite",
            name: "level_config",
            label: "Level config",
            property: property("level_config"),
            access: READ_WRITE,
            features: [
                ...LEVEL_CONFIG_FIELDS.filter(({ attribute }) => present(attributes, endpoint, LEVEL, attribute)).map(
                    ({ key, min, max, nullValue }) => ({
                        type: "numeric",
                        name: key,
                        label: key.replace(/_/g, " ").replace(/^./, c => c.toUpperCase()),
                        property: key,
                        access: READ_WRITE,
                        value_min: min,
                        value_max: max,
                        ...(nullValue === undefined ? {} : { presets: [{ name: "previous", value: nullValue }] }),
                    }),
                ),
                EXECUTE_IF_OFF_EXPOSE,
            ],
        },
    ],
};

const colorOptions: Control = {
    present: (attributes, endpoint) => present(attributes, endpoint, COLOR, COLOR_OPTIONS),
    keys: () => ["color_options"],
    paths: [`${COLOR}/${COLOR_OPTIONS}`],
    state: (attributes, endpoint) => {
        const options = bitmapOf(raw(attributes, endpoint, COLOR, COLOR_OPTIONS));
        return options === undefined ? {} : { color_options: { execute_if_off: (options & 1) !== 0 } };
    },
    setKeys: ["color_options"],
    parse: (message, attributes, endpoint) => {
        const options = message.color_options;
        if (typeof options !== "object" || options === null || !("execute_if_off" in options)) {
            return { actions: [], warnings: ['color_options must be an object with "execute_if_off"'] };
        }
        const on = options.execute_if_off === true;
        const value = withExecuteIfOff(raw(attributes, endpoint, COLOR, COLOR_OPTIONS), on);
        return { actions: [{ clusterId: COLOR, attributeId: COLOR_OPTIONS, value }], warnings: [] };
    },
    primaryKey: "color_options",
    discovery: () => [],
    exposes: (_attributes, _endpoint, property) => [
        {
            type: "composite",
            name: "color_options",
            label: "Color options",
            property: property("color_options"),
            access: READ_WRITE,
            features: [EXECUTE_IF_OFF_EXPOSE],
        },
    ],
};

/** Controls in entity order. Each takes distinct `/set` properties, so several may share an endpoint. */
export const CONTROLS: readonly Control[] = [
    cover,
    lock,
    thermostat,
    fan,
    valve,
    modeSelect,
    pumpOperationMode,
    pumpControlMode,
    smokeSensitivity,
    smokeSelfTest,
    powerOnBehavior,
    colorTempStartup,
    levelConfig,
    colorOptions,
    identify,
];

export function controlsOf(attributes: AttributesData, endpoint: number): Control[] {
    return CONTROLS.filter(control => control.present(attributes, endpoint));
}

/** Endpoints that accept `/set`: OnOff endpoints and endpoints with a control. */
export function controllableEndpointsOf(attributes: AttributesData): number[] {
    const endpoints = new Set<number>();
    for (const path of Object.keys(attributes)) {
        const endpoint = Number(path.split("/", 1)[0]);
        if (Number.isInteger(endpoint)) {
            endpoints.add(endpoint);
        }
    }
    return [...endpoints]
        .filter(
            endpoint =>
                raw(attributes, endpoint, ONOFF_CLUSTER_ID, 0) !== undefined ||
                controlsOf(attributes, endpoint).length > 0,
        )
        .sort((a, b) => a - b);
}

/**
 * Turn the `/set` message for one endpoint into Matter actions: each control takes its own properties,
 * the light parser (OnOff/LevelControl/ColorControl) what is left, and anything nobody takes is reported.
 * Light commands go first, so a light being turned on already shows an effect sent with it.
 */
export function parseEndpointSet(
    message: Record<string, unknown>,
    attributes: AttributesData,
    endpoint: number,
): ParsedActions | undefined {
    const controlActions: DeviceAction[] = [];
    const lightActions: DeviceAction[] = [];
    const warnings: string[] = [];
    let rest = { ...message };
    for (const control of controlsOf(attributes, endpoint)) {
        const claimed: Record<string, unknown> = {};
        for (const key of control.setKeys) {
            if (key in rest) {
                claimed[key] = rest[key];
                delete rest[key];
            }
        }
        if (Object.keys(claimed).length > 0) {
            const parsed = control.parse(claimed, attributes, endpoint);
            controlActions.push(...parsed.actions);
            warnings.push(...parsed.warnings);
        }
    }
    const caps = lightCapabilitiesOf(attributes, endpoint);
    if (Object.keys(rest).length > 0 && caps.onOff) {
        const on = raw(attributes, endpoint, ONOFF_CLUSTER_ID, 0);
        const parsed = parseSetObject(rest, caps, typeof on === "boolean" ? on : undefined);
        lightActions.push(...(parsed?.commands ?? []));
        warnings.push(...(parsed?.warnings ?? []));
        rest = {};
    }
    for (const key of Object.keys(rest)) {
        warnings.push(`unsupported attribute "${key}"`);
    }
    const actions = [...lightActions, ...controlActions];
    if (actions.length === 0 && warnings.length === 0) {
        return undefined;
    }
    return { actions, warnings };
}
