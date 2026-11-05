/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    ConfigStorage,
    decodeOnboardingPayload,
    registerThreadCredentialsFromHex,
    ServerError,
    type AttributesData,
    type ControllerCommandHandler,
    type MatterController,
} from "@matter-server/ws-controller";
import { Logger, MatterError, NodeId, Seconds, type Duration } from "@matter/main";
import { AttributeId, ClusterId, EndpointNumber } from "@matter/main/types";
import { freemem, loadavg, totalmem } from "node:os";
import {
    aclEntriesOf,
    ACCESS_CONTROL_CLUSTER_ID,
    BINDING_CLUSTER_ID,
    bindableClustersOf,
    bindingEndpointsOf,
    bindingTargetsOf,
    clusterIdOf,
    clusterNameOf,
    hasAdministrator,
    targetEndpointOf,
    withAccess,
    withBinding,
    withoutAccess,
    withoutBinding,
    type BindingRequest,
} from "./Binding.js";
import type { Group } from "./Groups.js";
import { graphvizNetworkMapOf, rawNetworkMapOf } from "./NetworkMap.js";
import type { OtaTracker } from "./OtaState.js";

const logger = Logger.get("BridgeCommands");

/** Maximum commissioning attempts when the chosen node id collides on the fabric. */
const MAX_COMMISSION_NODE_ID_ATTEMPTS = 5;

/** Same bound as the WebSocket API's `discovery_timeout_s`. */
const MAX_DISCOVERY_TIMEOUT_S = 48 * 60 * 60;

/** Commands whose single value may arrive as a bare (non-JSON) payload, e.g. from HA text entities. */
const BARE_PAYLOAD_KEYS: Record<string, string> = {
    commission: "code",
    parse_onboarding_payload: "code",
    networkmap: "type",
    "group/add": "friendly_name",
    "group/remove": "id",
    commission_mode: "mode",
    wifi_ssid: "ssid",
    wifi_password: "password",
    thread_dataset: "dataset",
};

/**
 * Options of the HA commission-mode select, mapped onto commission parameters.
 * The network type auto-negotiates via the NetworkCommissioning cluster, so Auto
 * (offer all stored credentials) covers the common case.
 */
const COMMISSION_MODES: Record<string, { network?: "wifi" | "thread"; networkOnly?: boolean }> = {
    Auto: {},
    WiFi: { network: "wifi" },
    Thread: { network: "thread" },
    "Existing (IP)": { networkOnly: true },
};

export const COMMISSION_MODE_NAMES: readonly string[] = Object.keys(COMMISSION_MODES);
export const DEFAULT_COMMISSION_MODE = "Auto";

export interface BridgeCommandContext {
    commandHandler: ControllerCommandHandler;
    config: ConfigStorage;
    controller: MatterController;
    /** Half-entered WiFi credentials from the single-value HA text entities. */
    wifiInput?: { ssid?: string; password?: string };
    /** Selected HA commission mode; applies when a commission request carries only a code. */
    commissionMode?: string;
    /** OTA bookkeeping shared with the state publisher. */
    ota?: OtaTracker;
    /** Resolves a `<device>` topic segment, which for a device behind a Matter bridge is not a node id. */
    resolveDevice?: (device: string) => ResolvedDevice | undefined;
    /** Applies and persists a `device/options` update, answering with the options before and after. */
    updateDeviceOptions?: (device: string, update: unknown) => Promise<{ from: unknown; to: unknown }>;
    /** The bridge's software groups; groups and members are given by name or id. */
    groups?: GroupOperations;
}

export interface GroupOperations {
    add(name: unknown, id: unknown): Promise<Group>;
    remove(nameOrId: unknown): Promise<Group>;
    rename(from: unknown, to: unknown): Promise<Group>;
    addMember(group: unknown, device: string, endpoint?: number): Promise<{ group: Group; endpoint: number }>;
    removeMember(group: unknown, device: string, endpoint?: number): Promise<Group>;
    removeDevice(device: string): Promise<Group[]>;
}

