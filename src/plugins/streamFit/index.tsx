/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Menu } from "@webpack/common";

const logger = new Logger("StreamFit");

const STYLE_ID = "vc-streamfit-styles";

// The player is pinned to the stream's shape by an inline aspect-ratio on an ancestor. Width and
// height are taken from the parent's measured size rather than 100%: a percentage height only
// resolves when the parent has an explicit height, and when it does not the whole player
// collapses to nothing.
const CSS = `
[data-vc-streamfit-sizer] {
    aspect-ratio: auto !important;
    width: var(--vc-streamfit-w) !important;
    height: var(--vc-streamfit-h) !important;
}
[data-vc-streamfit-video] {
    object-fit: cover !important;
}
`;

interface CropState {
    // The detected content rect, as fractions of the frame
    rect: { left: number; top: number; right: number; bottom: number; };
    locked: boolean;
    // Set while watching for Discord's zoom to return to 100%, which releases a one-shot crop
    stopWatching?: () => void;
}

const crops = new Map<HTMLVideoElement, CropState>();

const settings = definePluginSettings({
    unlockAspect: {
        description: "Let the stream fill the player instead of keeping the stream's aspect ratio",
        type: OptionType.BOOLEAN,
        default: false,
        onChange: () => forEachStream(applyFill)
    },
    cutToContent: {
        description: "Add right-click actions that crop out the bars inside the stream. Requires the option above",
        type: OptionType.BOOLEAN,
        default: false
    }
});

const isStream = (video: HTMLVideoElement) =>
    video.srcObject instanceof MediaStream && video.videoWidth > 0;

function forEachStream(fn: (video: HTMLVideoElement) => void) {
    for (const video of document.querySelectorAll<HTMLVideoElement>("video")) {
        if (isStream(video)) fn(video);
    }
}

function findStreamVideo(): HTMLVideoElement | null {
    let best: HTMLVideoElement | null = null;
    let bestArea = 0;

    for (const video of document.querySelectorAll<HTMLVideoElement>("video")) {
        if (!isStream(video)) continue;

        const rect = video.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > bestArea) {
            best = video;
            bestArea = area;
        }
    }

    return best;
}

// The element whose inline aspect-ratio pins the player to the stream's shape
function findSizer(video: HTMLVideoElement) {
    for (let el = video.parentElement, depth = 0; el && depth < 12; el = el.parentElement, depth++) {
        if (el.style.aspectRatio) return el;
    }
    return null;
}

