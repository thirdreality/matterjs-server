/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { NodeId } from "@matter/main";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupDiscoveryOf, groupNameProblemOf, groupStateOf, GroupStore } from "../src/Groups.js";
import { lightCapabilitiesOf } from "../src/LightCapabilities.js";
import { Topics } from "../src/Topics.js";
import { harness } from "./BridgeHarness.js";

// Behind a bridge (node 12): a color temperature bulb on ep3, a dual relay on ep4 with relays on ep5/ep6
const BRIDGE = {
    "3/57/17": true,
    "3/6/0": true,
    "3/8/0": 100,
    "3/768/65532": 16,
    "4/57/17": true,
    "4/29/3": [5, 6],
    "5/6/0": false,
    "6/6/0": false,
};
const PARENTS = { "5": 4, "6": 4 };

const DIMMABLE = lightCapabilitiesOf(
    { "1/6/0": true, "1/8/0": 1, "1/768/65532": 16, "1/768/16395": 200, "1/768/16396": 400 },
    1,
);
const COLOR = lightCapabilitiesOf(
    { "1/6/0": true, "1/8/0": 1, "1/768/65532": 25, "1/768/16395": 153, "1/768/16396": 500 },
    1,
);
const RELAY = lightCapabilitiesOf({ "1/6/0": true }, 1);