export interface ResolvedDevice {
    nodeId: NodeId;
    /** The device's own attributes (for a bridged device, its endpoints only). */
    attributes: AttributesData;
    /** All attributes of the node, including its root endpoint. */
    nodeAttributes: AttributesData;
}

export interface BridgeCommandResponse {
    status: "ok" | "error";
    data?: unknown;
    error?: string;
    /** Machine-readable failure cause, e.g. `passcode-mismatch` for a failed commission. */
    reason?: string;
    transaction?: unknown;
}

type CommandHandlerFn = (args: Record<string, unknown>, ctx: BridgeCommandContext) => Promise<unknown>;

/**
 * zigbee2mqtt-style bridge command set: `<prefix>/bridge/request/<command>` with a JSON
 * payload answers on `<prefix>/bridge/response/<command>` with `{status, data, error?}`;
 * a `transaction` property is echoed back for request/response matching.
 */
const COMMANDS: Record<string, CommandHandlerFn> = {
    /** Store the WiFi credentials used for BLE commissioning. */
    wifi_credentials: async ({ ssid, credentials }, { config }) => {
        if (typeof ssid !== "string" || ssid.length === 0 || typeof credentials !== "string") {
            throw new Error('expected {"ssid": "...", "credentials": "..."}');
        }
        await config.setWifiCredentials(ConfigStorage.DEFAULT_CREDENTIAL_ID, ssid, credentials);
        return { ssid };
    },

    /** Select how a bare-code commission request is routed (the HA select entity). */
    commission_mode: async ({ mode }, ctx) => {
        if (typeof mode !== "string" || COMMISSION_MODES[mode] === undefined) {
            throw new Error(`"mode" must be one of: ${COMMISSION_MODE_NAMES.join(", ")}`);
        }
        ctx.commissionMode = mode;
        return { mode };
    },

    /** Set the WiFi SSID half; persisted once the password half is known too. */
    wifi_ssid: async ({ ssid }, ctx) => {
        if (typeof ssid !== "string" || ssid.length === 0) {
            throw new Error('expected {"ssid": "..."}');
        }
        return await updateWifiInput(ctx, { ssid });
    },

    /** Set the WiFi password half; persisted once the SSID half is known too. */
    wifi_password: async ({ password }, ctx) => {
        if (typeof password !== "string" || password.length === 0) {
            throw new Error('expected {"password": "..."}');
        }
        return await updateWifiInput(ctx, { password });
    },

    /** Store the Thread operational dataset (hex TLV) used for BLE commissioning. */
    thread_dataset: async ({ dataset }, { config, controller }) => {
        if (typeof dataset !== "string" || dataset.length === 0) {
            throw new Error('expected {"dataset": "<hex TLV>"}');
        }
        await config.setThreadCredentials(ConfigStorage.DEFAULT_CREDENTIAL_ID, dataset);
        registerThreadCredentialsFromHex(
            controller.credentials,
            dataset,
            `mqtt:thread_dataset:${ConfigStorage.DEFAULT_CREDENTIAL_ID}`,
        );
        return {};
    },

    /**
     * Commission a device by pairing code. Mirrors the WebSocket commission_with_code
     * orchestration: stored credentials for BLE devices, node id allocation with
     * identity-conflict retry. `network_only: true` commissions over IP only
     * ("add existing device"); `network: "wifi" | "thread"` restricts to one
     * credential type and fails early when it is not stored yet.
     */
    commission: async (args, ctx) => {
        const code = args.code;
        if (typeof code !== "string" || code.length === 0) {
            throw new Error('expected {"code": "<QR or manual pairing code>"}');
        }
        let network = args.network;
        let networkOnly = args.network_only === true;
        if (args.network === undefined && args.network_only === undefined) {
            // Bare code (the HA text entity): apply the card's selected commission mode
            const mode = COMMISSION_MODES[ctx.commissionMode ?? DEFAULT_COMMISSION_MODE];
            network = mode?.network;
            networkOnly = mode?.networkOnly === true;
        }
        if (network !== undefined && network !== "wifi" && network !== "thread") {
            throw new Error('"network" must be "wifi" or "thread"');
        }
        const discoveryTimeout = discoveryTimeoutOf(args.discovery_timeout_s);
        const { commandHandler, config, controller } = ctx;
        const isQrCode = code.startsWith("MT:");

        let wifiCredentials;
        let threadCredentials;
        if (!networkOnly && commandHandler.bleEnabled) {
            // Only apply stored credentials whose values are actually present
            const wifiEntry = config.getWifiCredentials(ConfigStorage.DEFAULT_CREDENTIAL_ID);
            const threadEntry = config.getThreadCredentials(ConfigStorage.DEFAULT_CREDENTIAL_ID);
            if (network !== "thread" && wifiEntry?.ssid && wifiEntry.credentials) {
                wifiCredentials = { wifiSsid: wifiEntry.ssid, wifiCredentials: wifiEntry.credentials };
            }
            if (network !== "wifi" && threadEntry?.dataset) {
                threadCredentials = { networkName: "", operationalDataset: threadEntry.dataset };
            }
            if (network === "wifi" && wifiCredentials === undefined) {
                throw new Error("no WiFi credentials stored; set WiFi SSID and password first");
            }
            if (network === "thread" && threadCredentials === undefined) {
                throw new Error("no Thread dataset stored; set it first");
            }
        }

        // Ensure certificates are loaded before attestation
        await controller.certificateService();

        let lastError: unknown;
        for (let attempt = 1; attempt <= MAX_COMMISSION_NODE_ID_ATTEMPTS; attempt++) {
            const nodeId = NodeId(await config.allocateNodeId(id => commandHandler.isNodeIdInUse(NodeId(id))));
            try {
                const { nodeId: committed } = await commandHandler.commissionNode({
                    nodeId,
                    onNetworkOnly: networkOnly,
                    discoveryTimeout,
                    ...(isQrCode ? { qrCode: code } : { manualCode: code }),
                    wifiCredentials,
                    threadCredentials,
                });
                return { node_id: Number(committed) };
            } catch (error) {
                if (!isIdentityConflict(error)) {
                    throw error;
                }
                lastError = error;
                logger.warn(
                    `Node id ${nodeId} conflicts with an existing node on the fabric ` +
                        `(attempt ${attempt}/${MAX_COMMISSION_NODE_ID_ATTEMPTS}), retrying with the next id`,
                );
            }
        }
        const reason = lastError instanceof Error ? `: ${lastError.message}` : "";
        throw new Error(`could not find a free node id after ${MAX_COMMISSION_NODE_ID_ATTEMPTS} attempts${reason}`);
    },

    /**
     * zigbee2mqtt `health_check`: answering at all means the bridge and its broker connection work; the
     * data adds what zigbee2mqtt reports about the process and the devices.
     */
    health_check: async (_args, { commandHandler }) => {
        const memory = process.memoryUsage();
        return {
            healthy: true,
            process: {
                uptime_sec: Math.round(process.uptime()),
                memory_usage_mb: Math.round((memory.rss / 1024 / 1024) * 100) / 100,
            },
            os: {
                load_average: loadavg(),
                memory_percent: Math.round((1 - freemem() / totalmem()) * 10000) / 100,
            },
            devices: { count: commandHandler.getNodeIds().length },
        };
    },

    /**
     * zigbee2mqtt `networkmap` (`raw` or `graphviz`) from the controller's Thread / Wi-Fi topology. Reads the
     * nodes' neighbor tables first, as zigbee2mqtt scans, unless `refresh` is false.
     */
    networkmap: async (args, { controller }) => {
        const type = args.type ?? "raw";
        if (type !== "raw" && type !== "graphviz") {
            throw new Error(`"type" must be "raw" or "graphviz"`);
        }
        const routes = args.routes === true;
        const topology =
            args.refresh === false
                ? controller.networkTopology.getTopology()
                : await controller.networkTopology.refresh();
        return {
            type,
            routes,
            value: type === "raw" ? rawNetworkMapOf(topology, routes) : graphvizNetworkMapOf(topology, routes),
        };
    },

    /** Restart the server process; systemd's Restart policy brings it back up. */
    restart: async () => {
        logger.notice("Restart requested via MQTT bridge command");
        // Give the response publish a moment to reach the broker
        setTimeout(() => process.exit(1), 500);
        return {};
    },

    "device/remove": async (args, { commandHandler }) => {
        await commandHandler.removeNode(nodeIdOf(args));
        return { id: args.id };
    },

    "device/interview": async (args, { commandHandler }) => {
        await commandHandler.interviewNode(nodeIdOf(args));
        return { id: args.id };
    },

    /** Write the BasicInformation nodeLabel (0/40/5). */
    "device/rename": async (args, { commandHandler }) => {
        const name = args.name;
        if (typeof name !== "string") {
            throw new Error('expected {"id": <node id>, "name": "..."}');
        }
        await commandHandler.handleWriteAttribute({
            nodeId: nodeIdOf(args),
            endpointId: EndpointNumber(0),
            clusterId: ClusterId(40),
            attributeId: AttributeId(5),
            value: name,
        });
        return { id: args.id, name };
    },

    /**
     * Open a commissioning window (multi-admin share). Besides the pairing codes, the answer carries
     * what another ecosystem needs without decoding the QR code. `timeout` is in seconds.
     */
    /**
     * zigbee2mqtt `device/bind`: let a controller (`from`, e.g. a switch) command a device (`to`) directly.
     * Writes the source's Binding and, across nodes, an ACL entry on the target granting the source Operate.
     */
    "device/bind": async (args, ctx) => {
        const plan = bindingPlanOf(args, ctx);
        const { commandHandler } = ctx;
        const access = plan.acl === undefined ? undefined : withAccess(plan.acl, plan.request.access);
        if (access !== undefined && access !== plan.acl) {
            await writeChecked(commandHandler.setAclEntry(plan.to.nodeId, access), "target ACL");
        }
        await writeChecked(
            commandHandler.setNodeBinding(
                plan.from.nodeId,
                EndpointNumber(plan.fromEndpoint),
                withBinding(plan.bindings, plan.request.binding),
            ),
            "source binding",
        );
        return plan.response;
    },

    /** zigbee2mqtt `device/unbind`: remove the binding, then the ACL entry `device/bind` added for it. */
    "device/unbind": async (args, ctx) => {
        const plan = bindingPlanOf(args, ctx);
        const { commandHandler } = ctx;
        await writeChecked(
            commandHandler.setNodeBinding(
                plan.from.nodeId,
                EndpointNumber(plan.fromEndpoint),
                withoutBinding(plan.bindings, plan.request.binding),
            ),
            "source binding",
        );
        if (plan.acl !== undefined) {
            const next = withoutAccess(plan.acl, plan.request.access);
            if (next.length !== plan.acl.length || next.some((entry, index) => entry !== plan.acl?.[index])) {
                await writeChecked(commandHandler.setAclEntry(plan.to.nodeId, next), "target ACL");
            }
        }
        return plan.response;
    },

    /** zigbee2mqtt `device/options`: bridge-side settings of one device; `null` removes an option. */
    "device/options": async (args, ctx) => {
        const device = args.id;
        if (typeof device !== "string" && typeof device !== "number") {
            throw new Error('expected {"id": <device>, "options": {...}}');
        }
        if (ctx.updateDeviceOptions === undefined) {
            throw new Error("device options are not available");
        }
        const { from, to } = await ctx.updateDeviceOptions(String(device), args.options);
        return { id: String(device), from, to, restart_required: false };
    },

    /** zigbee2mqtt `group/add`: a new (software) group; the id is chosen when none is given. */
    "group/add": async (args, ctx) => {
        const group = await groupsOf(ctx).add(args.friendly_name, args.id);
        return { friendly_name: group.friendly_name, id: group.id };
    },

    "group/remove": async (args, ctx) => {
        const group = await groupsOf(ctx).remove(args.id);
        return { id: group.id, friendly_name: group.friendly_name };
    },

    "group/rename": async (args, ctx) => {
        const from = await groupsOf(ctx).rename(args.from, args.to);
        return { from: args.from, to: from.friendly_name };
    },

    /** zigbee2mqtt `group/members/add`: `endpoint` defaults to the device's first controllable one. */
    "group/members/add": async (args, ctx) => {
        const { group, endpoint } = await groupsOf(ctx).addMember(
            args.group,
            deviceArg(args),
            endpointArg(args.endpoint),
        );
        return { group: group.friendly_name, device: deviceArg(args), endpoint };
    },

    /** zigbee2mqtt `group/members/remove`: without `endpoint`, every endpoint of the device. */
    "group/members/remove": async (args, ctx) => {
        const endpoint = endpointArg(args.endpoint);
        const group = await groupsOf(ctx).removeMember(args.group, deviceArg(args), endpoint);
        return { group: group.friendly_name, device: deviceArg(args), ...(endpoint === undefined ? {} : { endpoint }) };
    },

    "group/members/remove_all": async (args, ctx) => {
        const groups = await groupsOf(ctx).removeDevice(deviceArg(args));
        return { device: deviceArg(args), groups: groups.map(group => group.friendly_name) };
    },

    "device/share": async (args, { commandHandler }) => {
        const timeout = positiveNumberOf(args.timeout, "timeout");
        const window = await commandHandler.openCommissioningWindow({ nodeId: nodeIdOf(args), timeout });
        return {
            id: args.id,
            manual_code: window.manualCode,
            qr_code: window.qrCode,
            setup_pin_code: window.passcode,
            discriminator: window.discriminator,
            vendor_id: window.vendorId,
            product_id: window.productId,
            commissioning_timeout: window.commissioningTimeout,
        };
    },

    /** Decode a QR or manual pairing code without contacting a device (WebSocket `parse_onboarding_payload`). */
    parse_onboarding_payload: async ({ code }) => {
        if (typeof code !== "string" || code.length === 0) {
            throw new Error('expected {"code": "<QR or manual pairing code>"}');
        }
        const decoded = decodeOnboardingPayload(code);
        if (decoded.type === "manual") {
            const { shortDiscriminator, passcode, vendorId, productId } = decoded.payload;
            return {
                type: "manual",
                short_discriminator: shortDiscriminator,
                setup_pin_code: passcode,
                vendor_id: vendorId,
                product_id: productId,
            };
        }
        return {
            type: "qr",
            payloads: decoded.payloads.map(payload => ({
                version: payload.version,
                vendor_id: payload.vendorId,
                product_id: payload.productId,
                flow_type: payload.flowType,
                discovery_capabilities: payload.discoveryCapabilities,
                discriminator: payload.discriminator,
                setup_pin_code: payload.passcode,
            })),
        };
    },

    /**
     * Ask the DCL (and the local image store) whether a firmware update exists for a node.
     * The result is remembered so the device's `update` state property can report it.
     */
    "device/ota_update/check": async (args, ctx) => {
        const nodeId = nodeIdOf(args);
        const device = nodeId.toString();
        const ota = requireOta(ctx);
        // A DCL round trip per request: refuse to pile them up on one node (zigbee2mqtt semantics)
        if (!ota.begin(device)) {
            throw new Error(`an OTA check or update is already running for node ${device}`);
        }
        try {
            const update = await ctx.commandHandler.checkNodeUpdate(nodeId);
            ota.setAvailableUpdate(device, update);
            return {
                id: args.id,
                update_available: update !== null,
                latest_version: update?.software_version ?? null,
                latest_version_string: update?.software_version_string ?? null,
                latest_source: update?.update_source ?? null,
                latest_release_notes: update?.release_notes_url ?? null,
            };
        } finally {
            ota.end(device);
        }
    },

    /**
     * Start a firmware update. `software_version` is optional: without it the target comes from the
     * last check, or from a check run now — which is what Home Assistant's install button needs,
     * since it can only send the node id.
     */
    "device/ota_update/update": async (args, ctx) => {
        const nodeId = nodeIdOf(args);
        const device = nodeId.toString();
        const ota = requireOta(ctx);
        if (!ota.begin(device)) {
            throw new Error(`an OTA check or update is already running for node ${device}`);
        }
        try {
            let target = softwareVersionOf(args.software_version);
            if (target === undefined) {
                const available =
                    ota.availableUpdate(device) ?? (await ctx.commandHandler.checkNodeUpdate(nodeId)) ?? undefined;
                if (available === undefined) {
                    throw new Error("no update available for this node");
                }
                ota.setAvailableUpdate(device, available);
                target = available.software_version;
            }
            const started = await ctx.commandHandler.updateNode(nodeId, target);
            ota.markUpdateRequested(device);
            return {
                id: args.id,
                software_version: target,
                software_version_string: started?.software_version_string ?? null,
            };
        } finally {
            ota.end(device);
        }
    },
};

