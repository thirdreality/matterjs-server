/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    ConfigStorage,
    registerThreadCredentialsFromHex,
    type ControllerCommandHandler,
    type MatterController,
} from "@matter-server/ws-controller";
import { Logger, MatterError, NodeId } from "@matter/main";
import { AttributeId, ClusterId, EndpointNumber } from "@matter/main/types";

const logger = Logger.get("BridgeCommands");

/** Maximum commissioning attempts when the chosen node id collides on the fabric. */
const MAX_COMMISSION_NODE_ID_ATTEMPTS = 5;

export interface BridgeCommandContext {
    commandHandler: ControllerCommandHandler;
    config: ConfigStorage;
    controller: MatterController;
}

export interface BridgeCommandResponse {
    status: "ok" | "error";
    data?: unknown;
    error?: string;
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
     * ("add existing device").
     */
    commission: async ({ code, network_only }, ctx) => {
        if (typeof code !== "string" || code.length === 0) {
            throw new Error('expected {"code": "<QR or manual pairing code>"}');
        }
        const { commandHandler, config, controller } = ctx;
        const networkOnly = network_only === true;
        const isQrCode = code.startsWith("MT:");

        let wifiCredentials;
        let threadCredentials;
        if (!networkOnly && commandHandler.bleEnabled) {
            // Only apply stored credentials whose values are actually present
            const wifiEntry = config.getWifiCredentials(ConfigStorage.DEFAULT_CREDENTIAL_ID);
            const threadEntry = config.getThreadCredentials(ConfigStorage.DEFAULT_CREDENTIAL_ID);
            if (wifiEntry?.ssid && wifiEntry.credentials) {
                wifiCredentials = { wifiSsid: wifiEntry.ssid, wifiCredentials: wifiEntry.credentials };
            }
            if (threadEntry?.dataset) {
                threadCredentials = { networkName: "", operationalDataset: threadEntry.dataset };
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

    /** Open a commissioning window (multi-admin share); answers with the pairing codes. */
    "device/share": async (args, { commandHandler }) => {
        const { manualCode, qrCode } = await commandHandler.openCommissioningWindow({ nodeId: nodeIdOf(args) });
        return { id: args.id, manual_code: manualCode, qr_code: qrCode };
    },
};

export const BRIDGE_COMMAND_NAMES: readonly string[] = Object.keys(COMMANDS);

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
        try {
            const parsed: unknown = JSON.parse(payload);
            if (typeof parsed === "object" && parsed !== null) {
                args = parsed as Record<string, unknown>;
            } else if (command === "commission" && (typeof parsed === "string" || typeof parsed === "number")) {
                // A bare manual pairing code parses as a JSON number
                args = { code: String(parsed) };
            } else {
                return { status: "error", error: "payload must be a JSON object" };
            }
        } catch {
            if (command === "commission") {
                // Convenience (and the HA text entity): a bare pairing code
                args = { code: payload.trim() };
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
        return withTransaction({ status: "error", error: message }, transaction);
    }
}

function withTransaction(response: BridgeCommandResponse, transaction: unknown): BridgeCommandResponse {
    if (transaction !== undefined) {
        response.transaction = transaction;
    }
    return response;
}
