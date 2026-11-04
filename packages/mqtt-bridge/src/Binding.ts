/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AccessControlEntry, AttributesData, BindingTarget } from "@matter-server/ws-controller";

export const BINDING_CLUSTER_ID = 30;
export const ACCESS_CONTROL_CLUSTER_ID = 31;
const DESCRIPTOR = 29;
const SERVER_LIST = 1;
const CLIENT_LIST = 2;

export const PRIVILEGE_OPERATE = 3;
export const PRIVILEGE_ADMINISTER = 5;
export const AUTH_MODE_CASE = 2;

/** Clusters a controller like a switch binds to, by Matter name, with zigbee2mqtt's names as aliases. */
const BINDABLE_CLUSTERS: Readonly<Record<string, number>> = {
    OnOff: 6,
    LevelControl: 8,
    ColorControl: 768,
    WindowCovering: 258,
    DoorLock: 257,
    Thermostat: 513,
    FanControl: 514,
};
const ZIGBEE2MQTT_NAMES: Readonly<Record<string, string>> = {
    genOnOff: "OnOff",
    genLevelCtrl: "LevelControl",
    lightingColorCtrl: "ColorControl",
    closuresWindowCovering: "WindowCovering",
    closuresDoorLock: "DoorLock",
    hvacThermostat: "Thermostat",
    hvacFanCtrl: "FanControl",
};

/** A cluster id from a number or a Matter or zigbee2mqtt cluster name. */
export function clusterIdOf(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        return value;
    }
    if (typeof value !== "string") {
        return undefined;
    }
    return BINDABLE_CLUSTERS[ZIGBEE2MQTT_NAMES[value] ?? value] ?? (/^\d+$/.test(value) ? Number(value) : undefined);
}

export function clusterNameOf(id: number): string {
    return Object.entries(BINDABLE_CLUSTERS).find(([, cluster]) => cluster === id)?.[0] ?? String(id);
}

function listAt(attributes: AttributesData, endpoint: number, attribute: number): number[] {
    const value = attributes[`${endpoint}/${DESCRIPTOR}/${attribute}`];
    return Array.isArray(value) ? value.filter((id): id is number => typeof id === "number") : [];
}

/** Endpoints, in order, that have the Binding cluster: where a controller keeps its bindings. */
export function bindingEndpointsOf(attributes: AttributesData): number[] {
    const endpoints = new Set<number>();
    for (const path of Object.keys(attributes)) {
        const [endpoint, cluster, attribute] = path.split("/").map(Number);
        if (cluster === BINDING_CLUSTER_ID && attribute === 0 && endpoint !== undefined) {
            endpoints.add(endpoint);
        }
    }
    return [...endpoints].sort((a, b) => a - b);
}

/** The clusters a source endpoint can control on a target endpoint: its client clusters the target serves. */
export function bindableClustersOf(
    source: AttributesData,
    sourceEndpoint: number,
    target: AttributesData,
    targetEndpoint: number,
): number[] {
    const served = new Set(listAt(target, targetEndpoint, SERVER_LIST));
    const bindable = new Set(Object.values(BINDABLE_CLUSTERS));
    return listAt(source, sourceEndpoint, CLIENT_LIST).filter(cluster => bindable.has(cluster) && served.has(cluster));
}

/** The first endpoint of the target that serves all the clusters. */
export function targetEndpointOf(target: AttributesData, clusters: number[]): number | undefined {
    const endpoints = new Set<number>();
    for (const path of Object.keys(target)) {
        const [endpoint, cluster, attribute] = path.split("/").map(Number);
        if (cluster === DESCRIPTOR && attribute === SERVER_LIST && endpoint !== undefined) {
            endpoints.add(endpoint);
        }
    }
    return [...endpoints]
        .sort((a, b) => a - b)
        .find(endpoint => {
            const served = listAt(target, endpoint, SERVER_LIST);
            return clusters.length > 0 && clusters.every(cluster => served.includes(cluster));
        });
}

/** A struct field from the attribute cache, which keys structs by TLV tag or by field name. */
function field(value: unknown, tag: number, ...names: string[]): unknown {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    for (const name of [String(tag), ...names]) {
        if (record[name] !== undefined) {
            return record[name];
        }
    }
    return undefined;
}

function nullableNumber(value: unknown): number | null {
    return typeof value === "number" ? value : null;
}

function nodeIdValue(value: unknown): number | bigint | null {
    return typeof value === "number" || typeof value === "bigint" ? value : null;
}

