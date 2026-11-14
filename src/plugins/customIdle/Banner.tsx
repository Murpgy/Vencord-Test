/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./banner.css";

import { createRoot } from "@webpack/common";
import type { Root } from "react-dom/client";

export interface IdleBannerOptions {
    /** Whether the prompt can be closed without going online */
    dismissable: boolean;
    onGoOnline(): void;
    onStayIdle(): void;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

export function hideIdleBanner() {
    root?.unmount();
    container?.remove();
    root = null;
    container = null;
}

/**
 * Discord's app shell is a grid with a dedicated notice area between the titlebar and the
 * channel list, which is where its own banners (like the reconnect one) render and push the
 * rest of the interface down. Find it by its grid areas rather than by class name, which is
 * hashed and changes between builds.
 */
function findNoticeGrid() {
    const start = document.getElementById("app-mount");
    if (!start) return null;

    const queue = [start];
    for (let budget = 600; queue.length && budget > 0; budget--) {
        const el = queue.shift()!;
        const style = getComputedStyle(el);

        if (style.display.includes("grid") && style.gridTemplateAreas.includes("notice"))
            return el;

        for (const child of el.children) queue.push(child as HTMLElement);
    }

    return null;
}

/** Discord's own banner lives in the same area; if one is up, do not stack on top of it */
function isNoticeAreaFree(grid: HTMLElement) {
    for (const child of grid.children) {
        if (getComputedStyle(child).gridArea.includes("notice")) return false;
    }
    return true;
}

export function showIdleBanner({ dismissable, onGoOnline, onStayIdle }: IdleBannerOptions) {
    if (root) return;

    // Unmount from outside React's event dispatch, otherwise React complains about
    // unmounting a root while it is still rendering
    const close = (callback: () => void) => setTimeout(() => {
        hideIdleBanner();
        callback();
    }, 0);

    const grid = findNoticeGrid();
    const docked = grid !== null && isNoticeAreaFree(grid);

    container = document.createElement("div");
    if (docked) {
        container.style.gridArea = "notice";
        grid!.append(container);
    } else {
        // The shell changed shape: float the prompt instead of guessing at a layout slot
        Object.assign(container.style, {
            position: "fixed",
            top: "calc(var(--custom-app-top-bar-height, 32px) + 8px)",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 2147483647,
            width: "min(640px, calc(100vw - 32px))"
        });
        document.body.append(container);
    }

    root = createRoot(container);

    root.render(
        <div role="status" className={`vc-idle-banner ${docked ? "vc-idle-banner-docked" : "vc-idle-banner-floating"}`}>
            <span>
                Welcome back! Click the button to go online.
                {dismissable && " Click the X to stay idle for now."}
            </span>
            <button type="button" className="vc-idle-banner-button" onClick={() => close(onGoOnline)}>
                Exit idle
            </button>
            {dismissable && (
                <button type="button" className="vc-idle-banner-close" aria-label="Stay idle" onClick={() => close(onStayIdle)}>
                    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                        <path
                            fill="currentColor"
                            d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
                        />
                    </svg>
                </button>
            )}
        </div>
    );
}
