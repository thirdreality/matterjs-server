/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DiscoveryMessage } from "./Discovery.js";
import { readJsonFile, writeJsonFile } from "./JsonFile.js";
import type { LightCapabilities } from "./LightCapabilities.js";
import { DISCOVERY_PREFIX, type Topics } from "./Topics.js";

/** One endpoint of one device in a group. */
export interface GroupMember {
    device: string;
    endpoint: number;
}

/**
 * A zigbee2mqtt-style group. The bridge sends a group command to each member in turn (a software group);
 * no Matter group is set up on the devices.
 */
export interface Group {
    id: number;
    friendly_name: string;
    members: GroupMember[];
}

/** Why a group name cannot be used, or undefined: it becomes a topic segment next to the device keys. */
export function groupNameProblemOf(name: unknown): string | undefined {
    if (typeof name !== "string" || name.trim().length === 0) {
        return "a group needs a non-empty friendly_name";
    }
    if (/[/+#]/.test(name)) {
        return 'a group name cannot contain "/", "+" or "#"';
    }
    if (name === "bridge" || /^\d+(_\d+)?$/.test(name)) {
        return `"${name}" is reserved for the bridge or a device`;
    }
    return undefined;
}

/** The groups, kept in a JSON file next to the server's storage (in memory without a path). */
export class GroupStore {
    readonly #path?: string;
    #groups: Group[] = [];

    constructor(path?: string) {
        this.#path = path;
    }

    async load(): Promise<void> {
        if (this.#path === undefined) {
            return;
        }
        const stored = await readJsonFile(this.#path);
        if (Array.isArray(stored)) {
            this.#groups = stored as Group[];
        }
    }

    list(): readonly Group[] {
        return this.#groups;
    }

    /** A group by friendly name, or by id given as a number or a numeric string. */
    find(nameOrId: unknown): Group | undefined {
        return this.#groups.find(
            group => group.friendly_name === nameOrId || (nameOrId !== "" && String(group.id) === String(nameOrId)),
        );
    }

    async add(name: unknown, id?: unknown): Promise<Group> {
        const problem = groupNameProblemOf(name);
        if (problem !== undefined) {
            throw new Error(problem);
        }
        if (this.find(name) !== undefined) {
            throw new Error(`a group named "${String(name)}" exists already`);
        }
        let groupId: number;
        if (id === undefined || id === null) {
            groupId = 1;
            while (this.#groups.some(group => group.id === groupId)) {
                groupId++;
            }
        } else {
            groupId = Number(id);
            if (!Number.isInteger(groupId) || groupId < 1 || groupId > 0xfff7) {
                throw new Error(`invalid group id ${JSON.stringify(id)}: expected 1-65527`);
            }
            if (this.#groups.some(group => group.id === groupId)) {
                throw new Error(`group id ${groupId} is taken`);
            }
        }
        const group: Group = { id: groupId, friendly_name: String(name), members: [] };
        this.#groups.push(group);
        await this.#save();
        return group;
    }

    async remove(group: Group): Promise<void> {
        this.#groups = this.#groups.filter(candidate => candidate !== group);
        await this.#save();
    }

    async rename(group: Group, to: unknown): Promise<void> {
        const problem = groupNameProblemOf(to);
        if (problem !== undefined) {
            throw new Error(problem);
        }
        const other = this.find(to);
        if (other !== undefined && other !== group) {
            throw new Error(`a group named "${String(to)}" exists already`);
        }
        group.friendly_name = String(to);
        await this.#save();
    }

    async addMember(group: Group, member: GroupMember): Promise<void> {
        if (
            !group.members.some(existing => existing.device === member.device && existing.endpoint === member.endpoint)
        ) {
            group.members.push(member);
            await this.#save();
        }
    }

    /** Remove a member; without an endpoint, every endpoint of the device. */
    async removeMember(group: Group, device: string, endpoint?: number): Promise<boolean> {
        const before = group.members.length;
        group.members = group.members.filter(
            member => member.device !== device || (endpoint !== undefined && member.endpoint !== endpoint),
        );
        if (group.members.length === before) {
            return false;
        }
        await this.#save();
        return true;
    }

    /** Remove the device from every group; returns the groups it was in. */
    async removeDevice(device: string): Promise<Group[]> {
        const changed = this.#groups.filter(group => group.members.some(member => member.device === device));
        for (const group of changed) {
            group.members = group.members.filter(member => member.device !== device);
        }
        if (changed.length > 0) {
            await this.#save();
        }
        return changed;
    }

    async #save(): Promise<void> {
        if (this.#path !== undefined) {
            await writeJsonFile(this.#path, this.#groups);
        }
    }
}

/**
 * The group's state from its members' endpoint states, as zigbee2mqtt shows a group: `ON` while any member
 * is on; every other property from the first member that has it.
 */
export function groupStateOf(memberStates: Record<string, unknown>[]): Record<string, unknown> {
    const state: Record<string, unknown> = {};
    for (const member of memberStates) {
        for (const [key, value] of Object.entries(member)) {
            if (!(key in state)) {
                state[key] = value;
            }
        }
    }
    const switching = memberStates.map(member => member.state).filter(value => value === "ON" || value === "OFF");
    if (switching.length > 0) {
        state.state = switching.includes("ON") ? "ON" : "OFF";
    }
    return state;
}

/**
 * Home Assistant discovery for a group: a JSON light when every member is a dimmable light (with the color
 * modes and mireds range all members share), a switch when every member switches, else nothing.
 */
export function groupDiscoveryOf(
    group: Group,
    memberCaps: LightCapabilities[],
    topics: Topics,
    serverVersion?: string,
): DiscoveryMessage | undefined {
    if (memberCaps.length === 0 || !memberCaps.every(caps => caps.onOff)) {
        return undefined;
    }
    const uid = `matter2mqtt_group_${group.id}`;
    const common = {
        name: null,
        unique_id: uid,
        state_topic: topics.deviceState(group.friendly_name),
        command_topic: `${topics.deviceState(group.friendly_name)}/set`,
        availability: [{ topic: topics.bridgeState, value_template: "{{ value_json.state }}" }],
        device: {
            identifiers: [uid],
            name: group.friendly_name,
            manufacturer: "matter2mqtt",
            model: "Group",
            via_device: "matter2mqtt_bridge",
        },
        origin: { name: "matter2mqtt", sw_version: serverVersion },
    };
    if (memberCaps.every(caps => caps.brightness)) {
        const modes = [
            ["hs", (caps: LightCapabilities) => caps.hueSaturation],
            ["xy", (caps: LightCapabilities) => caps.xy],
            ["color_temp", (caps: LightCapabilities) => caps.colorTemp],
        ] as const;
        const colorModes = modes.filter(([, has]) => memberCaps.every(has)).map(([mode]) => mode);
        const colorTemp = colorModes.includes("color_temp");
        return {
            topic: `${DISCOVERY_PREFIX}/light/${uid}/light/config`,
            payload: JSON.stringify({
                ...common,
                schema: "json",
                brightness: true,
                brightness_scale: 254,
                ...(colorModes.length > 0 ? { supported_color_modes: colorModes } : {}),
                ...(colorTemp
                    ? {
                          min_mireds: Math.max(...memberCaps.map(caps => caps.colorTempMinMireds ?? 153)),
                          max_mireds: Math.min(...memberCaps.map(caps => caps.colorTempMaxMireds ?? 500)),
                      }
                    : {}),
            }),
        };
    }
    return {
        topic: `${DISCOVERY_PREFIX}/switch/${uid}/switch/config`,
        payload: JSON.stringify({
            ...common,
            value_template: "{{ value_json.state }}",
            payload_on: '{"state":"ON"}',
            payload_off: '{"state":"OFF"}',
            state_on: "ON",
            state_off: "OFF",
        }),
    };
}
