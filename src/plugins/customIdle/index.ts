/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { FluxDispatcher } from "@webpack/common";

const logger = new Logger("CustomIdle");

/**
 * Vencord's notice banner (showNotice) is no longer rendered by current Discord builds, and a
 * notice that never renders is never dismissed, so it permanently jams Vencord's notice queue.
 * The "welcome back, go online?" prompt therefore uses a notification toast instead: it is
 * rendered by Vencord's own React root and is unaffected by Discord's notice component.
 * See https://github.com/Vendicated/Vencord/issues/4802
 */

// How long to wait before prompting again after the prompt was dismissed without going online
const REPROMPT_DELAY = 5 * 60_000;

let promptOpen = false;
let lastPromptClosedAt = 0;

const goOnline = () => FluxDispatcher.dispatch({ type: "IDLE", idle: false });

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

        // A live toast sits at the head of Vencord's notification queue until it is closed,
        // so never push a second one while the prompt is still up.
        if (promptOpen || Date.now() - lastPromptClosedAt < REPROMPT_DELAY) return;

        promptOpen = true;
        showNotification({
            title: "You're idle",
            body: "Click this notification to go online. Click the \u00d7 to stay idle for now.",
            // Stays until acted on: a timed toast could vanish before the user notices it,
            // which would leave them idle with no affordance. Switch to false if you would
            // rather not block Vencord's other notifications while the prompt is ignored.
            permanent: true,
            noPersist: true,
            onClick: goOnline,
            onClose: () => {
                promptOpen = false;
                lastPromptClosedAt = Date.now();
            }
        }).catch(err => {
            // Never strand the user in idle because the prompt could not be shown
            promptOpen = false;
            logger.error("Failed to show the go-online prompt, going online instead", err);
            goOnline();
        });
    },

    getIdleTimeout() { // milliseconds, default is 6e5
        const { idleTimeout } = settings.store;
        return idleTimeout === 0 ? Infinity : idleTimeout * 60000;
    }
});
