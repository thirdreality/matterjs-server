/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

/** A parsed `<prefix>/<device>[/<endpoint>]/set` topic. */
export interface SetTopic {
    device: string;
    endpoint?: number;
}

/**
 * Builds and parses the matter2mqtt topic layout under a configurable prefix.
 *
 * Layout:
 * - `<prefix>/bridge/state|info|devices` — bridge-level topics
 * - `<prefix>/<device>` — device state (single relevant endpoint)
 * - `<prefix>/<device>/<endpoint>` — device state (multi-endpoint devices)
 * - `<prefix>/<device>[/<endpoint>]/set` — inbound commands
 */
export class Topics {
    readonly #prefix: string;

    constructor(prefix: string) {
        if (!/^[^+#/\s][^+#\s]*$/.test(prefix) || prefix.endsWith("/")) {
            throw new Error(`Invalid MQTT topic prefix "${prefix}": must not be empty or contain +, #, whitespace`);
        }
        this.#prefix = prefix;
    }

    get prefix(): string {
        return this.#prefix;
    }

    get bridgeState(): string {
        return `${this.#prefix}/bridge/state`;
    }

    get bridgeInfo(): string {
        return `${this.#prefix}/bridge/info`;
    }

    get bridgeDevices(): string {
        return `${this.#prefix}/bridge/devices`;
    }

    deviceState(device: string, endpoint?: number): string {
        return endpoint === undefined ? `${this.#prefix}/${device}` : `${this.#prefix}/${device}/${endpoint}`;
    }

    deviceAvailability(device: string): string {
        return `${this.#prefix}/${device}/availability`;
    }

    /** Subscription filters covering both set topic variants. */
    get setFilters(): string[] {
        return [`${this.#prefix}/+/set`, `${this.#prefix}/+/+/set`];
    }

    /**
     * Parse an inbound set topic. Returns undefined for topics that are not
     * device commands (including anything under `bridge/`).
     */
    parseSetTopic(topic: string): SetTopic | undefined {
        if (!topic.startsWith(`${this.#prefix}/`)) {
            return undefined;
        }
        const segments = topic.slice(this.#prefix.length + 1).split("/");
        if (segments[segments.length - 1] !== "set") {
            return undefined;
        }
        const [device, middle] = segments;
        if (device === undefined || device === "" || device === "bridge") {
            return undefined;
        }
        if (segments.length === 2) {
            return { device };
        }
        if (segments.length === 3 && middle !== undefined && /^\d+$/.test(middle)) {
            return { device, endpoint: parseInt(middle, 10) };
        }
        return undefined;
    }
}
