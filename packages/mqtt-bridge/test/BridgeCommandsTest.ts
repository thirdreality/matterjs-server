/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { executeBridgeCommand, type BridgeCommandContext } from "../src/BridgeCommands.js";

interface Call {
    method: string;
    args: unknown[];
}

function mockContext() {
    const calls: Call[] = [];
    const record =
        (method: string, result?: unknown) =>
        (...args: unknown[]) => {
            calls.push({ method, args });
            return Promise.resolve(result);
        };
    const ctx = {
        commandHandler: {
            bleEnabled: true,
            isNodeIdInUse: () => false,
            commissionNode: record("commissionNode", { nodeId: 12n }),
            removeNode: record("removeNode"),
            interviewNode: record("interviewNode"),
            handleWriteAttribute: record("handleWriteAttribute", { status: 0 }),
            openCommissioningWindow: record("openCommissioningWindow", { manualCode: "123", qrCode: "MT:X" }),
        },
        config: {
            setWifiCredentials: record("setWifiCredentials"),
            setThreadCredentials: record("setThreadCredentials"),
            allocateNodeId: record("allocateNodeId", 12),
            getWifiCredentials: () => ({ ssid: "NET", credentials: "PASS" }),
            getThreadCredentials: () => undefined,
        },
        controller: {
            certificateService: record("certificateService"),
            credentials: {},
        },
    };
    return { ctx: ctx as unknown as BridgeCommandContext, calls };
}

