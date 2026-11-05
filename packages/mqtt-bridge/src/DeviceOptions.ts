/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Expose } from "./Exposes.js";
import { readJsonFile, writeJsonFile } from "./JsonFile.js";

/** Bridge-side settings of one device, zigbee2mqtt's device options. */
export interface DeviceOptions {
    /** Publish the device state retained (default true). */
    retain?: boolean;
    /** Combine state changes within this many seconds into one publish. */
    debounce?: number;
    /** Default `transition` (seconds) for light commands that carry none. */
    transition?: number;
    /** Count cover position and tilt from open (0) to closed (100) instead. */
    invert_cover?: boolean;
}

type OptionKind = "binary" | "numeric";

/** Each option with its type, range, and whether it applies to every device or only lights / covers. */
const OPTIONS: Readonly<
    Record<
        keyof DeviceOptions,
        { kind: OptionKind; min?: number; max?: number; for: "all" | "light" | "cover"; description: string }
    >
> = {
    retain: { kind: "binary", for: "all", description: "Publish the state retained" },
    debounce: {
        kind: "numeric",
        min: 0,
        max: 3600,
        for: "all",
        description: "Combine state changes within this many seconds into one publish",
    },
    transition: {
        kind: "numeric",
        min: 0,
        max: 6553,
        for: "light",
        description: "Transition time in seconds for light commands that give none",
    },
    invert_cover: {
        kind: "binary",
        for: "cover",
        description: "Count position and tilt from open (0) to closed (100)",
    },
};

/**
 * Merge an options update into the current options: `null` removes an option, anything else must be valid.
 * Returns the merged options, or the problems with the update.
 */
export function mergeOptions(current: DeviceOptions, update: unknown): { options: DeviceOptions; errors: string[] } {
    const errors: string[] = [];
    if (typeof update !== "object" || update === null || Array.isArray(update)) {
        return { options: current, errors: ['"options" must be an object'] };
    }
    const options: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(update)) {
        const spec = OPTIONS[key as keyof DeviceOptions];
        if (spec === undefined) {
            errors.push(`unknown option "${key}"`);
            continue;
        }
        if (value === null) {
            delete options[key];
            continue;
        }
        if (spec.kind === "binary") {
            if (typeof value !== "boolean") {
                errors.push(`option "${key}" must be true or false`);
                continue;
            }
            options[key] = value;
            continue;
        }
        const number = typeof value === "string" ? Number(value) : value;
        if (
            typeof number !== "number" ||
            !Number.isFinite(number) ||
            number < (spec.min ?? 0) ||
            number > (spec.max ?? Infinity)
        ) {
            errors.push(`option "${key}" must be a number from ${spec.min} to ${spec.max}`);
            continue;
        }
        options[key] = number;
    }
    return { options, errors };
}

/** zigbee2mqtt `definition.options`: the options that apply to a device with these capabilities. */
export function optionExposesOf(capabilities: { light: boolean; cover: boolean }): Expose[] {
    return Object.entries(OPTIONS)
        .filter(([, spec]) => spec.for === "all" || capabilities[spec.for])
        .map(([name, spec]) => ({
            type: spec.kind,
            name,
            label: name.replace(/_/g, " ").replace(/^./, c => c.toUpperCase()),
            property: name,
            access: 2,
            description: spec.description,
            ...(spec.kind === "binary"
                ? { value_on: true, value_off: false }
                : { value_min: spec.min, value_max: spec.max, unit: "s" }),
        }));
}

/** Device options by device key, kept in a JSON file next to the server's storage. */
export class DeviceOptionsStore {
    readonly #path?: string;
    #options: Record<string, DeviceOptions> = {};

    /** Without a path the options live in memory only. */
    constructor(path?: string) {
        this.#path = path;
    }

    async load(): Promise<void> {
        if (this.#path === undefined) {
            return;
        }
        const stored = await readJsonFile(this.#path);
        if (typeof stored === "object" && stored !== null) {
            this.#options = stored as Record<string, DeviceOptions>;
        }
    }

    get(device: string): DeviceOptions {
        return this.#options[device] ?? {};
    }

    async set(device: string, options: DeviceOptions): Promise<void> {
        if (Object.keys(options).length === 0) {
            delete this.#options[device];
        } else {
            this.#options[device] = options;
        }
        await this.#save();
    }

    async #save(): Promise<void> {
        if (this.#path !== undefined) {
            await writeJsonFile(this.#path, this.#options);
        }
    }
}
