/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { COLOR_CLUSTER_ID, LEVEL_CLUSTER_ID, ONOFF_CLUSTER_ID, type LightCapabilities } from "./LightCapabilities.js";

/** One Matter command derived from a /set message. */
export interface DeviceCommand {
    clusterId: number;
    commandName: string;
    data: Record<string, unknown>;
}

export interface ParsedSetMessage {
    commands: DeviceCommand[];
    /** Ignored/rejected attributes, for logging. */
    warnings: string[];
}

/** zigbee2mqtt's bare-payload fallback values for `/set` without attribute. */
const STATE_VALUES = ["on", "off", "toggle", "open", "close", "stop", "lock", "unlock"];

/** color_temp presets (zigbee2mqtt light_colortemp): coolest/warmest resolve to the device range. */
const COLOR_TEMP_PRESETS: Record<string, number | "min" | "max"> = {
    coolest: "min",
    cool: 250,
    neutral: 370,
    warm: 454,
    warmest: "max",
};

interface StateBrightness {
    /** "on" | "off" | "toggle", null = explicit `state: null` (adjust level only), undefined = absent. */
    state: string | null | undefined;
    brightness: number | undefined;
}

/**
 * Parse an inbound /set message into Matter commands, following zigbee2mqtt semantics.
 *
 * @param payload   raw MQTT payload
 * @param attribute topic attribute for the `/set/<attribute>` form, if any
 * @param caps      capabilities of the target endpoint (for filtering and value clamping)
 * @param currentOn cached OnOff state, used to resolve `toggle` combined with brightness
 * @returns parsed commands and warnings, or undefined if the message is not usable at all
 */
export function parseSetMessage(
    payload: string,
    attribute: string | undefined,
    caps: LightCapabilities,
    currentOn?: boolean,
): ParsedSetMessage | undefined {
    const message = messageOf(payload, attribute);
    if (message === undefined) {
        return undefined;
    }
    return parseSetObject(message, caps, currentOn);
}

/** Parse an already-normalized message object into Matter commands. */
export function parseSetObject(
    message: Record<string, unknown>,
    caps: LightCapabilities,
    currentOn?: boolean,
): ParsedSetMessage | undefined {
    const warnings: string[] = [];
    const transitionTime = transitionTimeOf(message, warnings);

    let stateCommand: DeviceCommand | undefined;
    try {
        stateCommand = stateBrightnessCommand(stateBrightnessOf(message), caps, transitionTime, currentOn);
    } catch (error) {
        warnings.push((error as Error).message);
    }

    const colorTempCommand = caps.colorTemp
        ? colorTempCommandOf(message, caps, transitionTime, warnings)
        : warnIfPresent(message, "color_temp", "color_temp not supported by this endpoint", warnings);
    const colorCommand =
        caps.hueSaturation || caps.xy
            ? colorCommandOf(message, caps, transitionTime, warnings)
            : warnIfPresent(message, "color", "color not supported by this endpoint", warnings);

    for (const key of Object.keys(message)) {
        if (!["state", "brightness", "brightness_percent", "color", "color_temp", "transition"].includes(key)) {
            warnings.push(`unsupported attribute "${key}"`);
        }
    }

    // zigbee2mqtt ordering: turning off comes first (some bulbs reject color changes while off),
    // anything else last (set color/color_temp before turning on)
    const colorCommands = [colorTempCommand, colorCommand].filter(c => c !== undefined);
    const turningOff = stateCommand?.commandName === "off" || (stateCommand?.data.level as number | undefined) === 0;
    const commands = turningOff
        ? [stateCommand as DeviceCommand, ...colorCommands]
        : [...colorCommands, ...(stateCommand === undefined ? [] : [stateCommand])];

    if (commands.length === 0 && warnings.length === 0) {
        return undefined;
    }
    return { commands, warnings };
}

/**
 * Split a message by the zigbee2mqtt `_<endpoint>` property suffix: `{state_1:"ON"}` targets
 * endpoint 1. Unsuffixed keys go to the default endpoint. Suffixes not in `endpoints` are
 * treated as part of the property name (matching z2m, which only strips known endpoint names).
 */
export function splitByEndpointSuffix(
    message: Record<string, unknown>,
    endpoints: number[],
    defaultEndpoint: number,
): Map<number, Record<string, unknown>> {
    const result = new Map<number, Record<string, unknown>>();
    const add = (endpoint: number, key: string, value: unknown) => {
        const sub = result.get(endpoint) ?? {};
        sub[key] = value;
        result.set(endpoint, sub);
    };
    for (const [key, value] of Object.entries(message)) {
        const match = key.match(/^(.*?)_(\d+)$/);
        const suffixEndpoint = match === null ? undefined : parseInt(match[2], 10);
        if (match !== null && suffixEndpoint !== undefined && endpoints.includes(suffixEndpoint)) {
            add(suffixEndpoint, match[1], value);
        } else {
            add(defaultEndpoint, key, value);
        }
    }
    return result;
}

