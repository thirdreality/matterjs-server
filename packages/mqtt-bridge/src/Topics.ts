/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

/** A parsed inbound command topic (`set`, `set/<attribute>` or `get`). */
export interface InboundTopic {
    device: string;
    endpoint?: number;
    kind: "set" | "get";
    /** For `set/<attribute>` topics: the attribute the bare payload addresses. */
    attribute?: string;
}

/**
 * Builds and parses the matter2mqtt topic layout under a configurable prefix.
 *
 * Layout (zigbee2mqtt style):
 * - `<prefix>/bridge/state|info|devices` — bridge-level topics
 * - `<prefix>/<device>` — device state (single relevant endpoint)
 * - `<prefix>/<device>/<endpoint>` — device state (multi-endpoint devices)
 * - `<prefix>/<device>[/<endpoint>]/set` — inbound commands (JSON payload)
 * - `<prefix>/<device>[/<endpoint>]/set/<attribute>` — inbound command, bare payload
 * - `<prefix>/<device>[/<endpoint>]/get` — request a re-publish of the current state
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

    /** Subscription filters covering all inbound command topic variants (disjoint set). */
    get commandFilters(): string[] {
        const p = this.#prefix;
        return [
            `${p}/+/set`,
            `${p}/+/+/set`,
            `${p}/+/set/+`,
            `${p}/+/+/set/+`,
            `${p}/+/get`,
            `${p}/+/+/get`,
            `${p}/bridge/request/#`,
        ];
    }

    /** Parse a `bridge/request/<command>` topic; the command may contain slashes (device/remove). */
    parseBridgeRequest(topic: string): string | undefined {
        const prefix = `${this.#prefix}/bridge/request/`;
        if (!topic.startsWith(prefix)) {
            return undefined;
        }
        const command = topic.slice(prefix.length);
        return command.length > 0 ? command : undefined;
    }

    bridgeResponse(command: string): string {
        return `${this.#prefix}/bridge/response/${command}`;
    }

    /** Retained human-readable commissioning progress, for the HA bridge card. */
    get bridgeCommissionStatus(): string {
        return `${this.#prefix}/bridge/commission_status`;
    }

    /** Retained state of the HA commission-code text entity (cleared after each request). */
    get bridgeCommissionCode(): string {
        return `${this.#prefix}/bridge/commission_code`;
    }

    /** Retained state of the HA commission-mode select entity. */
    get bridgeCommissionMode(): string {
        return `${this.#prefix}/bridge/commission_mode`;
    }

    /** Retained state of the HA WiFi-SSID text entity (the stored/pending SSID). */
    get bridgeWifiSsid(): string {
        return `${this.#prefix}/bridge/wifi_ssid`;
    }

    /** Retained state of the HA WiFi-password text entity (masked, never the secret). */
    get bridgeWifiPassword(): string {
        return `${this.#prefix}/bridge/wifi_password`;
    }

    /** Retained state of the HA Thread-dataset text entity (masked, never the secret). */
    get bridgeThreadDataset(): string {
        return `${this.#prefix}/bridge/thread_dataset`;
    }

    /**
     * Parse an inbound command topic. Returns undefined for topics that are not
     * device commands (including anything under `bridge/`).
     */
    parseInbound(topic: string): InboundTopic | undefined {
        if (!topic.startsWith(`${this.#prefix}/`)) {
            return undefined;
        }
        const segments = topic.slice(this.#prefix.length + 1).split("/");
        const last = segments[segments.length - 1];
        const beforeLast = segments[segments.length - 2];

        let kind: "set" | "get";
        let attribute: string | undefined;
        let rest: string[];
        if (last === "set" || last === "get") {
            kind = last;
            rest = segments.slice(0, -1);
        } else if (beforeLast === "set" && last !== undefined && last !== "") {
            kind = "set";
            attribute = last;
            rest = segments.slice(0, -2);
        } else {
            return undefined;
        }

        const [device, endpointSegment] = rest;
        if (device === undefined || device === "" || device === "bridge") {
            return undefined;
        }
        if (rest.length === 1) {
            return { device, kind, attribute };
        }
        if (rest.length === 2 && endpointSegment !== undefined && /^\d+$/.test(endpointSegment)) {
            return { device, endpoint: parseInt(endpointSegment, 10), kind, attribute };
        }
        return undefined;
    }
}
