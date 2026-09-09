/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foreignOwnerReason, reapStaleStorageLocks, type LockOwnerProbe } from "../src/server/StaleStorageLocks.js";

const LOCATION = "/var/lib/matter2mqtt";
const OLD_ENOUGH = 60_000;

/** The real culprit: a thread of an unrelated node process that inherited the recorded id. */
const FOREIGN = "/root/.kiro-server/bin/abc/node /root/.kiro-server/bin/abc/out/server-main.js --start-server";
/** A sibling whose name looks like ours but which holds no storage - a name test would be fooled. */
const BLE_PROXY =
    "/opt/matter2mqtt/ble-venv/bin/python3 /opt/matter2mqtt/ble-venv/bin/matter-ble-proxy --server ws://127.0.0.1:5580/ble";

function probeOf(options: {
    alive?: boolean;
    usesStorage?: boolean | undefined;
    commandLine?: string;
}): LockOwnerProbe {
    return {
        isAlive: () => options.alive ?? true,
        usesStorage: () => Promise.resolve(options.usesStorage),
        commandLineOf: () => Promise.resolve(options.commandLine),
    };
}

describe("foreignOwnerReason", () => {
    it("reclaims when the live owner holds no file in this storage", async () => {
        const reason = await foreignOwnerReason(
            2296,
            LOCATION,
            OLD_ENOUGH,
            probeOf({ usesStorage: false, commandLine: FOREIGN }),
        );
        expect(reason).to.contain("2296");
        expect(reason).to.contain("id was reused");
        expect(reason).to.contain("kiro-server");
    });

    it("reclaims from a sibling that only looks like us", async () => {
        // matter-ble-proxy carries "matter" in its command line but no storage of ours
        expect(
            await foreignOwnerReason(
                2296,
                LOCATION,
                OLD_ENOUGH,
                probeOf({ usesStorage: false, commandLine: BLE_PROXY }),
            ),
        ).to.contain("id was reused");
    });

    it("keeps a lock whose owner has the storage open", async () => {
        expect(await foreignOwnerReason(2296, LOCATION, OLD_ENOUGH, probeOf({ usesStorage: true }))).to.equal(
            undefined,
        );
    });

    it("keeps a lock when the owner cannot be inspected", async () => {
        expect(await foreignOwnerReason(2296, LOCATION, OLD_ENOUGH, probeOf({ usesStorage: undefined }))).to.equal(
            undefined,
        );
    });

    it("leaves a dead owner to the upstream check", async () => {
        expect(
            await foreignOwnerReason(2296, LOCATION, OLD_ENOUGH, probeOf({ alive: false, usesStorage: false })),
        ).to.equal(undefined);
    });

    it("keeps a lock that is too fresh to judge, including a clock that moved backwards", async () => {
        for (const age of [0, 9_999, -60_000]) {
            expect(
                await foreignOwnerReason(2296, LOCATION, age, probeOf({ usesStorage: false, commandLine: FOREIGN })),
                `age ${age}`,
            ).to.equal(undefined);
        }
    });
});

describe("reapStaleStorageLocks", () => {
    let location: string;

    beforeEach(async () => {
        location = await mkdtemp(join(tmpdir(), "stale-lock-test-"));
    });

    afterEach(async () => {
        await rm(location, { recursive: true, force: true });
    });

    /** Writes a lock pair, backdated so it is old enough to be judged. */
    async function writeLock(directory: string, pidFileContent?: string) {
        const path = directory === "" ? location : join(location, directory);
        await mkdir(path, { recursive: true });
        const lockPath = join(path, LOCK_FILE_NAME);
        await writeFile(lockPath, "");
        const backdated = new Date(Date.now() - OLD_ENOUGH);
        await utimes(lockPath, backdated, backdated);
        if (pidFileContent !== undefined) {
            await writeFile(join(path, PID_FILE_NAME), pidFileContent);
        }
    }

    const LOCK_FILE_NAME = "matter.lock";
    const PID_FILE_NAME = "matter.pid";
    const filesIn = async (directory: string) =>
        (await readdir(directory === "" ? location : join(location, directory))).sort();

    it("reclaims every lock of a storage tree left behind by a power cut", async () => {
        for (const directory of ["config", "certificates", "server-2-134b"]) {
            await writeLock(directory, "2296 885d94d325c6f10e");
        }
        const reclaimed = await reapStaleStorageLocks(location, probeOf({ usesStorage: false, commandLine: FOREIGN }));
        expect(reclaimed).to.have.length(3);
        for (const directory of ["config", "certificates", "server-2-134b"]) {
            expect(await filesIn(directory), directory).to.deep.equal([]);
        }
    });

    it("leaves a running instance's locks in place", async () => {
        await writeLock("config", "4242 abc");
        expect(await reapStaleStorageLocks(location, probeOf({ usesStorage: true }))).to.deep.equal([]);
        expect(await filesIn("config")).to.deep.equal(["matter.lock", "matter.pid"]);
    });

    it("ignores a lock without a pid file, which upstream reclaims itself", async () => {
        await writeLock("config");
        expect(await reapStaleStorageLocks(location, probeOf({ usesStorage: false }))).to.deep.equal([]);
        expect(await filesIn("config")).to.deep.equal(["matter.lock"]);
    });

    it("ignores an unparsable pid file", async () => {
        await writeLock("config", "not-a-pid");
        expect(await reapStaleStorageLocks(location, probeOf({ usesStorage: false }))).to.deep.equal([]);
        expect(await filesIn("config")).to.deep.equal(["matter.lock", "matter.pid"]);
    });

    it("also covers a lock directly in the storage root", async () => {
        await writeLock("", "2296 token");
        expect(await reapStaleStorageLocks(location, probeOf({ usesStorage: false }))).to.deep.equal([location]);
    });

    it("does nothing for a storage location that does not exist yet", async () => {
        expect(await reapStaleStorageLocks(join(location, "missing"), probeOf({ usesStorage: false }))).to.deep.equal(
            [],
        );
    });

    it("judges lock age against the clock it is given", async () => {
        await writeLock("config", "2296 token");
        // A clock reading from before the lock was written must not reclaim
        const earlier = () => Date.now() - 10 * OLD_ENOUGH;
        expect(
            await reapStaleStorageLocks(location, probeOf({ usesStorage: false, commandLine: FOREIGN }), earlier),
        ).to.deep.equal([]);
        expect(await filesIn("config")).to.deep.equal(["matter.lock", "matter.pid"]);
    });
});