/** Normalize the payload to a message object (zigbee2mqtt publish.ts parseMessage). */
export function messageOf(payload: string, attribute: string | undefined): Record<string, unknown> | undefined {
    if (attribute !== undefined) {
        try {
            return { [attribute]: JSON.parse(payload) };
        } catch {
            return { [attribute]: payload };
        }
    }
    try {
        const parsed: unknown = JSON.parse(payload);
        if (typeof parsed === "object" && parsed !== null) {
            return parsed as Record<string, unknown>;
        }
        // JSON scalar (true, "ON", 1): treat like the bare-payload form below
        return scalarStateMessage(parsed);
    } catch {
        return scalarStateMessage(payload.trim());
    }
}

function scalarStateMessage(value: unknown): Record<string, unknown> | undefined {
    if (typeof value === "boolean") {
        return { state: value };
    }
    if (typeof value === "string" && STATE_VALUES.includes(value.toLowerCase())) {
        return { state: value };
    }
    return undefined;
}

/** Message `transition` (seconds) to Matter transitionTime (0.1s units). */
function transitionTimeOf(message: Record<string, unknown>, warnings: string[]): number {
    const transition = message.transition;
    if (transition === undefined) {
        return 0;
    }
    const seconds = Number(transition);
    if (Number.isNaN(seconds) || seconds < 0) {
        warnings.push(`invalid transition "${String(transition)}"`);
        return 0;
    }
    return Math.round(seconds * 10);
}

function stateBrightnessOf(message: Record<string, unknown>): StateBrightness {
    let state: string | null | undefined;
    if (message.state === null) {
        state = null;
    } else if (typeof message.state === "boolean") {
        state = message.state ? "on" : "off";
    } else if (message.state !== undefined) {
        if (typeof message.state !== "string") {
            throw new Error(`invalid state "${String(message.state)}"`);
        }
        state = message.state.toLowerCase();
        if (!["on", "off", "toggle"].includes(state)) {
            throw new Error(`invalid state "${message.state}"`);
        }
    }

    let brightness: number | undefined;
    if (message.brightness !== undefined) {
        brightness = Number(message.brightness);
    } else if (message.brightness_percent !== undefined) {
        brightness = Math.round((Number(message.brightness_percent) / 100) * 255);
    }
    if (brightness === 255) {
        // zigbee2mqtt allows 255 for backwards compatibility
        brightness = 254;
    }
    if (brightness !== undefined && (Number.isNaN(brightness) || brightness < 0 || brightness > 254)) {
        throw new Error(`invalid brightness "${String(message.brightness ?? message.brightness_percent)}"`);
    }

    return { state, brightness };
}

/**
 * The zigbee2mqtt light_onoff_brightness decision table:
 * - brightness without state: state is inferred (0 = off), MoveToLevelWithOnOff
 * - explicit `state: null`: adjust the level only (MoveToLevel, minimum 1)
 * - `state: "on"` with brightness 0 is raised to 1 (does not turn off)
 * - toggle with brightness resolves against the cached state
 */
function stateBrightnessCommand(
    { state, brightness }: StateBrightness,
    caps: LightCapabilities,
    transitionTime: number,
    currentOn?: boolean,
): DeviceCommand | undefined {
    if (state === undefined && brightness === undefined) {
        return undefined;
    }
    if (!caps.onOff) {
        throw new Error("state/brightness not supported by this endpoint");
    }

    if (brightness !== undefined && !caps.brightness) {
        throw new Error("brightness not supported by this endpoint");
    }

    if (brightness === undefined) {
        // Pure state command; "off" honors an explicit transition via MoveToLevelWithOnOff(0)
        if (state === null) {
            return undefined;
        }
        if (state === "off" && transitionTime > 0 && caps.brightness) {
            return levelCommand("moveToLevelWithOnOff", 0, transitionTime);
        }
        return { clusterId: ONOFF_CLUSTER_ID, commandName: state as string, data: {} };
    }

    let target = state ?? (brightness === 0 ? "off" : "on");
    if (target === "toggle") {
        if (currentOn === undefined) {
            throw new Error("toggle with brightness requires a known current state");
        }
        target = currentOn ? "off" : "on";
    }

    if (target === "off") {
        return levelCommand("moveToLevelWithOnOff", 0, transitionTime);
    }
    let level = brightness;
    if (level === 0) {
        level = 1;
    }
    return levelCommand(state === null ? "moveToLevel" : "moveToLevelWithOnOff", level, transitionTime);
}

function levelCommand(commandName: string, level: number, transitionTime: number): DeviceCommand {
    return {
        clusterId: LEVEL_CLUSTER_ID,
        commandName,
        data: { level, transitionTime, optionsMask: 0, optionsOverride: 0 },
    };
}

