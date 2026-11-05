/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceOptionsStore, mergeOptions, optionExposesOf } from "../src/DeviceOptions.js";
import { harness } from "./BridgeHarness.js";

const BULB = { "1/6/0": true, "1/8/0": 100 };
const COVER = { "1/258/65532": 0b101, "1/258/14": 2500 };

describe("DeviceOptions", () => {
    it("merges valid options and removes null ones", () => {
        expect(mergeOptions({ retain: false, debounce: 2 }, { debounce: null, transition: "1.5" })).to.deep.equal({
            options: { retain: false, transition: 1.5 },
            errors: [],
        });
    });

    it("rejects unknown and invalid options", () => {
        expect(mergeOptions({}, { colour: 1, retain: "yes", debounce: -1 }).errors).to.deep.equal([
            'unknown option "colour"',
            'option "retain" must be true or false',
            'option "debounce" must be a number from 0 to 3600',
        ]);
        expect(mergeOptions({}, [1]).errors).to.deep.equal(['"options" must be an object']);
    });

    it("offers the options that apply to the device", () => {
        expect(optionExposesOf({ light: false, cover: false }).map(o => o.name)).to.deep.equal(["retain", "debounce"]);
        expect(optionExposesOf({ light: true, cover: true }).map(o => o.name)).to.deep.equal([
            "retain",
            "debounce",
            "transition",
            "invert_cover",
        ]);
    });

    it("persists the options to a file", async () => {
        const directory = await mkdtemp(join(tmpdir(), "device-options-"));
        try {
            const file = join(directory, "options.json");
            const store = new DeviceOptionsStore(file);
            await store.load();
            await store.set("5", { retain: false });
            expect(JSON.parse(await readFile(file, "utf8"))).to.deep.equal({ "5": { retain: false } });
            const reloaded = new DeviceOptionsStore(file);
            await reloaded.load();
            expect(reloaded.get("5")).to.deep.equal({ retain: false });
            await reloaded.set("5", {});
            expect(JSON.parse(await readFile(file, "utf8"))).to.deep.equal({});
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    describe("on the bridge", () => {
        const setOptions = async (h: ReturnType<typeof harness>, options: unknown) => {
            h.send("matter2mqtt/bridge/request/device/options", JSON.stringify({ id: "12", options }));
            await new Promise(resolve => setImmediate(resolve));
            return JSON.parse(h.last("matter2mqtt/bridge/response/device/options") ?? "{}") as Record<string, unknown>;
        };

        it("answers with the options before and after, and lists them in bridge/devices", async () => {
            const h = harness(BULB, { withCommands: true, isBridge: false });
            await h.bridge.start();
            const response = await setOptions(h, { transition: 2 });
            expect(response).to.deep.equal({
                status: "ok",
                data: { id: "12", from: {}, to: { transition: 2 }, restart_required: false },
            });
            const [device] = JSON.parse(h.last("matter2mqtt/bridge/devices") ?? "[]") as Record<string, unknown>[];
            expect(device.options).to.deep.equal({ transition: 2 });
            const definition = device.definition as { options: { name: string }[] };
            expect(definition.options.map(o => o.name)).to.deep.equal(["retain", "debounce", "transition"]);
            await h.bridge.stop();
        });

        it("stops retaining the state and clears what the broker kept", async () => {
            const h = harness(BULB, { withCommands: true, isBridge: false });
            await h.bridge.start();
            await setOptions(h, { retain: false });
            const states = h.published.filter(p => p.topic === "matter2mqtt/12");
            expect(states.at(-2)).to.deep.equal({ topic: "matter2mqtt/12", payload: "", retain: true });
            expect(states.at(-1)).to.include({ retain: false });
            await h.bridge.stop();
        });

        it("adds the default transition to light commands", async () => {
            const h = harness(BULB, { withCommands: true, isBridge: false });
            await h.bridge.start();
            await setOptions(h, { transition: 1.5 });
            h.send("matter2mqtt/12/set", '{"brightness":50}');
            expect(h.invoked.at(-1)).to.deep.include({ commandName: "moveToLevelWithOnOff" });
            expect((h.invoked.at(-1) as { data: { transitionTime: number } }).data.transitionTime).to.equal(15);
            await h.bridge.stop();
        });

        it("inverts cover position both ways", async () => {
            const h = harness(COVER, { withCommands: true, isBridge: false });
            await h.bridge.start();
            expect(JSON.parse(h.last("matter2mqtt/12") ?? "{}").position).to.equal(75);
            await setOptions(h, { invert_cover: true });
            expect(JSON.parse(h.last("matter2mqtt/12") ?? "{}").position).to.equal(25);
            h.send("matter2mqtt/12/set", '{"position":10}');
            expect(h.invoked.at(-1)).to.deep.include({ data: { liftPercent100thsValue: 1000 } });
            await h.bridge.stop();
        });

        it("combines state changes within the debounce window", async () => {
            const h = harness(BULB, { withCommands: true, isBridge: false });
            await h.bridge.start();
            await setOptions(h, { debounce: 0.05 });
            const before = h.published.filter(p => p.topic === "matter2mqtt/12").length;
            for (let i = 0; i < 3; i++) {
                h.events.attributeChanged.emit(h.nodeId, {
                    path: { endpointId: 1, clusterId: 8, attributeId: 0 },
                    value: i,
                });
            }
            expect(h.published.filter(p => p.topic === "matter2mqtt/12").length).to.equal(before);
            await new Promise(resolve => setTimeout(resolve, 120));
            expect(h.published.filter(p => p.topic === "matter2mqtt/12").length).to.equal(before + 1);
            await h.bridge.stop();
        });

        it("refuses options for an unknown device", async () => {
            const h = harness(BULB, { withCommands: true, isBridge: false });
            await h.bridge.start();
            h.send("matter2mqtt/bridge/request/device/options", '{"id":"99","options":{"retain":false}}');
            await new Promise(resolve => setImmediate(resolve));
            expect(JSON.parse(h.last("matter2mqtt/bridge/response/device/options") ?? "{}").error).to.equal(
                'unknown device "99"',
            );
            await h.bridge.stop();
        });
    });
});