export const BRIDGE_COMMAND_NAMES: readonly string[] = Object.keys(COMMANDS);

/** Bridge commands that change the stored commissioning credentials. */
export const CREDENTIAL_COMMAND_NAMES: readonly string[] = [
    "wifi_ssid",
    "wifi_password",
    "wifi_credentials",
    "thread_dataset",
];

/** Bridge commands that change a device's published `update` property. */
export const OTA_COMMAND_NAMES: readonly string[] = ["device/ota_update/check", "device/ota_update/update"];

/**
 * The HA bridge card enters SSID and password through two single-value text entities;
 * combine both halves (reusing the stored, write-only password for an unchanged SSID)
 * and persist once complete.
 */
async function updateWifiInput(
    ctx: BridgeCommandContext,
    update: { ssid?: string; password?: string },
): Promise<unknown> {
    const input = (ctx.wifiInput ??= {});
    Object.assign(input, update);
    const stored = ctx.config.getWifiCredentials(ConfigStorage.DEFAULT_CREDENTIAL_ID);
    const ssid = input.ssid ?? stored?.ssid;
    const password = input.password ?? (ssid !== undefined && ssid === stored?.ssid ? stored.credentials : undefined);
    if (ssid === undefined || password === undefined) {
        return { pending: ssid === undefined ? "ssid" : "password" };
    }
    await ctx.config.setWifiCredentials(ConfigStorage.DEFAULT_CREDENTIAL_ID, ssid, password);
    ctx.wifiInput = {};
    return { ssid };
}