function colorTempCommandOf(
    message: Record<string, unknown>,
    caps: LightCapabilities,
    transitionTime: number,
    warnings: string[],
): DeviceCommand | undefined {
    let value = message.color_temp;
    if (value === undefined) {
        return undefined;
    }
    if (typeof value === "string" && value in COLOR_TEMP_PRESETS) {
        const preset = COLOR_TEMP_PRESETS[value];
        value =
            preset === "min"
                ? (caps.colorTempMinMireds ?? 153)
                : preset === "max"
                  ? (caps.colorTempMaxMireds ?? 500)
                  : preset;
    }
    const mireds = Number(value);
    if (Number.isNaN(mireds)) {
        warnings.push(`invalid color_temp "${String(message.color_temp)}"`);
        return undefined;
    }
    const clamped = Math.min(
        caps.colorTempMaxMireds ?? Infinity,
        Math.max(caps.colorTempMinMireds ?? 1, Math.round(mireds)),
    );
    return {
        clusterId: COLOR_CLUSTER_ID,
        commandName: "moveToColorTemperature",
        data: { colorTemperatureMireds: clamped, transitionTime, optionsMask: 0, optionsOverride: 0 },
    };
}

function colorCommandOf(
    message: Record<string, unknown>,
    caps: LightCapabilities,
    transitionTime: number,
    warnings: string[],
): DeviceCommand | undefined {
    const color = message.color;
    if (color === undefined) {
        return undefined;
    }
    if (typeof color !== "object" || color === null) {
        warnings.push(`unsupported color format "${String(color)}" (only {x,y} and {hue,saturation}/{h,s} for now)`);
        return undefined;
    }
    const c = color as Record<string, unknown>;
    const base = { transitionTime, optionsMask: 0, optionsOverride: 0 };

    if (c.x !== undefined && c.y !== undefined) {
        if (!caps.xy) {
            warnings.push("xy color not supported by this endpoint");
            return undefined;
        }
        const x = clamp(Number(c.x), 0, 1);
        const y = clamp(Number(c.y), 0, 1);
        if (Number.isNaN(x) || Number.isNaN(y)) {
            warnings.push(`invalid xy color ${JSON.stringify(color)}`);
            return undefined;
        }
        return {
            clusterId: COLOR_CLUSTER_ID,
            commandName: "moveToColor",
            data: { colorX: Math.round(x * 65535), colorY: Math.round(y * 65535), ...base },
        };
    }

    // hue 0-360 / saturation 0-100 in the MQTT API (zigbee2mqtt ColorHSV); either may be given alone
    const hueIn = c.hue ?? c.h;
    const satIn = c.saturation ?? c.s;
    if (hueIn === undefined && satIn === undefined) {
        warnings.push(
            `unsupported color format ${JSON.stringify(color)} (only {x,y} and {hue,saturation}/{h,s} for now)`,
        );
        return undefined;
    }
    if (!caps.hueSaturation) {
        warnings.push("hue/saturation color not supported by this endpoint");
        return undefined;
    }
    const hue = hueIn === undefined ? undefined : ((Number(hueIn) % 360) + 360) % 360;
    const saturation = satIn === undefined ? undefined : clamp(Number(satIn), 0, 100);
    if ((hue !== undefined && Number.isNaN(hue)) || (saturation !== undefined && Number.isNaN(saturation))) {
        warnings.push(`invalid hue/saturation color ${JSON.stringify(color)}`);
        return undefined;
    }

    const sat254 = saturation === undefined ? undefined : Math.round((saturation / 100) * 254);
    if (hue !== undefined && sat254 !== undefined) {
        if (caps.enhancedHue) {
            return {
                clusterId: COLOR_CLUSTER_ID,
                commandName: "enhancedMoveToHueAndSaturation",
                data: { enhancedHue: Math.round((hue / 360) * 65535), saturation: sat254, ...base },
            };
        }
        return {
            clusterId: COLOR_CLUSTER_ID,
            commandName: "moveToHueAndSaturation",
            data: { hue: Math.round((hue / 360) * 254), saturation: sat254, ...base },
        };
    }
    if (hue !== undefined) {
        if (caps.enhancedHue) {
            return {
                clusterId: COLOR_CLUSTER_ID,
                commandName: "enhancedMoveToHue",
                data: { enhancedHue: Math.round((hue / 360) * 65535), direction: 0, ...base },
            };
        }
        return {
            clusterId: COLOR_CLUSTER_ID,
            commandName: "moveToHue",
            data: { hue: Math.round((hue / 360) * 254), direction: 0, ...base },
        };
    }
    return {
        clusterId: COLOR_CLUSTER_ID,
        commandName: "moveToSaturation",
        data: { saturation: sat254, ...base },
    };
}

function warnIfPresent(message: Record<string, unknown>, key: string, warning: string, warnings: string[]): undefined {
    if (message[key] !== undefined) {
        warnings.push(warning);
    }
    return undefined;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
