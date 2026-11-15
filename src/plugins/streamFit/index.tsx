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

// The player box is sized to the stream and sits inside a larger stage area. Leaving the box alone
// and clearing the clipping on the way up to the stage means 100% looks exactly like before, while
// a zoomed picture is allowed to spill into the empty space around it and is only clipped by the
// stage itself.
const CSS = `
[data-vc-streamfit-open] {
    overflow: visible !important;
}
[data-vc-streamfit-stage] {
    overflow: hidden !important;
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

// Stage last applied to a video, so repeated events do not redo the same work
const appliedStages = new WeakMap<HTMLVideoElement, HTMLElement | null>();

const settings = definePluginSettings({
    unlockAspect: {
        description: "Let a zoomed stream fill the space around the player instead of being clipped to the stream's own box",
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

function clearFill(video: HTMLVideoElement) {
    for (let el = video.parentElement, depth = 0; el && depth < 24; el = el.parentElement, depth++) {
        el.removeAttribute("data-vc-streamfit-open");
        el.removeAttribute("data-vc-streamfit-stage");
    }

    appliedStages.delete(video);
}

function applyFill(video: HTMLVideoElement) {
    if (!settings.store.unlockAspect) {
        clearFill(video);
        return;
    }

    // Only the stream the user is actually watching: marking the minimap walks through Discord's
    // control overlay, which is exactly what breaks fullscreen
    const main = findStreamVideo();
    if (main && main !== video) {
        clearFill(video);
        return;
    }

    const sizer = findSizer(video);
    if (!sizer) {
        logger.warn("No inline aspect-ratio found above the video", describe(video));
        return;
    }

    const box = sizer.getBoundingClientRect();
    if (box.width < 160 || box.height < 100) {
        logger.warn("Player box has no usable size", describe(sizer));
        return;
    }

    // Fullscreen already has the whole window; there is no empty space to fill, and the markers
    // only get in the way of the fullscreen controls
    const fullscreenish = box.width >= window.innerWidth - 40 && box.height >= window.innerHeight - 140;
    if (document.fullscreenElement || fullscreenish) {
        if (appliedStages.get(video) !== null) {
            logger.info("Player is fullscreen, leaving the layout alone");
        }
        clearFill(video);
        return;
    }

    // Everything between the video and the first ancestor that is already larger than the player
    // can be allowed to show overflow; the player box itself stays exactly as it is, so 100%
    // still looks like it used to
    const chain: HTMLElement[] = [];
    let stage: HTMLElement | null = null;

    for (let el = video.parentElement, depth = 0; el && depth < 24; el = el.parentElement, depth++) {
        if (el !== sizer) {
            const rect = el.getBoundingClientRect();
            if (rect.height > box.height + 16 && rect.width >= Math.min(box.width, window.innerWidth) * 0.5 && rect.width <= window.innerWidth + 1) {
                stage = el;
                break;
            }
        }

        chain.push(el);
    }

    if (!stage) {
        if (appliedStages.get(video) !== null) {
            appliedStages.set(video, null);
            logger.warn("No larger ancestor to clip at, the zoom stays inside the player:", chain.map(describe).join(" > "));
        }
        clearFill(video);
        return;
    }

    if (appliedStages.get(video) === stage) return;
    appliedStages.set(video, stage);

    clearFill(video);
    appliedStages.set(video, stage);

    for (const el of chain) el.setAttribute("data-vc-streamfit-open", "");
    stage.setAttribute("data-vc-streamfit-stage", "");

    logger.info("zoom can overflow the player:", chain.map(describe).join(" > "), "stage:", describe(stage));
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

    // The video is contained inside the player box, so the content rect maps through that fit
    const scale = Math.min(boxWidth / videoWidth, boxHeight / videoHeight);

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
        <Menu.MenuCheckboxItem
            key="vc-streamfit-lock"
            id="vc-streamfit-lock"
            label="Lock to content"
            checked={locked}
            action={() => locked ? clearCrop(video) : fitToContent(video, true)}
        />,
        <Menu.MenuItem
            key="vc-streamfit-once"
            id="vc-streamfit-once"
            label={locked ? "Re-detect and lock content" : "Zoom to content"}
            action={() => fitToContent(video, locked)}
        />
    );
};

let layoutTimer: ReturnType<typeof setTimeout> | undefined;

function onMediaEvent(event: Event) {
    const video = event.target as HTMLVideoElement;
    if (video.tagName !== "VIDEO" || !isStream(video)) return;

    // The element resizes when Discord enters fullscreen or changes the layout; the crop was
    // computed for the old box, which is what left the picture zoomed and pushed to one side
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => {
        applyFill(video);
        if (crops.has(video)) applyCrop(video);
    }, 150);
}

function onFullscreenChange() {
    logger.info("fullscreen", document.fullscreenElement ? "entered" : "exited");

    // The transform was computed for the old box, so it has to go; the crop itself stays in the
    // map so a lock survives the trip through fullscreen
    for (const video of crops.keys()) video.style.transform = "";

    forEachStream(clearFill);

    setTimeout(() => {
        forEachStream(applyFill);
        for (const video of crops.keys()) applyCrop(video);
    }, 300);
}

let resizeTimer: ReturnType<typeof setTimeout> | undefined;

function onWindowResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => forEachStream(applyFill), 250);
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
        document.addEventListener("fullscreenchange", onFullscreenChange);

        // Only the window resizing changes the parent box; watching the video's own resize events
        // turns the fill into a layout feedback loop
        window.addEventListener("resize", onWindowResize);

        forEachStream(applyFill);
        logger.info("started");
    },

    stop() {
        document.removeEventListener("playing", onMediaEvent, true);
        document.removeEventListener("resize", onMediaEvent, true);
        document.removeEventListener("fullscreenchange", onFullscreenChange);
        window.removeEventListener("resize", onWindowResize);
        clearTimeout(layoutTimer);
        clearTimeout(resizeTimer);
        document.getElementById(STYLE_ID)?.remove();

        for (const video of crops.keys()) clearCrop(video);
        forEachStream(clearFill);
    }
});