function requireOta(ctx: BridgeCommandContext): OtaTracker {
    if (ctx.ota === undefined) {
        throw new Error("OTA commands are not available");
    }
    return ctx.ota;
}

/** Optional target version; Home Assistant templates deliver numbers as strings. */
function softwareVersionOf(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    const version = typeof value === "string" ? parseInt(value, 10) : value;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
        throw new Error(`invalid "software_version" ${JSON.stringify(value)}`);
    }
    return version;
}

/**
 * Resolve and check a bind/unbind request: both devices, the endpoints, the clusters, and the current binding
 * and (across nodes) ACL lists, which are written back whole. Refuses rather than write an ACL it cannot read
 * or that holds no administrator entry, since a wrong ACL locks the controller out of the target for good.
 */
function bindingPlanOf(args: Record<string, unknown>, ctx: BridgeCommandContext) {
    const resolve = (key: unknown, role: string) => {
        if (typeof key !== "string" && typeof key !== "number") {
            throw new Error(`expected {"from": <device>, "to": <device>}`);
        }
        const device = ctx.resolveDevice?.(String(key));
        if (device === undefined) {
            throw new Error(`unknown ${role} device "${String(key)}"`);
        }
        return device;
    };
    const from = resolve(args.from, "source");
    const to = resolve(args.to, "target");

    const fromEndpoint = endpointArg(args.from_endpoint) ?? bindingEndpointsOf(from.attributes)[0];
    if (fromEndpoint === undefined || from.attributes[`${fromEndpoint}/${BINDING_CLUSTER_ID}/0`] === undefined) {
        throw new Error(
            `device "${String(args.from)}" has no Binding cluster${fromEndpoint === undefined ? "" : ` on endpoint ${fromEndpoint}`}`,
        );
    }

    let clusters: number[];
    if (args.clusters !== undefined) {
        if (!Array.isArray(args.clusters)) {
            throw new Error('"clusters" must be a list of cluster names or ids');
        }
        clusters = args.clusters.map(name => {
            const id = clusterIdOf(name);
            if (id === undefined) {
                throw new Error(`unknown cluster ${JSON.stringify(name)}`);
            }
            return id;
        });
    } else {
        clusters = [];
    }

    let toEndpoint = endpointArg(args.to_endpoint);
    if (clusters.length === 0) {
        const candidates = toEndpoint === undefined ? targetEndpointsOf(to.attributes) : [toEndpoint];
        for (const candidate of candidates) {
            clusters = bindableClustersOf(from.attributes, fromEndpoint, to.attributes, candidate);
            if (clusters.length > 0) {
                toEndpoint = candidate;
                break;
            }
        }
        if (clusters.length === 0) {
            throw new Error('the source controls none of the clusters the target serves; name them in "clusters"');
        }
    }
    toEndpoint ??= targetEndpointOf(to.attributes, clusters);
    if (toEndpoint === undefined) {
        throw new Error(
            `device "${String(args.to)}" has no endpoint serving ${clusters.map(clusterNameOf).join(", ")}`,
        );
    }

    const bindings = bindingTargetsOf(from.nodeAttributes[`${fromEndpoint}/${BINDING_CLUSTER_ID}/0`]);
    if (bindings === undefined) {
        throw new Error("the source's current bindings are not known yet; try again once it reported them");
    }

    // A node always has access to itself, so a binding within one node (two devices behind the same bridge)
    // needs no ACL entry
    let acl;
    if (from.nodeId !== to.nodeId) {
        acl = aclEntriesOf(to.nodeAttributes[`0/${ACCESS_CONTROL_CLUSTER_ID}/0`]);
        if (acl === undefined) {
            throw new Error("the target's access control list is not known; refusing to rewrite it");
        }
        if (!hasAdministrator(acl)) {
            throw new Error("the target's access control list has no administrator entry; refusing to rewrite it");
        }
    }

    const request: BindingRequest = { node: BigInt(to.nodeId), endpoint: toEndpoint, clusters };
    // The ACL subject is the source node; the binding target is the target node
    const access: BindingRequest = { node: BigInt(from.nodeId), endpoint: toEndpoint, clusters };
    return {
        from,
        to,
        fromEndpoint,
        bindings,
        acl,
        request: { binding: request, access },
        response: {
            from: String(args.from),
            from_endpoint: fromEndpoint,
            to: String(args.to),
            to_endpoint: toEndpoint,
            clusters: clusters.map(clusterNameOf),
            failed: [],
        },
    };
}

