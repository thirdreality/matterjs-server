/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AttributesData, MatterSoftwareVersion } from "@matter-server/ws-controller";
import { BasicInformation, OtaSoftwareUpdateRequestor } from "@matter/main/clusters";

export const OTA_REQUESTOR_CLUSTER_ID = OtaSoftwareUpdateRequestor.Cluster.id;
export const BASIC_INFORMATION_CLUSTER_ID = BasicInformation.Cluster.id;

const UPDATE_STATE_ATTRIBUTE_ID = 2;
const UPDATE_STATE_PROGRESS_ATTRIBUTE_ID = 3;
const SOFTWARE_VERSION_ATTRIBUTE_ID = 9;
const SOFTWARE_VERSION_STRING_ATTRIBUTE_ID = 10;

/**
 * How long a requested update reports `updating` before the device's own UpdateState takes over.
 * Covers the announce -> device-starts-querying window so Home Assistant's install button does not
 * bounce back to "available" while the update is being picked up.
 */
const UPDATE_REQUEST_GRACE_MS = 15 * 60 * 1000;

/** zigbee2mqtt `update.state` values (`scheduled` has no Matter equivalent). */
export type OtaUpdateState = "idle" | "available" | "updating";

/** zigbee2mqtt-style `update` property of the published device state. */
export interface OtaUpdateProperty {
    state: OtaUpdateState;
    installed_version: number | null;
    /** Display version: SoftwareVersionString, or the numeric version when the string is missing. */
    installed_version_string: string | null;
    latest_version: number | null;
    latest_version_string: string | null;
    latest_source: string | null;
    latest_release_notes: string | null;
    /** Download progress in percent, only while the device is downloading. */
    progress?: number;
}

function numberOf(attributes: AttributesData, path: string): number | undefined {
    const value = attributes[path];
    return typeof value === "number" ? value : undefined;
}

function stringOf(attributes: AttributesData, path: string): string | undefined {
    const value = attributes[path];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** True when the node exposes the OTA Requestor cluster, i.e. it can be updated over Matter. */
export function supportsOta(attributes: AttributesData): boolean {
    return attributes[`0/${OTA_REQUESTOR_CLUSTER_ID}/${UPDATE_STATE_ATTRIBUTE_ID}`] !== undefined;
}

/**
 * Tracks the OTA bookkeeping the controller does not keep for us: the last check result per device
 * (the controller caches it internally but does not expose it), a per-device in-flight guard
 * (zigbee2mqtt's `#inProgress`), and the grace window described at {@link UPDATE_REQUEST_GRACE_MS}.
 */
export class OtaTracker {
    readonly #available = new Map<string, MatterSoftwareVersion>();
    readonly #inProgress = new Set<string>();
    readonly #requestedAt = new Map<string, number>();

    availableUpdate(device: string): MatterSoftwareVersion | undefined {
        return this.#available.get(device);
    }

    setAvailableUpdate(device: string, update: MatterSoftwareVersion | null): void {
        if (update === null) {
            this.#available.delete(device);
        } else {
            this.#available.set(device, update);
        }
    }

    /** Claim the device for a check/update operation; false when one is already running. */
    begin(device: string): boolean {
        if (this.#inProgress.has(device)) {
            return false;
        }
        this.#inProgress.add(device);
        return true;
    }

    end(device: string): void {
        this.#inProgress.delete(device);
    }

    markUpdateRequested(device: string): void {
        this.#requestedAt.set(device, Date.now());
    }

    forget(device: string): void {
        this.#available.delete(device);
        this.#inProgress.delete(device);
        this.#requestedAt.delete(device);
    }

    /**
     * Build the zigbee2mqtt-style `update` property, or undefined for nodes without the OTA
     * Requestor cluster. State comes from the device's own UpdateState attribute; the version and
     * source of an available update come from the last check.
     */
    updateStateOf(device: string, attributes: AttributesData, now = Date.now()): OtaUpdateProperty | undefined {
        if (!supportsOta(attributes)) {
            return undefined;
        }

        const installedVersion = numberOf(
            attributes,
            `0/${BASIC_INFORMATION_CLUSTER_ID}/${SOFTWARE_VERSION_ATTRIBUTE_ID}`,
        );
        const installedVersionString = stringOf(
            attributes,
            `0/${BASIC_INFORMATION_CLUSTER_ID}/${SOFTWARE_VERSION_STRING_ATTRIBUTE_ID}`,
        );
        const updateState = numberOf(attributes, `0/${OTA_REQUESTOR_CLUSTER_ID}/${UPDATE_STATE_ATTRIBUTE_ID}`);
        const available = this.#available.get(device);

        // An update we already installed is no longer "available"
        const pending =
            available !== undefined && (installedVersion === undefined || available.software_version > installedVersion)
                ? available
                : undefined;

        const requestedAt = this.#requestedAt.get(device);
        const deviceBusy =
            updateState !== undefined &&
            updateState !== OtaSoftwareUpdateRequestor.UpdateState.Unknown &&
            updateState !== OtaSoftwareUpdateRequestor.UpdateState.Idle;
        const requestPending = requestedAt !== undefined && now - requestedAt < UPDATE_REQUEST_GRACE_MS;
        if (deviceBusy || (!requestPending && requestedAt !== undefined)) {
            // The device's own state is authoritative from here on
            this.#requestedAt.delete(device);
        }

        const state: OtaUpdateState =
            deviceBusy || requestPending ? "updating" : pending !== undefined ? "available" : "idle";

        const property: OtaUpdateProperty = {
            state,
            installed_version: installedVersion ?? null,
            installed_version_string: installedVersionString ?? installedVersion?.toString() ?? null,
            // zigbee2mqtt parity: without a pending update the latest version is the installed one,
            // which is what tells Home Assistant the device is up to date
            latest_version: pending?.software_version ?? installedVersion ?? null,
            latest_version_string:
                pending?.software_version_string ??
                pending?.software_version.toString() ??
                installedVersionString ??
                installedVersion?.toString() ??
                null,
            latest_source: pending?.update_source ?? null,
            latest_release_notes: pending?.release_notes_url ?? null,
        };

        const progress = numberOf(attributes, `0/${OTA_REQUESTOR_CLUSTER_ID}/${UPDATE_STATE_PROGRESS_ATTRIBUTE_ID}`);
        if (state === "updating" && progress !== undefined) {
            property.progress = progress;
        }
        return property;
    }
}