describe("BridgeCommands", () => {
    it("rejects unknown commands and echoes the transaction", async () => {
        const { ctx } = mockContext();
        const response = await executeBridgeCommand("nope", '{"transaction":7}', ctx);
        expect(response.status).to.equal("error");
        expect(response.error).to.contain("unknown command");
        expect(response.transaction).to.equal(7);
    });

    it("rejects non-object payloads for regular commands", async () => {
        const { ctx } = mockContext();
        const response = await executeBridgeCommand("device/remove", "garbage", ctx);
        expect(response.status).to.equal("error");
        expect(response.error).to.contain("JSON object");
    });

    it("stores wifi credentials without echoing the password", async () => {
        const { ctx, calls } = mockContext();
        const response = await executeBridgeCommand("wifi_credentials", '{"ssid":"NET","credentials":"S3CRET"}', ctx);
        expect(response.status).to.equal("ok");
        expect(JSON.stringify(response)).to.not.contain("S3CRET");
        expect(calls[0]).to.deep.equal({ method: "setWifiCredentials", args: ["default", "NET", "S3CRET"] });
    });

    it("validates wifi credential arguments", async () => {
        const { ctx } = mockContext();
        const response = await executeBridgeCommand("wifi_credentials", '{"ssid":""}', ctx);
        expect(response.status).to.equal("error");
    });

    it("combines ssid and password entered separately (HA text entities)", async () => {
        const { ctx, calls } = mockContext();
        (ctx.config as unknown as Record<string, unknown>).getWifiCredentials = () => undefined;
        const first = await executeBridgeCommand("wifi_ssid", "MyNet", ctx);
        expect(first.status).to.equal("ok");
        expect(first.data).to.deep.equal({ pending: "password" });
        const second = await executeBridgeCommand("wifi_password", "S3CRET", ctx);
        expect(second.status).to.equal("ok");
        expect(second.data).to.deep.equal({ ssid: "MyNet" });
        expect(JSON.stringify(second)).to.not.contain("S3CRET");
        expect(calls[0]).to.deep.equal({ method: "setWifiCredentials", args: ["default", "MyNet", "S3CRET"] });
    });

    it("updates only the password against the stored ssid", async () => {
        const { ctx, calls } = mockContext();
        const response = await executeBridgeCommand("wifi_password", "N3WPASS", ctx);
        expect(response.status).to.equal("ok");
        expect(response.data).to.deep.equal({ ssid: "NET" });
        expect(calls[0]).to.deep.equal({ method: "setWifiCredentials", args: ["default", "NET", "N3WPASS"] });
    });

    it("reuses the stored password for an unchanged ssid", async () => {
        const { ctx, calls } = mockContext();
        const response = await executeBridgeCommand("wifi_ssid", "NET", ctx);
        expect(response.data).to.deep.equal({ ssid: "NET" });
        expect(calls[0]).to.deep.equal({ method: "setWifiCredentials", args: ["default", "NET", "PASS"] });
    });

    it("keeps a new ssid pending until its own password arrives", async () => {
        const { ctx, calls } = mockContext();
        const response = await executeBridgeCommand("wifi_ssid", "OtherNet", ctx);
        expect(response.data).to.deep.equal({ pending: "password" });
        expect(calls.filter(c => c.method === "setWifiCredentials")).to.have.length(0);
    });

    it("treats a bare numeric thread dataset payload without digit loss", async () => {
        const { ctx, calls } = mockContext();
        const digits = "112233445566778899000111222333444555666777888999";
        const response = await executeBridgeCommand("thread_dataset", digits, ctx);
        expect(response.status).to.equal("ok");
        expect(calls[0]).to.deep.equal({ method: "setThreadCredentials", args: ["default", digits] });
    });

    it("commissions with stored credentials and allocated node id", async () => {
        const { ctx, calls } = mockContext();
        const response = await executeBridgeCommand("commission", '{"code":"MT:ABC","transaction":"t1"}', ctx);
        expect(response.status).to.equal("ok");
        expect(response.data).to.deep.equal({ node_id: 12 });
        expect(response.transaction).to.equal("t1");
        const commission = calls.find(c => c.method === "commissionNode");
        const request = (commission as Call).args[0] as Record<string, unknown>;
        expect(request.qrCode).to.equal("MT:ABC");
        expect(request.onNetworkOnly).to.equal(false);
        expect(request.wifiCredentials).to.deep.equal({ wifiSsid: "NET", wifiCredentials: "PASS" });
        expect(calls.some(c => c.method === "certificateService")).to.equal(true);
    });

    it("treats a bare payload as the pairing code (HA text entity)", async () => {
        const { ctx, calls } = mockContext();
        const response = await executeBridgeCommand("commission", "34970112332", ctx);
        expect(response.status).to.equal("ok");
        const request = (calls.find(c => c.method === "commissionNode") as Call).args[0] as Record<string, unknown>;
        expect(request.manualCode).to.equal("34970112332");
    });

    it("restricts credentials to the requested network type", async () => {
        const { ctx, calls } = mockContext();
        await executeBridgeCommand("commission", '{"code":"MT:ABC","network":"wifi"}', ctx);
        const request = (calls.find(c => c.method === "commissionNode") as Call).args[0] as Record<string, unknown>;
        expect(request.wifiCredentials).to.deep.equal({ wifiSsid: "NET", wifiCredentials: "PASS" });
        expect(request.threadCredentials).to.equal(undefined);
    });

    it("fails early when the requested network credentials are not stored", async () => {
        const { ctx } = mockContext();
        const thread = await executeBridgeCommand("commission", '{"code":"MT:ABC","network":"thread"}', ctx);
        expect(thread.status).to.equal("error");
        expect(thread.error).to.contain("Thread dataset");
        (ctx.config as unknown as Record<string, unknown>).getWifiCredentials = () => undefined;
        const wifi = await executeBridgeCommand("commission", '{"code":"MT:ABC","network":"wifi"}', ctx);
        expect(wifi.status).to.equal("error");
        expect(wifi.error).to.contain("WiFi credentials");
        const invalid = await executeBridgeCommand("commission", '{"code":"MT:ABC","network":"zigbee"}', ctx);
        expect(invalid.status).to.equal("error");
    });

    it("skips stored credentials for network_only commissioning", async () => {
        const { ctx, calls } = mockContext();
        await executeBridgeCommand("commission", '{"code":"MT:ABC","network_only":true}', ctx);
        const request = (calls.find(c => c.method === "commissionNode") as Call).args[0] as Record<string, unknown>;
        expect(request.wifiCredentials).to.equal(undefined);
        expect(request.onNetworkOnly).to.equal(true);
    });

    it("routes device commands with node id validation", async () => {
        const { ctx, calls } = mockContext();
        expect((await executeBridgeCommand("device/remove", '{"id":8}', ctx)).status).to.equal("ok");
        expect((await executeBridgeCommand("device/interview", '{"id":"8"}', ctx)).status).to.equal("ok");
        expect((await executeBridgeCommand("device/remove", '{"id":"x"}', ctx)).status).to.equal("error");
        expect(calls.filter(c => c.method === "removeNode")).to.have.length(1);
        expect(calls.filter(c => c.method === "interviewNode")).to.have.length(1);
    });

    it("renames via the BasicInformation nodeLabel", async () => {
        const { ctx, calls } = mockContext();
        const response = await executeBridgeCommand("device/rename", '{"id":8,"name":"Bedroom light"}', ctx);
        expect(response.status).to.equal("ok");
        const write = (calls.find(c => c.method === "handleWriteAttribute") as Call).args[0] as Record<string, unknown>;
        expect(write.endpointId).to.equal(0);
        expect(write.clusterId).to.equal(40);
        expect(write.attributeId).to.equal(5);
        expect(write.value).to.equal("Bedroom light");
    });

    it("answers share with the pairing codes", async () => {
        const { ctx } = mockContext();
        const response = await executeBridgeCommand("device/share", '{"id":8}', ctx);
        expect(response.status).to.equal("ok");
        expect(response.data).to.deep.equal({ id: 8, manual_code: "123", qr_code: "MT:X" });
    });

    it("wraps handler failures as error responses", async () => {
        const { ctx } = mockContext();
        (ctx.commandHandler as unknown as Record<string, unknown>).removeNode = () => Promise.reject(new Error("boom"));
        const response = await executeBridgeCommand("device/remove", '{"id":8,"transaction":3}', ctx);
        expect(response).to.deep.equal({ status: "error", error: "boom", transaction: 3 });
    });
});