/** Our fabric's ACL entries from the cached AccessControl ACL attribute, or undefined when it is not known. */
export function aclEntriesOf(value: unknown): AccessControlEntry[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    return value.map(entry => {
        const subjects = field(entry, 3, "subjects");
        const targets = field(entry, 4, "targets");
        return {
            privilege: Number(field(entry, 1, "privilege")),
            auth_mode: Number(field(entry, 2, "authMode", "auth_mode")),
            subjects: Array.isArray(subjects)
                ? subjects.map(nodeIdValue).filter((subject): subject is number | bigint => subject !== null)
                : null,
            targets: Array.isArray(targets)
                ? targets.map(target => ({
                      cluster: nullableNumber(field(target, 0, "cluster")),
                      endpoint: nullableNumber(field(target, 1, "endpoint")),
                      device_type: nullableNumber(field(target, 2, "deviceType", "device_type")),
                  }))
                : null,
        };
    });
}

/** Our fabric's binding targets from a cached Binding attribute, or undefined when it is not known. */
export function bindingTargetsOf(value: unknown): BindingTarget[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    return value.map(target => ({
        node: nodeIdValue(field(target, 1, "node")),
        group: nullableNumber(field(target, 2, "group")),
        endpoint: nullableNumber(field(target, 3, "endpoint")),
        cluster: nullableNumber(field(target, 4, "cluster")),
    }));
}

export interface BindingRequest {
    node: bigint;
    endpoint: number;
    clusters: number[];
}

function sameNode(a: number | bigint | null, b: bigint): boolean {
    return a !== null && BigInt(a) === b;
}

function isTarget(target: BindingTarget, request: BindingRequest, cluster: number): boolean {
    return sameNode(target.node, request.node) && target.endpoint === request.endpoint && target.cluster === cluster;
}

/** The binding list with the request's targets added; existing targets are kept and not duplicated. */
export function withBinding(targets: BindingTarget[], request: BindingRequest): BindingTarget[] {
    const added = request.clusters
        .filter(cluster => !targets.some(target => isTarget(target, request, cluster)))
        .map(cluster => ({ node: request.node, group: null, endpoint: request.endpoint, cluster }));
    return [...targets, ...added];
}

export function withoutBinding(targets: BindingTarget[], request: BindingRequest): BindingTarget[] {
    return targets.filter(target => !request.clusters.some(cluster => isTarget(target, request, cluster)));
}

function grants(entry: AccessControlEntry, subject: bigint, endpoint: number, cluster: number): boolean {
    if (entry.privilege < PRIVILEGE_OPERATE || entry.auth_mode !== AUTH_MODE_CASE) {
        return false;
    }
    if (entry.subjects !== null && !entry.subjects.some(candidate => sameNode(candidate, subject))) {
        return false;
    }
    return (
        entry.targets === null ||
        entry.targets.some(
            target =>
                target.device_type === null &&
                (target.cluster === null || target.cluster === cluster) &&
                (target.endpoint === null || target.endpoint === endpoint),
        )
    );
}

/**
 * The ACL with an Operate entry letting `request.node` (the binding's source) reach the clusters on the
 * target endpoint, for whatever the existing entries do not grant already. Existing entries are kept as
 * they are: the list is written whole, and losing the controller's own entry would lock it out.
 */
export function withAccess(entries: AccessControlEntry[], request: BindingRequest): AccessControlEntry[] {
    const missing = request.clusters.filter(
        cluster => !entries.some(entry => grants(entry, request.node, request.endpoint, cluster)),
    );
    if (missing.length === 0) {
        return entries;
    }
    return [
        ...entries,
        {
            privilege: PRIVILEGE_OPERATE,
            auth_mode: AUTH_MODE_CASE,
            subjects: [request.node],
            targets: missing.map(cluster => ({ cluster, endpoint: request.endpoint, device_type: null })),
        },
    ];
}

/**
 * The ACL without the request's clusters in entries shaped like the ones {@link withAccess} adds (Operate,
 * CASE, the source as only subject); anything else is left alone, as another tool may rely on it.
 */
export function withoutAccess(entries: AccessControlEntry[], request: BindingRequest): AccessControlEntry[] {
    return entries.flatMap(entry => {
        const ours =
            entry.privilege === PRIVILEGE_OPERATE &&
            entry.auth_mode === AUTH_MODE_CASE &&
            entry.subjects?.length === 1 &&
            sameNode(entry.subjects[0], request.node) &&
            entry.targets !== null;
        if (!ours || entry.targets === null) {
            return [entry];
        }
        const targets = entry.targets.filter(
            target => !(target.endpoint === request.endpoint && request.clusters.includes(target.cluster ?? -1)),
        );
        if (targets.length === entry.targets.length) {
            return [entry];
        }
        return targets.length === 0 ? [] : [{ ...entry, targets }];
    });
}

export function hasAdministrator(entries: AccessControlEntry[]): boolean {
    return entries.some(entry => entry.privilege === PRIVILEGE_ADMINISTER && entry.auth_mode === AUTH_MODE_CASE);
}
