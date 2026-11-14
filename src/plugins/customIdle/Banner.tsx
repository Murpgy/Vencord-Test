/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createRoot } from "@webpack/common";
import type { Root } from "react-dom/client";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

export function hideIdleBanner() {
    root?.unmount();
    container?.remove();
    root = null;
    container = null;
}

export function showIdleBanner(onGoOnline: () => void, onStayIdle: () => void) {
    if (root) return;

    // Unmount from outside React's event dispatch, otherwise React complains about
    // unmounting a root while it is still rendering
    const close = (callback: () => void) => setTimeout(() => {
        hideIdleBanner();
        callback();
    }, 0);

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    root.render(
        <div
            role="status"
            style={{
                position: "fixed",
                top: "calc(var(--custom-app-top-bar-height, 32px) + 8px)",
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 2147483647,
                boxSizing: "border-box",
                display: "flex",
                alignItems: "center",
                gap: 16,
                width: "min(640px, calc(100vw - 32px))",
                padding: "10px 12px 10px 16px",
                background: "var(--background-base-low)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 8,
                boxShadow: "0 8px 16px rgba(0, 0, 0, 0.24)",
                color: "var(--text-default)",
                fontSize: 14,
                lineHeight: "18px"
            }}
        >
            <span style={{ flexGrow: 1 }}>
                <strong style={{ color: "var(--text-strong)" }}>You're idle.</strong>{" "}
                Go online if you are back at the keyboard.
            </span>
            <button
                type="button"
                onClick={() => close(onGoOnline)}
                style={{
                    all: "unset",
                    cursor: "pointer",
                    padding: "6px 12px",
                    borderRadius: 4,
                    background: "var(--brand-500)",
                    color: "#fff",
                    fontWeight: 500,
                    whiteSpace: "nowrap"
                }}
            >
                Go online
            </button>
            <button
                type="button"
                aria-label="Stay idle"
                onClick={() => close(onStayIdle)}
                style={{
                    all: "unset",
                    cursor: "pointer",
                    padding: 4,
                    color: "var(--interactive-icon-default)",
                    fontSize: 18,
                    lineHeight: 1
                }}
            >
                &times;
            </button>
        </div>
    );
}