function groupsOf(ctx: BridgeCommandContext): GroupOperations {
    if (ctx.groups === undefined) {
        throw new Error("groups are not available");
    }
    return ctx.groups;
}

function deviceArg(args: Record<string, unknown>): string {
    if (typeof args.device !== "string" && typeof args.device !== "number") {
        throw new Error('expected {"device": <device>}');
    }
    return String(args.device);
}

function targetEndpointsOf(attributes: AttributesData): number[] {
    const endpoints = new Set<number>();
    for (const path of Object.keys(attributes)) {
        const [endpoint, cluster, attribute] = path.split("/").map(Number);
        if (cluster === 29 && attribute === 1 && endpoint !== undefined) {
            endpoints.add(endpoint);
        }
    }
    return [...endpoints].sort((a, b) => a - b);
}

function endpointArg(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    const endpoint = typeof value === "string" ? Number(value) : value;
    if (typeof endpoint !== "number" || !Number.isInteger(endpoint) || endpoint < 0) {
        throw new Error(`invalid endpoint ${JSON.stringify(value)}`);
    }
    return endpoint;
}

async function writeChecked(write: Promise<{ status: number }[] | null>, what: string): Promise<void> {
    const status = (await write)?.[0]?.status ?? 0;
    if (status !== 0) {
        throw new Error(`writing the ${what} failed with status ${status}`);
    }
}

