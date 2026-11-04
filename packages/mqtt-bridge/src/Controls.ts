/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AttributesData } from "@matter-server/ws-controller";
import { DoorLock, Thermostat, WindowCovering } from "@matter/main/clusters";
import type { Expose } from "./Exposes.js";
import { lightCapabilitiesOf, ONOFF_CLUSTER_ID } from "./LightCapabilities.js";
import { parseSetObject, type DeviceCommand } from "./SetCommands.js";

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

/** Controls in entity order. An endpoint normally carries at most one. */
export const CONTROLS: readonly Control[] = [cover, lock, thermostat];

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
 */
export function parseEndpointSet(
    message: Record<string, unknown>,
    attributes: AttributesData,
    endpoint: number,
): ParsedActions | undefined {
    const actions: DeviceAction[] = [];
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
            actions.push(...parsed.actions);
            warnings.push(...parsed.warnings);
        }
    }
    const caps = lightCapabilitiesOf(attributes, endpoint);
    if (Object.keys(rest).length > 0 && caps.onOff) {
        const on = raw(attributes, endpoint, ONOFF_CLUSTER_ID, 0);
        const parsed = parseSetObject(rest, caps, typeof on === "boolean" ? on : undefined);
        actions.push(...(parsed?.commands ?? []));
        warnings.push(...(parsed?.warnings ?? []));
        rest = {};
    }
    for (const key of Object.keys(rest)) {
        warnings.push(`unsupported attribute "${key}"`);
    }
    if (actions.length === 0 && warnings.length === 0) {
        return undefined;
    }
    return { actions, warnings };
}
