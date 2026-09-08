/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { COLOR_CLUSTER_ID, LEVEL_CLUSTER_ID, type LightCapabilities } from "./LightCapabilities.js";
import type { DeviceCommand } from "./SetCommands.js";

/**
 * zigbee2mqtt's relative light control: `*_move` runs until stopped, `*_step` applies one increment.
 * Mapped onto the LevelControl and ColorControl move/step commands, whose mode enums happen to match
 * Zigbee's (LevelControl Up=0/Down=1, ColorControl Stop=0/Up=1/Down=3).
 *
 * Ported from zigbee-herdsman-converters toZigbee light_brightness_move/step,
 * light_colortemp_move/step and light_hue_saturation_move/step.
 */

/** LevelControl MoveMode/StepMode. */
const LEVEL_UP = 0;
const LEVEL_DOWN = 1;
/** ColorControl MoveMode/StepMode. */
const COLOR_STOP = 0;
const COLOR_UP = 1;
const COLOR_DOWN = 3;

/** Default rate of the `up`/`down` word forms of color_temp_move (zigbee2mqtt's legacy value). */
const COLOR_TEMP_WORD_RATE = 55;
/** Mireds bounds zigbee2mqtt applies to the word forms, versus the full range for numeric ones. */
const COLOR_TEMP_WORD_MIN = 153;
const COLOR_TEMP_WORD_MAX = 370;
const COLOR_TEMP_MIN = 0;
const COLOR_TEMP_MAX = 600;

const OPTIONS = { optionsMask: 0, optionsOverride: 0 };

/** Message properties handled here, so the set parser does not report them as unsupported. */
export const MOVE_STEP_KEYS: readonly string[] = [
    "brightness_move",
    "brightness_move_onoff",
    "brightness_step",
    "brightness_step_onoff",
    "color_temp_move",
    "colortemp_move",
    "color_temp_step",
    "hue_move",
    "hue_step",
    "saturation_move",
    "saturation_step",
];

/** Sibling property of the color_temp_move word forms. */
export const MOVE_STEP_OPTION_KEYS: readonly string[] = ["rate"];

const STOP_WORDS = ["stop", "release", "0"];

