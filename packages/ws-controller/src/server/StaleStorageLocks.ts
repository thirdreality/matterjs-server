/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { Logger } from "@matter/main";
import { readFile, readdir, readlink, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const logger = new Logger("StaleStorageLocks");

/** Lock file names used by @matter/nodejs `acquireDirectoryLock`. */
const LOCK_FILE = "matter.lock";
const PID_FILE = "matter.pid";

/**
 * A lock has to be this old before it is a reclaim candidate. Keeps us clear of a sibling that is
 * starting up right now, and fails safe if the clock moves backwards (a negative age never reclaims).
 */
const MIN_LOCK_AGE_MS = 10_000;

export interface LockOwnerProbe {
    /** Whether a process with this id currently exists. */
    isAlive(pid: number): boolean;
    /** Command line of a process, for the log record. Undefined when it cannot be read. */
    commandLineOf(pid: number): Promise<string | undefined>;
    /**
     * Whether a process holds any file open below `location`, or undefined when that cannot be
     * determined (no /proc, or no permission to inspect the process).
     */
    usesStorage(pid: number, location: string): Promise<boolean | undefined>;
}

const defaultProbe: LockOwnerProbe = {
    isAlive(pid) {
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            // EPERM means it exists but belongs to someone else
            return (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
    },

    async commandLineOf(pid) {
        if (process.platform !== "linux") {
            return undefined;
        }
        try {
            return (await readFile(`/proc/${pid}/cmdline`, "utf-8")).replaceAll("\0", " ").trim();
        } catch {
            return undefined;
        }
    },

    async usesStorage(pid, location) {
        if (process.platform !== "linux") {
            return undefined;
        }
        const prefix = resolve(location);
        let descriptors: string[];
        try {
            descriptors = await readdir(`/proc/${pid}/fd`);
        } catch {
            // Gone, or not ours to inspect
            return undefined;
        }
        for (const descriptor of descriptors) {
            try {
                const target = await readlink(`/proc/${pid}/fd/${descriptor}`);
                if (target === prefix || target.startsWith(`${prefix}/`)) {
                    return true;
                }
            } catch {
                // Descriptor closed while we walked the list
            }
        }
        return false;
    },
};

/**
 * Whether a lock can be reclaimed because the process that recorded it is demonstrably not using this
 * storage, i.e. the recorded id was reused by something else.
 *
 * Upstream reclaims a lock whose owner has exited, but its liveness check is just `kill(pid, 0)`: it
 * records nothing that survives a reboot, and on Linux the id space it probes includes thread ids. A
 * lock left behind by a power cut therefore keeps the server down for good as soon as anything else —
 * a thread of an unrelated process is enough — happens to get that id after the reboot.
 *
 * The test is deliberately "does this process have the storage open", not "does its name look right":
 * a sibling such as the BLE proxy carries a matching name but no storage, so a name test would refuse
 * to reclaim exactly when it matters. Every answer other than a definite "not using it" leaves the
 * lock alone, because starting a second instance on live storage is worse than not starting at all.
 *
 * @returns the reason to reclaim, or undefined to leave the lock alone
 */
export async function foreignOwnerReason(
    pid: number,
    location: string,
    lockAgeMs: number,
    probe: LockOwnerProbe,
): Promise<string | undefined> {
    if (!probe.isAlive(pid)) {
        // Upstream already reclaims this case
        return undefined;
    }
    if (!(lockAgeMs >= MIN_LOCK_AGE_MS)) {
        return undefined;
    }
    if ((await probe.usesStorage(pid, location)) !== false) {
        return undefined;
    }
    const commandLine = await probe.commandLineOf(pid);
    return `pid ${pid} holds no file in this storage, so the id was reused (${commandLine ?? "command line unavailable"})`;
}

/** Directories that may carry a lock: the storage root and its immediate children. */
async function lockedDirectoriesOf(location: string): Promise<string[]> {
    const directories = [location];
    try {
        for (const entry of await readdir(location, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                directories.push(join(location, entry.name));
            }
        }
    } catch {
        // A storage location that cannot be listed has no locks to reclaim
    }
    return directories;
}

/**
 * Reclaim storage locks whose recorded owner is demonstrably not using this storage, so an unclean
 * shutdown followed by process id reuse cannot keep the server from starting.
 *
 * Never throws: a failure here must not stop startup, since the lock acquisition that follows reports
 * the real problem.
 *
 * @returns the directories whose locks were reclaimed
 */
export async function reapStaleStorageLocks(
    location: string,
    probe = defaultProbe,
    now = () => Date.now(),
): Promise<string[]> {
    const reclaimed = new Array<string>();
    for (const directory of await lockedDirectoriesOf(location)) {
        const lockPath = join(directory, LOCK_FILE);
        const pidPath = join(directory, PID_FILE);
        try {
            const { mtimeMs } = await stat(lockPath);
            const content = await readFile(pidPath, "utf-8");
            const pid = parseInt(content.trim().split(/\s+/)[0], 10);
            if (!Number.isInteger(pid) || pid <= 0) {
                continue;
            }
            const reason = await foreignOwnerReason(pid, location, now() - mtimeMs, probe);
            if (reason === undefined) {
                continue;
            }
            logger.notice(`Reclaiming storage lock in ${directory}: ${reason}`);
            // The lock is the gate, so it goes first
            await unlink(lockPath);
            await unlink(pidPath).catch(() => {
                // A leftover pid file is harmless: the next acquire overwrites it
            });
            reclaimed.push(directory);
        } catch {
            // No lock, no pid file, or nothing we may touch: leave it to the acquisition that follows
        }
    }
    return reclaimed;
}
