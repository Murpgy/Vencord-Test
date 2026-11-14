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

const UPSTREAM = "Vendicated/Vencord";
const INITIAL_DELAY = 15_000;
const CHECK_INTERVAL = 6 * 60 * 60_000;
// The workflow publishes within a day of an upstream release, so a newer release that is still
// not built means the sync is stuck rather than merely late
const BEHIND_GRACE = 36 * 60 * 60_000;
// Flag forks that publish nothing at all for a long time, which also covers the schedule dying
const STALE_AFTER = 30 * 24 * 60 * 60_000;

interface WorkflowRun {
    id: number;
    conclusion: string | null;
    html_url: string;
}

interface RanJob {
    steps?: { name: string; conclusion: string | null; }[];
}

interface Release {
    body?: string | null;
    updated_at?: string;
}

const api = (path: string) => fetch(`https://api.github.com/repos/${gitRemote}${path}`, {
    headers: { Accept: "application/vnd.github+json" }
});

// Only the newest completed run is reported once per session. A fix resets the state, so the
// next failure prompts again.
let notifiedRunId: number | null = null;
let initialTimeout: ReturnType<typeof setTimeout>;
let interval: ReturnType<typeof setInterval>;

const openUrl = (url: string) => IS_WEB
    ? void window.open(url, "_blank")
    : void VencordNative.native.openExternal(url);

const notify = (title: string, body: string, url: string) => {
    showNotification({
        title,
        body,
        // A timed toast can be missed, and this is the one telling you why updates stopped
        permanent: true,
        noPersist: true,
        onClick: () => openUrl(url)
    }).catch(err => logger.error("Failed to show a notification", err));
};

const parseVersion = (tag: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
    return match ? match.slice(1).map(Number) : null;
};

const compareVersions = (a: string, b: string) => {
    const va = parseVersion(a);
    const vb = parseVersion(b);
    if (!va || !vb) return 0;

    for (let i = 0; i < va.length; i++) {
        if (va[i] !== vb[i]) return va[i] - vb[i];
    }
    return 0;
};

async function describeFailure(runId: number) {
    const res = await api(`/actions/runs/${runId}/jobs`);
    if (!res.ok) return "The latest run failed.";

    const { jobs } = await res.json() as { jobs: RanJob[]; };
    for (const job of jobs) {
        const step = job.steps?.find(s => s.conclusion === "failure");
        if (!step) continue;

        if (step.name === "Sync with upstream release")
            return "The upstream sync failed, so the new release was not merged. This is almost always a rebase conflict that has to be resolved by hand.";
        return `The build failed at "${step.name}".`;
    }

    return "The latest run failed.";
}

async function checkLatestRun() {
    const res = await api("/actions/workflows/build.yml/runs?branch=main&status=completed&per_page=1");

    if (res.status === 403) {
        logger.warn("GitHub API rate limit reached, skipping this check");
        return false;
    }
    if (!res.ok) throw new Error(`GitHub API responded with ${res.status}`);

    const { workflow_runs: [run] } = await res.json() as { workflow_runs: WorkflowRun[]; };
    if (!run) return false;

    if (run.conclusion !== "failure" && run.conclusion !== "timed_out") {
        notifiedRunId = null;
        return false;
    }

    if (notifiedRunId === run.id) return true;
    notifiedRunId = run.id;

    notify(
        "Vencord build failed",
        `${await describeFailure(run.id)} Until it is fixed you stay on the last build that worked. Click to open the failed run.`,
        run.html_url
    );
    return true;
}

async function newestUpstreamTag() {
    const res = await fetch(`https://api.github.com/repos/${UPSTREAM}/tags?per_page=30`, {
        headers: { Accept: "application/vnd.github+json" }
    });
    if (!res.ok) return null;

    const tags = await res.json() as { name: string; commit: { sha: string; }; }[];

    return tags
        .filter(t => parseVersion(t.name) !== null)
        .sort((a, b) => compareVersions(a.name, b.name))
        .at(-1) ?? null;
}

async function tagDate(sha: string) {
    const res = await fetch(`https://api.github.com/repos/${UPSTREAM}/commits/${sha}`, {
        headers: { Accept: "application/vnd.github+json" }
    });
    if (!res.ok) return null;

    const { commit } = await res.json() as { commit: { committer: { date: string; }; }; };
    const date = Date.parse(commit.committer.date);

    return Number.isNaN(date) ? null : date;
}

async function checkReleaseFreshness() {
    const res = await api("/releases/latest");
    if (!res.ok) return;

    const release = await res.json() as Release;
    const updated = Date.parse(release.updated_at ?? "");
    if (Number.isNaN(updated)) return;

    const newest = await newestUpstreamTag();
    if (!newest) return;

    // The workflow records the upstream ref it built from in the release body
    const built = /Upstream: (\S+)/.exec(release.body ?? "")?.[1];
    const actionsUrl = `https://github.com/${gitRemote}/actions/workflows/build.yml`;

    if (built && compareVersions(newest.name, built) > 0) {
        // Judge by how old the release is, not by when this fork last published: a tag that
        // appeared an hour ago is simply not built yet, since the workflow runs once a day
        const released = await tagDate(newest.commit.sha);
        if (released === null || Date.now() - released < BEHIND_GRACE) return;

        notify(
            "Vencord build is behind",
            `Upstream released ${newest.name} on ${new Date(released).toLocaleDateString()}, but this fork is still built from ${built}. The sync is stuck.`,
            actionsUrl
        );
        return;
    }

    const age = Date.now() - updated;
    if (age > STALE_AFTER) {
        notify(
            "No new Vencord build",
            `Nothing has been published for ${Math.round(age / 86_400_000)} days${built ? `, last from ${built}` : ""}. Either upstream has not released, or the workflow stopped running.`,
            actionsUrl
        );
    }
}

async function check() {
    // One toast at a time: a permanent notification holds up the queue until it is dismissed
    const failed = await checkLatestRun();
    if (!failed) await checkReleaseFreshness();
}

export default definePlugin({
    name: "ForkStatus",
    description: "Tells you when this build's GitHub build or upstream sync fails, or when it stops receiving upstream releases",
    tags: ["Notifications", "Utility"],
    authors: [Devs.Murpgy],

    start() {
        // Watching upstream's own CI is not actionable here
        if (gitRemote === "Vendicated/Vencord") return;

        const run = () => void check().catch(err => logger.error("Failed to check the build status", err));

        // Let Discord finish loading before hitting the network
        initialTimeout = setTimeout(run, INITIAL_DELAY);
        interval = setInterval(run, CHECK_INTERVAL);
    },

    stop() {
        clearTimeout(initialTimeout);
        clearInterval(interval);
    }
});
