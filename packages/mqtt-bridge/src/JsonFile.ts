/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { Logger } from "@matter/main";
import { readFile, rename, writeFile } from "node:fs/promises";

const logger = Logger.get("JsonFile");

/** Read a JSON file; undefined when it does not exist yet or cannot be read (which is logged). */
export async function readJsonFile(path: string): Promise<unknown> {
    try {
        return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.warn(`Cannot read ${path}, starting without it:`, error);
        }
        return undefined;
    }
}

/** Write a JSON file through a temporary file and a rename, so a power cut leaves the old or the new one. */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2));
    await rename(temporary, path);
}