/** Optional positive number of seconds; Home Assistant templates deliver numbers as strings. */
function positiveNumberOf(value: unknown, name: string): number | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    const number = typeof value === "string" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) {
        throw new Error(`"${name}" must be a positive number of seconds, got ${JSON.stringify(value)}`);
    }
    return number;
}

function discoveryTimeoutOf(value: unknown): Duration | undefined {
    const seconds = positiveNumberOf(value, "discovery_timeout_s");
    if (seconds === undefined) {
        return undefined;
    }
    if (seconds > MAX_DISCOVERY_TIMEOUT_S) {
        throw new Error(`"discovery_timeout_s" must be at most ${MAX_DISCOVERY_TIMEOUT_S}, got ${seconds}`);
    }
    return Seconds(seconds);
}

function nodeIdOf(args: Record<string, unknown>): NodeId {
    const id = args.id;
    if (typeof id !== "number" && typeof id !== "string" && typeof id !== "bigint") {
        throw new Error('expected {"id": <node id>}');
    }
    try {
        return NodeId(BigInt(id));
    } catch {
        throw new Error(`invalid node id "${String(id)}"`);
    }
}

/** matter.js node id collision, anywhere in the cause chain (WebSocketControllerHandler logic). */
function isIdentityConflict(error: unknown): boolean {
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
        if (current instanceof MatterError && current.id === "identity-conflict") {
            return true;
        }
    }
    return false;
}

