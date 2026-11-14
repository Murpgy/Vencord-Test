/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";

import gitRemote from "~git-remote";

const logger = new Logger("ForkStatus");

const INITIAL_DELAY = 15_000;
const CHECK_INTERVAL = 6 * 60 * 60_000;

interface WorkflowRun {
    id: number;
    conclusion: string | null;
    html_url: string;
}

interface RanJob {
    steps?: { name: string; conclusion: string | null; }[];
}

const api = (path: string) => fetch(`https://api.github.com/repos/${gitRemote}${path}`, {
    headers: { Accept: "application/vnd.github+json" }
});

// Only the newest completed run is reported once per session. A fix resets the state, so the
// next failure prompts again.
let notifiedRunId: number | null = null;
let initialTimeout: ReturnType<typeof setTimeout>;
let interval: ReturnType<typeof setInterval>;

const openRun = (url: string) => IS_WEB
    ? void window.open(url, "_blank")
    : void VencordNative.native.openExternal(url);

async function describeFailure(runId: number) {
    const res = await api(`/actions/runs/${runId}/jobs`);
    if (!res.ok) return "The latest run failed.";

    const { jobs } = await res.json() as { jobs: RanJob[]; };
    for (const job of jobs) {
        const step = job.steps?.find(s => s.conclusion === "failure");
        if (!step) continue;

        if (step.name === "Sync with upstream")
            return "The upstream sync failed, so Discord's latest changes were not merged. This is almost always a rebase conflict that has to be resolved by hand.";
        return `The build failed at "${step.name}".`;
    }

    return "The latest run failed.";
}

async function checkLatestRun() {
    const res = await api("/actions/workflows/build.yml/runs?branch=main&status=completed&per_page=1");

    if (res.status === 403) {
        logger.warn("GitHub API rate limit reached, skipping this check");
        return;
    }
    if (!res.ok) throw new Error(`GitHub API responded with ${res.status}`);

    const { workflow_runs: [run] } = await res.json() as { workflow_runs: WorkflowRun[]; };
    if (!run) return;

    if (run.conclusion !== "failure" && run.conclusion !== "timed_out") {
        notifiedRunId = null;
        return;
    }

    if (notifiedRunId === run.id) return;
    notifiedRunId = run.id;

    const reason = await describeFailure(run.id);

    showNotification({
        title: "Vencord build failed",
        body: `${reason} Until it is fixed you stay on the last build that worked. Click to open the failed run.`,
        // This is the notification that explains why updates stopped arriving, so do not let
        // it time out before it is read
        permanent: true,
        noPersist: true,
        onClick: () => openRun(run.html_url)
    }).catch(err => logger.error("Failed to show the build failure notification", err));
}

export default definePlugin({
    name: "ForkStatus",
    description: "Tells you when this build's GitHub build or upstream sync fails, so you notice when updates stop arriving",
    tags: ["Notifications", "Utility"],
    authors: [Devs.Murpgy],

    start() {
        // Watching upstream's own CI is not actionable here
        if (gitRemote === "Vendicated/Vencord") return;

        const check = () => void checkLatestRun().catch(err => logger.error("Failed to check the latest build", err));

        // Let Discord finish loading before hitting the network
        initialTimeout = setTimeout(check, INITIAL_DELAY);
        interval = setInterval(check, CHECK_INTERVAL);
    },

    stop() {
        clearTimeout(initialTimeout);
        clearInterval(interval);
    }
});