function numberOf(value: unknown): number | undefined {
    const parsed = typeof value === "string" ? Number(value.trim()) : value;
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

/** A move/step amount: a signed number, or a word that means "stop". */
function amountOf(value: unknown): number | "stop" | undefined {
    if (typeof value === "string" && STOP_WORDS.includes(value.trim().toLowerCase())) {
        return "stop";
    }
    const parsed = numberOf(value);
    return parsed === 0 ? "stop" : parsed;
}

function levelMove(value: unknown, withOnOff: boolean): DeviceCommand | undefined {
    const amount = amountOf(value);
    if (amount === undefined) {
        return undefined;
    }
    if (amount === "stop") {
        // zigbee2mqtt uses the plain stop for both spellings
        return { clusterId: LEVEL_CLUSTER_ID, commandName: "stop", data: { ...OPTIONS } };
    }
    return {
        clusterId: LEVEL_CLUSTER_ID,
        commandName: withOnOff ? "moveWithOnOff" : "move",
        data: { moveMode: amount > 0 ? LEVEL_UP : LEVEL_DOWN, rate: Math.abs(amount), ...OPTIONS },
    };
}

function levelStep(value: unknown, withOnOff: boolean, transitionTime: number): DeviceCommand | undefined {
    const amount = numberOf(value);
    if (amount === undefined) {
        return undefined;
    }
    return {
        clusterId: LEVEL_CLUSTER_ID,
        commandName: withOnOff ? "stepWithOnOff" : "step",
        data: {
            stepMode: amount > 0 ? LEVEL_UP : LEVEL_DOWN,
            stepSize: Math.abs(amount),
            transitionTime,
            ...OPTIONS,
        },
    };
}

function colorMove(value: unknown, commandName: string): DeviceCommand | undefined {
    const amount = amountOf(value);
    if (amount === undefined) {
        return undefined;
    }
    const [moveMode, rate] =
        amount === "stop" ? [COLOR_STOP, 1] : [amount > 0 ? COLOR_UP : COLOR_DOWN, Math.abs(amount)];
    return { clusterId: COLOR_CLUSTER_ID, commandName, data: { moveMode, rate, ...OPTIONS } };
}

function colorStep(value: unknown, commandName: string, transitionTime: number): DeviceCommand | undefined {
    const amount = numberOf(value);
    if (amount === undefined) {
        return undefined;
    }
    return {
        clusterId: COLOR_CLUSTER_ID,
        commandName,
        data: {
            stepMode: amount > 0 ? COLOR_UP : COLOR_DOWN,
            stepSize: Math.abs(amount),
            transitionTime,
            ...OPTIONS,
        },
    };
}

/**
 * color_temp_move takes a signed rate, the words `up`/`down`/`stop`, or an object carrying `rate` and
 * optional mireds bounds. The word forms keep zigbee2mqtt's narrower default bounds.
 */
function colorTempMove(value: unknown, message: Record<string, unknown>): DeviceCommand | undefined {
    let moveMode: number;
    let rate: number;
    let minimum = COLOR_TEMP_MIN;
    let maximum = COLOR_TEMP_MAX;

    if (typeof value === "string" && !STOP_WORDS.includes(value.trim().toLowerCase())) {
        const word = value.trim().toLowerCase();
        if (word !== "up" && word !== "down" && word !== "1") {
            return undefined;
        }
        moveMode = word === "down" ? COLOR_DOWN : COLOR_UP;
        rate = numberOf(message.rate) ?? COLOR_TEMP_WORD_RATE;
        minimum = COLOR_TEMP_WORD_MIN;
        maximum = COLOR_TEMP_WORD_MAX;
    } else if (typeof value === "object" && value !== null) {
        const options = value as Record<string, unknown>;
        const requested = numberOf(options.rate);
        if (requested === undefined) {
            return undefined;
        }
        [moveMode, rate] =
            requested === 0 ? [COLOR_STOP, 1] : [requested > 0 ? COLOR_UP : COLOR_DOWN, Math.abs(requested)];
        minimum = numberOf(options.minimum) ?? minimum;
        maximum = numberOf(options.maximum) ?? maximum;
        if (minimum >= maximum) {
            return undefined;
        }
    } else {
        const amount = amountOf(value);
        if (amount === undefined) {
            return undefined;
        }
        [moveMode, rate] = amount === "stop" ? [COLOR_STOP, 1] : [amount > 0 ? COLOR_UP : COLOR_DOWN, Math.abs(amount)];
    }

    return {
        clusterId: COLOR_CLUSTER_ID,
        commandName: "moveColorTemperature",
        data: {
            moveMode,
            rate,
            colorTemperatureMinimumMireds: minimum,
            colorTemperatureMaximumMireds: maximum,
            ...OPTIONS,
        },
    };
}

/**
 * Build the move/step commands a message asks for, in the order the message lists them. Properties the
 * endpoint cannot do, and values that make no sense, are reported through `warnings`.
 */
export function moveStepCommandsOf(
    message: Record<string, unknown>,
    caps: LightCapabilities,
    transitionTime: number,
    warnings: string[],
): DeviceCommand[] {
    const commands = new Array<DeviceCommand>();

    for (const key of Object.keys(message)) {
        if (!MOVE_STEP_KEYS.includes(key)) {
            continue;
        }
        const value = message[key];
        const requires = key.startsWith("brightness")
            ? { capable: caps.brightness, feature: "brightness" }
            : key.startsWith("hue") || key.startsWith("saturation")
              ? { capable: caps.hueSaturation, feature: "hue/saturation" }
              : { capable: caps.colorTemp, feature: "color_temp" };
        if (!requires.capable) {
            warnings.push(`${requires.feature} not supported by this endpoint, ignoring "${key}"`);
            continue;
        }

        let command: DeviceCommand | undefined;
        switch (key) {
            case "brightness_move":
            case "brightness_move_onoff":
                command = levelMove(value, key.endsWith("_onoff"));
                break;
            case "brightness_step":
            case "brightness_step_onoff":
                command = levelStep(value, key.endsWith("_onoff"), transitionTime);
                break;
            case "color_temp_move":
            case "colortemp_move":
                command = colorTempMove(value, message);
                break;
            case "color_temp_step":
                command = colorStep(value, "stepColorTemperature", transitionTime);
                break;
            case "hue_move":
                command = colorMove(value, "moveHue");
                break;
            case "hue_step":
                command = colorStep(value, "stepHue", transitionTime);
                break;
            case "saturation_move":
                command = colorMove(value, "moveSaturation");
                break;
            default:
                command = colorStep(value, "stepSaturation", transitionTime);
                break;
        }

        if (command === undefined) {
            warnings.push(`invalid ${key} "${String(value)}"`);
            continue;
        }
        if (key === "color_temp_step") {
            // Bounds are required fields of the Matter command, unlike Zigbee's
            command.data.colorTemperatureMinimumMireds = COLOR_TEMP_MIN;
            command.data.colorTemperatureMaximumMireds = COLOR_TEMP_MAX;
        }
        commands.push(command);
    }

    return commands;
}