function describe(el: Element | null) {
    if (!el) return "none";

    const rect = el.getBoundingClientRect();
    return `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 60)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
}

function applyFill(video: HTMLVideoElement) {
    const sizer = findSizer(video);
    const fill = settings.store.unlockAspect;

    logger.info("fill", fill ? "on" : "off", "video", describe(video), "sizer", describe(sizer));

    if (!sizer) {
        logger.warn("No inline aspect-ratio found above the video, cannot fill the player");
        return;
    }

    if (!fill) {
        sizer.removeAttribute("data-vc-streamfit-sizer");
        sizer.style.removeProperty("--vc-streamfit-w");
        sizer.style.removeProperty("--vc-streamfit-h");
        video.removeAttribute("data-vc-streamfit-video");
        return;
    }

    const parent = sizer.parentElement;
    const width = parent?.clientWidth ?? 0;
    const height = parent?.clientHeight ?? 0;

    logger.info("sizer parent", describe(parent), "usable", width, height);

    // A parent without a real box (display: contents, or height driven by this very child) gives
    // us nothing to fill, and forcing a size would collapse the player
    if (width < 160 || height < 120) {
        logger.warn("Parent has no usable size, leaving the player alone");
        sizer.removeAttribute("data-vc-streamfit-sizer");
        video.removeAttribute("data-vc-streamfit-video");
        return;
    }

    sizer.style.setProperty("--vc-streamfit-w", `${width}px`);
    sizer.style.setProperty("--vc-streamfit-h", `${height}px`);
    sizer.setAttribute("data-vc-streamfit-sizer", "");
    video.setAttribute("data-vc-streamfit-video", "");

    requestAnimationFrame(() => {
        logger.info("after fill: video", describe(video), "sizer", describe(sizer));
    });
}

// region detection

const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

// Finds the rectangle that actually contains the picture by trimming the uniform dark rows and
// columns around it. Rows and columns are averaged, so a dark scene with a few bright pixels is
// not mistaken for letterboxing.
function detectContent(video: HTMLVideoElement) {
    const width = 128;
    const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));

    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(video, 0, 0, width, height);

    let data: Uint8ClampedArray;
    try {
        data = ctx.getImageData(0, 0, width, height).data;
    } catch (err) {
        logger.warn("Could not read the stream frames", err);
        return null;
    }

    const colAvg = new Float64Array(width);
    const rowAvg = new Float64Array(height);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
            colAvg[x] += luma;
            rowAvg[y] += luma;
        }
    }

    for (let x = 0; x < width; x++) colAvg[x] /= height;
    for (let y = 0; y < height; y++) rowAvg[y] /= width;

    const DARK = 16;

    let left = 0;
    while (left < width && colAvg[left] < DARK) left++;
    let right = width - 1;
    while (right > left && colAvg[right] < DARK) right--;

    let top = 0;
    while (top < height && rowAvg[top] < DARK) top++;
    let bottom = height - 1;
    while (bottom > top && rowAvg[bottom] < DARK) bottom--;

    const contentWidth = right - left + 1;
    const contentHeight = bottom - top + 1;

    logger.info("detected content", { left, top, right, bottom, contentWidth, contentHeight, width, height });

    if (contentWidth < width * 0.2 || contentHeight < height * 0.2) {
        logger.warn("Content rect is too small to be letterboxing");
        return null;
    }
    if (contentWidth > width * 0.98 && contentHeight > height * 0.98) {
        logger.warn("No bars found");
        return null;
    }

    return {
        left: left / width,
        top: top / height,
        right: (right + 1) / width,
        bottom: (bottom + 1) / height
    };
}

// endregion

function clearCrop(video: HTMLVideoElement) {
    const state = crops.get(video);
    state?.stopWatching?.();
    crops.delete(video);
    video.style.transform = "";
    video.removeAttribute("data-vc-streamfit-locked");
    logger.info("crop cleared");
}

function applyCrop(video: HTMLVideoElement) {
    const state = crops.get(video);
    if (!state) return;

    const boxWidth = video.clientWidth;
    const boxHeight = video.clientHeight;
    const { videoWidth, videoHeight } = video;
    if (!boxWidth || !boxHeight || !videoWidth || !videoHeight) {
        logger.warn("Cannot crop, video has no box", { boxWidth, boxHeight, videoWidth, videoHeight });
        return;
    }

    // Match however the video is currently fitted: cover when we unlocked the ratio, contain
    // otherwise. Either way the content rect is mapped into the player box first.
    const cover = settings.store.unlockAspect;
    const scale = cover
        ? Math.max(boxWidth / videoWidth, boxHeight / videoHeight)
        : Math.min(boxWidth / videoWidth, boxHeight / videoHeight);

    const renderedWidth = videoWidth * scale;
    const renderedHeight = videoHeight * scale;
    const offsetX = (boxWidth - renderedWidth) / 2;
    const offsetY = (boxHeight - renderedHeight) / 2;

    const { rect } = state;
    const contentLeft = offsetX + rect.left * renderedWidth;
    const contentRight = offsetX + rect.right * renderedWidth;
    const contentTop = offsetY + rect.top * renderedHeight;
    const contentBottom = offsetY + rect.bottom * renderedHeight;

    const contentWidth = contentRight - contentLeft;
    const contentHeight = contentBottom - contentTop;
    if (contentWidth <= 0 || contentHeight <= 0) return;

    const zoom = Math.max(boxWidth / contentWidth, boxHeight / contentHeight, 1);
    const centreX = (contentLeft + contentRight) / 2;
    const centreY = (contentTop + contentBottom) / 2;
    const translateX = -zoom * (centreX - boxWidth / 2);
    const translateY = -zoom * (centreY - boxHeight / 2);

    video.style.transformOrigin = "50% 50%";
    video.style.transform = `translate(${translateX}px, ${translateY}px) scale(${zoom})`;

    logger.info("crop applied", { zoom, translateX, translateY, boxWidth, boxHeight, contentWidth, contentHeight });
}

// The scale Discord's own zoom put on the nearest transformed ancestor
function ownZoomScale(video: HTMLVideoElement) {
    for (let el = video.parentElement, depth = 0; el && depth < 6; el = el.parentElement, depth++) {
        const { transform } = getComputedStyle(el);
        if (!transform || transform === "none") continue;

        try {
            return new DOMMatrixReadOnly(transform).a;
        } catch {
            return 1;
        }
    }
    return 1;
}

function watchForZoomOut(video: HTMLVideoElement, state: CropState) {
    const release = () => {
        // Discord resets its own transform to identity when zoomed back out. A locked crop is
        // the new 100%, so only a one-shot crop gets released here.
        if (!state.locked && crops.get(video) === state && ownZoomScale(video) <= 1.001) {
            logger.info("Zoomed back out, releasing the content crop");
            clearCrop(video);
        }
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onZoom = () => {
        clearTimeout(timer);
        timer = setTimeout(release, 350);
    };

    document.addEventListener("wheel", onZoom, true);

    state.stopWatching = () => {
        clearTimeout(timer);
        document.removeEventListener("wheel", onZoom, true);
    };
}

function fitToContent(video: HTMLVideoElement, locked: boolean) {
    if (!settings.store.unlockAspect) {
        logger.warn("Enable 'Let the stream fill the player' before cropping to content");
        return;
    }

    const rect = detectContent(video);
    if (!rect) return;

    const previous = crops.get(video);
    if (previous) clearCrop(video);

    const state: CropState = { rect, locked };
    crops.set(video, state);
    if (locked) video.setAttribute("data-vc-streamfit-locked", "");

    applyCrop(video);
    watchForZoomOut(video, state);
}

const streamContextPatch: NavContextMenuPatchCallback = (children, { target }: { target?: HTMLElement; }) => {
    if (!settings.store.cutToContent) return;

    const video = target?.querySelector("video") ?? findStreamVideo();
    if (!video || !isStream(video)) {
        logger.warn("Could not find the stream video for this menu");
        return;
    }

    const locked = crops.get(video)?.locked === true;

    children.push(
        <Menu.MenuSeparator key="vc-streamfit-sep" />,
        <Menu.MenuItem
            id="vc-streamfit-once"
            label={locked ? "Re-detect and lock content" : "Zoom to content"}
            action={() => fitToContent(video, locked)}
        />,
        <Menu.MenuItem
            id="vc-streamfit-lock"
            label={locked ? "Unlock content" : "Lock to content"}
            action={() => locked ? clearCrop(video) : fitToContent(video, true)}
        />
    );
};

function onMediaEvent(event: Event) {
    const video = event.target as HTMLVideoElement;
    if (video.tagName !== "VIDEO" || !isStream(video)) return;

    logger.info("stream video seen", describe(video));
    applyFill(video);
    if (crops.has(video)) applyCrop(video);
}

export default definePlugin({
    name: "StreamFit",
    description: "Lets streams fill the player, and can crop out the bars some streams are sent with",
    tags: ["Media", "Utility"],
    authors: [Devs.Murpgy],
    settings,

    contextMenus: {
        "stream-context": streamContextPatch
    },

    start() {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.append(style);

        // Media events do not bubble, so listen in the capture phase
        document.addEventListener("playing", onMediaEvent, true);
        document.addEventListener("resize", onMediaEvent, true);

        logger.info("started");
    },

    stop() {
        document.removeEventListener("playing", onMediaEvent, true);
        document.removeEventListener("resize", onMediaEvent, true);
        document.getElementById(STYLE_ID)?.remove();

        for (const video of crops.keys()) clearCrop(video);
        forEachStream(video => {
            video.removeAttribute("data-vc-streamfit-video");
            const sizer = findSizer(video);
            sizer?.removeAttribute("data-vc-streamfit-sizer");
            sizer?.style.removeProperty("--vc-streamfit-w");
            sizer?.style.removeProperty("--vc-streamfit-h");
        });
    }
});
