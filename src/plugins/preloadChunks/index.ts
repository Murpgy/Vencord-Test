/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { wreq } from "@webpack";
import { getBuildNumber } from "@webpack/patcher";

const logger = new Logger("PreloadChunks");

const STORE_KEY = "preloadChunks";

interface StoredChunks {
    build: number;
    ids: number[];
}

const settings = definePluginSettings({
    delay: {
        type: OptionType.SLIDER,
        description: "Seconds after startup before the chunks are loaded",
        markers: makeRange(5, 120, 5),
        default: 30,
        stickToMarkers: false
    },
    maxChunks: {
        type: OptionType.SLIDER,
        description: "Maximum number of chunks to load",
        markers: makeRange(10, 300, 10),
        default: 120,
        stickToMarkers: false
    }
});

const build = getBuildNumber();

// Chunk ids are only valid for the build that produced them, so the recorded list is keyed by
// the build number and thrown away after a Discord update
const seen = new Set<number>();
let originalEnsure: typeof wreq.e | null = null;
let saveTimeout: ReturnType<typeof setTimeout> | undefined;
let warmTimeout: ReturnType<typeof setTimeout> | undefined;

async function saveSeen() {
    if (seen.size === 0) return;

    const stored = await DataStore.get<StoredChunks>(STORE_KEY);
    const ids = new Set(stored?.build === build ? stored.ids : []);
    seen.forEach(id => ids.add(id));

    await DataStore.set(STORE_KEY, { build, ids: [...ids] } satisfies StoredChunks);
}

function scheduleSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => void saveSeen().catch(err => logger.error("Failed to save the chunk list", err)), 5000);
}

async function warmChunks() {
    if (!originalEnsure) return;

    const stored = await DataStore.get<StoredChunks>(STORE_KEY);
    if (!stored || stored.build !== build) {
        logger.info("Nothing recorded for this build yet, learning this session");
        return;
    }

    // Drop ids the current build does not know about (u() gives "<id>.undefined.js" for those)
    const ids = stored.ids.filter(id => {
        try {
            return !wreq.u(id).includes("undefined");
        } catch {
            return false;
        }
    }).slice(0, settings.store.maxChunks);

    if (ids.length === 0) return;

    const start = performance.now();
    let loaded = 0;

    for (const id of ids) {
        try {
            await originalEnsure.call(wreq, id);
            loaded++;
        } catch (err) {
            logger.warn(`Failed to load chunk ${id}`, err);
        }

        // Spread the work out instead of blocking one long task
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    logger.info(`Preloaded ${loaded}/${ids.length} chunks in ${Math.round(performance.now() - start)}ms`);
}

export default definePlugin({
    name: "PreloadChunks",
    description: "Loads the lazy chunks you used last session in the background, so menus and settings open instantly after a restart",
    tags: ["Utility"],
    authors: [Devs.Murpgy],
    settings,

    start() {
        originalEnsure = wreq.e;
        if (typeof originalEnsure !== "function") {
            logger.warn("This client does not use lazy chunks, nothing to do");
            return;
        }

        wreq.e = function (this: unknown, chunkId: PropertyKey) {
            if (typeof chunkId === "number") {
                seen.add(chunkId);
                scheduleSave();
            }

            const started = performance.now();
            const promise = originalEnsure!.call(wreq, chunkId);

            // Anything slow is worth naming: it tells us whether a laggy menu is waiting on
            // code at all, and which chunk it is
            const report = () => {
                const took = performance.now() - started;
                if (took > 250) logger.info(`chunk ${String(chunkId)} took ${Math.round(took)}ms`);
            };
            void promise.then(report, report);

            return promise;
        };

        warmTimeout = setTimeout(
            () => void warmChunks().catch(err => logger.error("Failed to preload chunks", err)),
            settings.store.delay * 1000
        );
    },

    stop() {
        if (originalEnsure) wreq.e = originalEnsure;
        originalEnsure = null;

        clearTimeout(warmTimeout);
        clearTimeout(saveTimeout);
        void saveSeen().catch(() => { });
    }
});
