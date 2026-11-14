/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { FluxDispatcher } from "@webpack/common";

import { hideIdleBanner, showIdleBanner } from "./Banner";

const logger = new Logger("CustomIdle");

/**
 * Discord's notice bar is what Vencord's showNotice feeds, and current Discord builds no longer
 * draw generic notices, so the old prompt silently disappeared and jammed the notice queue.
 * The bar cannot be revived from a plugin, because the component that would draw it belongs to
 * Discord, so the prompt draws itself: a small bar under the titlebar, in the same place.
 * See https://github.com/Vendicated/Vencord/issues/4802
 */

// How long to wait before prompting again after the prompt was dismissed without going online
const REPROMPT_DELAY = 5 * 60_000;

let promptOpen = false;
let lastPromptClosedAt = 0;

const goOnline = () => FluxDispatcher.dispatch({ type: "IDLE", idle: false });

const stayIdle = () => {
    promptOpen = false;
    lastPromptClosedAt = Date.now();
};

const goOnlineFromPrompt = () => {
    promptOpen = false;
    lastPromptClosedAt = 0;
    goOnline();
};

const settings = definePluginSettings({
    idleTimeout: {
        description: "Minutes before Discord goes idle (0 to disable auto-idle)",
        type: OptionType.SLIDER,
        markers: makeRange(0, 60, 5),
        default: 10,
        stickToMarkers: false
    },
    remainInIdle: {
        description: "When you come back to Discord, remain idle until you confirm you want to go online",
        type: OptionType.BOOLEAN,
        default: true
    }
});

export default definePlugin({
    name: "CustomIdle",
    description: "Allows you to set the time before Discord goes idle (or disable auto-idle)",
    tags: ["Activity", "Customisation"],
    authors: [Devs.newwares],
    settings,
    patches: [
        {
            find: 'type:"IDLE",idle:',
            replacement: [
                {
                    // FIXME: Stable compat: (?:\i\.\i|6e5), keep only 6e5
                    match: /(?<=Date\.now\(\)-\i>)(?:\i\.\i|6e5)\|\|/,
                    replace: "$self.getIdleTimeout()||"
                },
                {
                    // FIXME: Stable compat: (?:\i\.\i|6e5), keep only 6e5
                    match: /Math\.min\((\i\*\i\.\i\.\i\.SECOND),(?:\i\.\i|6e5)\)/,
                    replace: "$1" // Decouple idle from afk (phone notifications will remain at user setting or 10 min maximum)
                },
                {
                    match: /\i\.\i\.dispatch\({type:"IDLE",idle:!1}\)/,
                    replace: "$self.handleOnline()"
                }
            ]
        }
    ],

    handleOnline() {
        if (!settings.store.remainInIdle) {
            goOnline();
            return;
        }

        if (promptOpen || Date.now() - lastPromptClosedAt < REPROMPT_DELAY) return;

        promptOpen = true;
        try {
            showIdleBanner(goOnlineFromPrompt, stayIdle);
        } catch (err) {
            // Never strand the user in idle because the prompt could not be shown
            promptOpen = false;
            logger.error("Failed to show the go-online prompt, going online instead", err);
            goOnline();
        }
    },

    stop() {
        hideIdleBanner();
        promptOpen = false;
    },

    getIdleTimeout() { // milliseconds, default is 6e5
        const { idleTimeout } = settings.store;
        return idleTimeout === 0 ? Infinity : idleTimeout * 60000;
    }
});
