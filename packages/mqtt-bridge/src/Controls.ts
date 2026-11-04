/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AttributesData } from "@matter-server/ws-controller";
import { WindowCovering } from "@matter/main/clusters";
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

/** Controls in entity order. An endpoint normally carries at most one. */
export const CONTROLS: readonly Control[] = [cover];

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