describe("Groups", () => {
    it("keeps group names apart from device keys", () => {
        expect(["living room", "Kitchen"].map(groupNameProblemOf)).to.deep.equal([undefined, undefined]);
        for (const name of ["", "bridge", "12", "12_3", "a/b", "x#", 5]) {
            expect(groupNameProblemOf(name)).to.be.a("string");
        }
    });

    it("assigns ids, finds groups by name or id and persists them", async () => {
        const directory = await mkdtemp(join(tmpdir(), "groups-"));
        try {
            const file = join(directory, "groups.json");
            const store = new GroupStore(file);
            const first = await store.add("hall");
            const second = await store.add("kitchen", 7);
            expect([first.id, second.id]).to.deep.equal([1, 7]);
            expect(store.find("7")).to.equal(second);
            expect(store.find("hall")).to.equal(first);
            await store.addMember(first, { device: "5", endpoint: 1 });
            await store.addMember(first, { device: "5", endpoint: 1 });
            expect(first.members).to.have.length(1);
            try {
                await store.add("hall");
                expect.fail("duplicate name accepted");
            } catch (error) {
                expect((error as Error).message).to.contain("exists already");
            }
            const reloaded = new GroupStore(file);
            await reloaded.load();
            expect(reloaded.list().map(g => [g.id, g.friendly_name, g.members])).to.deep.equal([
                [1, "hall", [{ device: "5", endpoint: 1 }]],
                [7, "kitchen", []],
            ]);
            expect((await reloaded.removeDevice("5")).map(g => g.friendly_name)).to.deep.equal(["hall"]);
            expect(JSON.parse(await readFile(file, "utf8"))[0].members).to.deep.equal([]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("is on while any member is on, other properties from the first member", () => {
        expect(
            groupStateOf([
                { state: "OFF", brightness: 10 },
                { state: "ON", brightness: 200, color_temp: 300 },
            ]),
        ).to.deep.equal({
            state: "ON",
            brightness: 10,
            color_temp: 300,
        });
        expect(groupStateOf([{ state: "OFF" }, { state: "OFF" }])).to.deep.equal({ state: "OFF" });
        expect(groupStateOf([])).to.deep.equal({});
    });

    it("announces a light with what all members share, a switch, or nothing", () => {
        const topics = new Topics("matter2mqtt");
        const group = { id: 3, friendly_name: "hall", members: [] };
        const light = JSON.parse(groupDiscoveryOf(group, [DIMMABLE, COLOR], topics)?.payload ?? "{}");
        expect(light).to.include({
            schema: "json",
            command_topic: "matter2mqtt/hall/set",
            min_mireds: 200,
            max_mireds: 400,
        });
        expect(light.supported_color_modes).to.deep.equal(["color_temp"]);
        expect(light.device).to.include({ model: "Group", via_device: "matter2mqtt_bridge" });
        expect(groupDiscoveryOf(group, [DIMMABLE, RELAY], topics)?.topic).to.equal(
            "homeassistant/switch/matter2mqtt_group_3/switch/config",
        );
        expect(groupDiscoveryOf(group, [], topics)).to.equal(undefined);
    });

    describe("on the bridge", () => {
        const request = async (h: ReturnType<typeof harness>, command: string, args: unknown) => {
            h.send(`matter2mqtt/bridge/request/${command}`, JSON.stringify(args));
            await new Promise(resolve => setImmediate(resolve));
            return JSON.parse(h.last(`matter2mqtt/bridge/response/${command}`) ?? "{}") as Record<string, unknown>;
        };
        const start = async () => {
            const h = harness(BRIDGE, { withCommands: true, endpointParents: PARENTS });
            await h.bridge.start();
            expect((await request(h, "group/add", { friendly_name: "living" })).data).to.deep.equal({
                friendly_name: "living",
                id: 1,
            });
            await request(h, "group/members/add", { group: "living", device: "12_3" });
            const added = await request(h, "group/members/add", { group: 1, device: "12_4", endpoint: 5 });
            expect(added.data).to.deep.equal({ group: "living", device: "12_4", endpoint: 5 });
            return h;
        };

        it("lists the groups and publishes the group state", async () => {
            const h = await start();
            expect(JSON.parse(h.last("matter2mqtt/bridge/groups") ?? "[]")).to.deep.equal([
                {
                    id: 1,
                    friendly_name: "living",
                    members: [
                        { device: "12_3", endpoint: 3 },
                        { device: "12_4", endpoint: 5 },
                    ],
                },
            ]);
            expect(JSON.parse(h.last("matter2mqtt/living") ?? "{}")).to.include({ state: "ON", brightness: 100 });
            expect(h.last("homeassistant/switch/matter2mqtt_group_1/switch/config")).to.be.a("string");
            await h.bridge.stop();
        });

        it("sends a group command to every member's endpoint", async () => {
            const h = await start();
            h.send("matter2mqtt/living/set", "OFF");
            expect(h.invoked.map(i => (i as { endpointId: number; commandName: string }).endpointId)).to.deep.equal([
                3, 5,
            ]);
            await h.bridge.stop();
        });

        it("follows member state changes", async () => {
            const h = await start();
            h.setAttributes({ ...BRIDGE, "3/6/0": false });
            h.events.attributeChanged.emit(NodeId(12), {
                path: { endpointId: 3, clusterId: 6, attributeId: 0 },
                value: false,
            });
            expect(JSON.parse(h.last("matter2mqtt/living") ?? "{}").state).to.equal("OFF");
            await h.bridge.stop();
        });

        it("renames and removes, clearing the old topics", async () => {
            const h = await start();
            expect((await request(h, "group/rename", { from: "living", to: "lounge" })).data).to.deep.equal({
                from: "living",
                to: "lounge",
            });
            expect(h.last("matter2mqtt/living")).to.equal("");
            expect(JSON.parse(h.last("matter2mqtt/lounge") ?? "{}").state).to.equal("ON");
            expect((await request(h, "group/remove", { id: "lounge" })).status).to.equal("ok");
            expect(h.last("matter2mqtt/lounge")).to.equal("");
            expect(h.last("homeassistant/switch/matter2mqtt_group_1/switch/config")).to.equal("");
            expect(JSON.parse(h.last("matter2mqtt/bridge/groups") ?? "[1]")).to.deep.equal([]);
            await h.bridge.stop();
        });

        it("refuses names taken by devices or reserved", async () => {
            const h = await start();
            expect((await request(h, "group/add", { friendly_name: "12_3" })).error).to.equal(
                '"12_3" is the name of a device',
            );
            expect((await request(h, "group/add", { friendly_name: "99_1" })).error).to.contain("reserved");
            expect((await request(h, "group/add", { friendly_name: "bridge" })).error).to.contain("reserved");
            expect((await request(h, "group/members/add", { group: "nope", device: "12_3" })).error).to.equal(
                'unknown group "nope"',
            );
            await h.bridge.stop();
        });

        it("drops a device that leaves from its groups", async () => {
            const h = await start();
            h.setAttributes(Object.fromEntries(Object.entries(BRIDGE).filter(([path]) => !path.startsWith("3/"))));
            h.events.nodeStructureChanged.emit(NodeId(12));
            await new Promise(resolve => setImmediate(resolve));
            expect(JSON.parse(h.last("matter2mqtt/bridge/groups") ?? "[]")[0].members).to.deep.equal([
                { device: "12_4", endpoint: 5 },
            ]);
            await h.bridge.stop();
        });

        it("keeps the group's retained state when the broker replays it", async () => {
            const h = await start();
            const before = h.published.length;
            h.send("matter2mqtt/living", '{"state":"ON"}');
            h.send("homeassistant/switch/matter2mqtt_group_1/switch/config", '{"state_topic":"matter2mqtt/living"}');
            expect(h.published.slice(before)).to.deep.equal([]);
            await h.bridge.stop();
        });
    });
});
