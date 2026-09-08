/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { UpdateSource, type MatterSoftwareVersion } from "@matter-server/ws-controller";
import { OtaTracker, supportsOta } from "../src/OtaState.js";

/** Node with the OTA Requestor cluster, idle, running 1.0.3. */
const OTA_NODE = {
    "0/40/9": 16777235,
    "0/40/10": "1.0.3",
    "0/42/2": 1,
};

const UPDATE: MatterSoftwareVersion = {
    vid: 4891,
    pid: 1,
    software_version: 16777236,
    software_version_string: "1.0.4",
    min_applicable_software_version: 0,
    max_applicable_software_version: 16777235,
    release_notes_url: "https://example.com/notes",
    update_source: UpdateSource.MAIN_NET_DCL,
};

describe("supportsOta", () => {
    it("requires the OTA Requestor update state attribute", () => {
        expect(supportsOta(OTA_NODE)).to.equal(true);
        expect(supportsOta({ "0/40/9": 1 })).to.equal(false);
    });
});

describe("OtaTracker", () => {
    it("reports idle with the installed version as latest when nothing is known", () => {
        const tracker = new OtaTracker();
        expect(tracker.updateStateOf("8", OTA_NODE)).to.deep.equal({
            state: "idle",
            installed_version: 16777235,
            installed_version_string: "1.0.3",
            latest_version: 16777235,
            latest_version_string: "1.0.3",
            latest_source: null,
            latest_release_notes: null,
        });
    });

    it("skips nodes without the OTA Requestor cluster", () => {
        expect(new OtaTracker().updateStateOf("8", { "1/6/0": true })).to.equal(undefined);
    });

    it("reports an available update with its source and release notes", () => {
        const tracker = new OtaTracker();
        tracker.setAvailableUpdate("8", UPDATE);
        expect(tracker.updateStateOf("8", OTA_NODE)).to.deep.equal({
            state: "available",
            installed_version: 16777235,
            installed_version_string: "1.0.3",
            latest_version: 16777236,
            latest_version_string: "1.0.4",
            latest_source: "main-net-dcl",
            latest_release_notes: "https://example.com/notes",
        });
    });

    it("drops an update that is already installed", () => {
        const tracker = new OtaTracker();
        tracker.setAvailableUpdate("8", UPDATE);
        const installed = { ...OTA_NODE, "0/40/9": 16777236, "0/40/10": "1.0.4" };
        const state = tracker.updateStateOf("8", installed);
        expect(state?.state).to.equal("idle");
        expect(state?.latest_version).to.equal(16777236);
        expect(state?.latest_source).to.equal(null);
    });

    it("reports updating with progress while the device downloads", () => {
        const tracker = new OtaTracker();
        tracker.setAvailableUpdate("8", UPDATE);
        const downloading = { ...OTA_NODE, "0/42/2": 4, "0/42/3": 42 };
        const state = tracker.updateStateOf("8", downloading);
        expect(state?.state).to.equal("updating");
        expect(state?.progress).to.equal(42);
    });

    it("omits progress unless the device is updating", () => {
        const tracker = new OtaTracker();
        const idleWithStaleProgress = { ...OTA_NODE, "0/42/3": 42 };
        expect(tracker.updateStateOf("8", idleWithStaleProgress)).to.not.have.property("progress");
    });

    it("treats every non-idle update state as updating", () => {
        const tracker = new OtaTracker();
        for (const updateState of [2, 3, 4, 5, 6, 7, 8]) {
            expect(tracker.updateStateOf("8", { ...OTA_NODE, "0/42/2": updateState })?.state).to.equal("updating");
        }
        // Unknown (0) is not progress
        expect(tracker.updateStateOf("8", { ...OTA_NODE, "0/42/2": 0 })?.state).to.equal("idle");
    });

    it("reports updating right after a request, before the device picks it up", () => {
        const tracker = new OtaTracker();
        tracker.setAvailableUpdate("8", UPDATE);
        tracker.markUpdateRequested("8");
        expect(tracker.updateStateOf("8", OTA_NODE)?.state).to.equal("updating");
    });

    it("falls back to the device state once the request grace window passed", () => {
        const tracker = new OtaTracker();
        tracker.setAvailableUpdate("8", UPDATE);
        tracker.markUpdateRequested("8");
        const later = Date.now() + 16 * 60 * 1000;
        expect(tracker.updateStateOf("8", OTA_NODE, later)?.state).to.equal("available");
        // The stale request is dropped, so the next call agrees without needing the clock
        expect(tracker.updateStateOf("8", OTA_NODE)?.state).to.equal("available");
    });

    it("guards one operation per device", () => {
        const tracker = new OtaTracker();
        expect(tracker.begin("8")).to.equal(true);
        expect(tracker.begin("8")).to.equal(false);
        expect(tracker.begin("9")).to.equal(true);
        tracker.end("8");
        expect(tracker.begin("8")).to.equal(true);
    });

    it("forgets everything about a removed device", () => {
        const tracker = new OtaTracker();
        tracker.setAvailableUpdate("8", UPDATE);
        tracker.markUpdateRequested("8");
        tracker.begin("8");
        tracker.forget("8");
        expect(tracker.availableUpdate("8")).to.equal(undefined);
        expect(tracker.begin("8")).to.equal(true);
        tracker.end("8");
        expect(tracker.updateStateOf("8", OTA_NODE)?.state).to.equal("idle");
    });

    it("clears a stored update when the check comes back empty", () => {
        const tracker = new OtaTracker();
        tracker.setAvailableUpdate("8", UPDATE);
        tracker.setAvailableUpdate("8", null);
        expect(tracker.availableUpdate("8")).to.equal(undefined);
    });

    it("falls back to the numeric version when the version string is missing", () => {
        const tracker = new OtaTracker();
        const state = tracker.updateStateOf("8", { "0/40/9": 5, "0/42/2": 1 });
        expect(state?.installed_version_string).to.equal("5");
        expect(state?.latest_version_string).to.equal("5");
    });
});