/** Parse the request payload and run the command; never throws. */
export async function executeBridgeCommand(
    command: string,
    payload: string,
    ctx: BridgeCommandContext,
): Promise<BridgeCommandResponse> {
    let args: Record<string, unknown> = {};
    if (payload.trim().length > 0) {
        const bareKey = BARE_PAYLOAD_KEYS[command];
        try {
            const parsed: unknown = JSON.parse(payload);
            if (typeof parsed === "object" && parsed !== null) {
                args = parsed as Record<string, unknown>;
            } else if (bareKey !== undefined && typeof parsed === "string") {
                args = { [bareKey]: parsed };
            } else if (bareKey !== undefined) {
                // Bare numeric payloads must keep their exact digits (pairing codes, hex datasets)
                args = { [bareKey]: payload.trim() };
            } else {
                return { status: "error", error: "payload must be a JSON object" };
            }
        } catch {
            if (bareKey !== undefined) {
                args = { [bareKey]: payload.trim() };
            } else {
                return { status: "error", error: "payload must be a JSON object" };
            }
        }
    }

    const transaction = args.transaction;
    const handler = COMMANDS[command];
    if (handler === undefined) {
        return withTransaction({ status: "error", error: `unknown command "${command}"` }, transaction);
    }
    try {
        const data = await handler(args, ctx);
        return withTransaction({ status: "ok", data }, transaction);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Bridge command "${command}" failed: ${message}`);
        const response: BridgeCommandResponse = { status: "error", error: message };
        if (error instanceof ServerError && error.reason !== undefined) {
            response.reason = error.reason;
        }
        return withTransaction(response, transaction);
    }
}

function withTransaction(response: BridgeCommandResponse, transaction: unknown): BridgeCommandResponse {
    if (transaction !== undefined) {
        response.transaction = transaction;
    }
    return response;
}
