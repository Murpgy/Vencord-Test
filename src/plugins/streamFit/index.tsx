/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { ContextMenuApi, Menu } from "@webpack/common";

const logger = new Logger("StreamFit");

const STYLE_ID = "vc-streamfit-styles";

// Discord sizes the player from the stream's own aspect ratio (inline aspect-ratio on an
// ancestor) and clips the zoomed video inside a wrapper of the same size. Forcing those two
// attributes is enough to let the stream fill the player and crop instead of letterboxing.
const CSS = `
[data-vc-streamfit-sizer] {
    aspect-ratio: auto !important;
    height: 100% !important;
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
        default: false,
        onChange: () => {
            if (settings.store.cutToContent) installContextMenu();
            else removeContextMenu();
        }
    }
});

const isStream = (video: HTMLVideoElement) =>
    video.srcObject instanceof MediaStream && video.videoWidth > 0;

function forEachStream(fn: (video: HTMLVideoElement) => void) {
    for (const video of document.querySelectorAll<HTMLVideoElement>("video")) {
        if (isStream(video)) fn(video);
    }
}

// The element whose inline aspect-ratio pins the player to the stream's shape
function findSizer(video: HTMLVideoElement) {
    for (let el = video.parentElement, depth = 0; el && depth < 10; el = el.parentElement, depth++) {
        if (el.style.aspectRatio) return el;
    }
    return null;
}

function applyFill(video: HTMLVideoElement) {
    const sizer = findSizer(video);

    if (settings.store.unlockAspect) {
        video.toggleAttribute("data-vc-streamfit-video", true);
        sizer?.toggleAttribute("data-vc-streamfit-sizer", true);
    } else {
        video.removeAttribute("data-vc-streamfit-video");
        sizer?.removeAttribute("data-vc-streamfit-sizer");
    }
}

function installStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
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

    // Refuse to crop when the "content" is most of the frame or almost none of it: that is
    // either a normally framed stream or a dark scene, not letterboxing
    if (contentWidth < width * 0.2 || contentHeight < height * 0.2) return null;
    if (contentWidth > width * 0.98 && contentHeight > height * 0.98) return null;

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
}

function applyCrop(video: HTMLVideoElement) {
    const state = crops.get(video);
    if (!state) return;

    const boxWidth = video.clientWidth;
    const boxHeight = video.clientHeight;
    const { videoWidth, videoHeight } = video;
    if (!boxWidth || !boxHeight || !videoWidth || !videoHeight) return;

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

    // Scale the content up until it covers the player box, then pull its centre onto the
    // player's centre. Never scale below 1: cropping out bars should not zoom out.
    const zoom = Math.max(boxWidth / contentWidth, boxHeight / contentHeight, 1);
    const centreX = (contentLeft + contentRight) / 2;
    const centreY = (contentTop + contentBottom) / 2;
    const translateX = -zoom * (centreX - boxWidth / 2);
    const translateY = -zoom * (centreY - boxHeight / 2);

    video.style.transformOrigin = "50% 50%";
    video.style.transform = `translate(${translateX}px, ${translateY}px) scale(${zoom})`;
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
    if (!rect) {
        logger.info("No bars found, leaving the stream as it is");
        return;
    }

    logger.info("Content rect:", rect);

    const previous = crops.get(video);
    if (previous) clearCrop(video);

    const state: CropState = { rect, locked };
    crops.set(video, state);
    if (locked) video.setAttribute("data-vc-streamfit-locked", "");

    applyCrop(video);
    watchForZoomOut(video, state);
}

// region context menu

function StreamFitMenu({ video }: { video: HTMLVideoElement }) {
    const locked = crops.get(video)?.locked === true;

    return (
        <Menu.Menu navId="vc-streamfit" onClose={ContextMenuApi.closeContextMenu}>
            <Menu.MenuItem
                id="vc-streamfit-once"
                label={locked ? "Re-detect and lock content" : "Zoom to content"}
                action={() => fitToContent(video, locked)}
            />
            <Menu.MenuItem
                id="vc-streamfit-lock"
                label={locked ? "Unlock content" : "Lock to content"}
                action={() => locked ? clearCrop(video) : fitToContent(video, true)}
            />
        </Menu.Menu>
    );
}

function onContextMenu(event: MouseEvent) {
    if (!settings.store.cutToContent) return;

    // Bound to the video itself, so currentTarget is the element Discord anchors the menu to
    const video = event.currentTarget as HTMLVideoElement;
    if (!isStream(video)) return;

    event.preventDefault();
    event.stopPropagation();

    try {
        ContextMenuApi.openContextMenu(event as any, () => <StreamFitMenu video={video} />);
    } catch (err) {
        logger.error("Could not open the stream menu", err);
    }
}

// addEventListener ignores duplicates of the same handler, so this is safe to call repeatedly
function bindVideo(video: HTMLVideoElement) {
    video.addEventListener("contextmenu", onContextMenu);
}

function unbindVideos() {
    document.querySelectorAll("video").forEach(video => {
        video.removeEventListener("contextmenu", onContextMenu);
    });
}

function installContextMenu() {
    forEachStream(bindVideo);
}

function removeContextMenu() {
    unbindVideos();
}

// endregion

function onMediaEvent(event: Event) {
    const video = event.target as HTMLVideoElement;
    if (video.tagName !== "VIDEO" || !isStream(video)) return;

    applyFill(video);
    if (settings.store.cutToContent) bindVideo(video);
    if (crops.has(video)) applyCrop(video);
}

export default definePlugin({
    name: "StreamFit",
    description: "Lets streams fill the player, and can crop out the bars some streams are sent with",
    tags: ["Media", "Utility"],
    authors: [Devs.Murpgy],
    settings,

    start() {
        installStyles();

        // Media events do not bubble, so listen in the capture phase
        document.addEventListener("playing", onMediaEvent, true);
        document.addEventListener("resize", onMediaEvent, true);

        if (settings.store.cutToContent) installContextMenu();
    },

    stop() {
        document.removeEventListener("playing", onMediaEvent, true);
        document.removeEventListener("resize", onMediaEvent, true);
        removeContextMenu();
        document.getElementById(STYLE_ID)?.remove();

        for (const video of crops.keys()) clearCrop(video);
        forEachStream(video => {
            video.removeAttribute("data-vc-streamfit-video");
            findSizer(video)?.removeAttribute("data-vc-streamfit-sizer");
        });
    }
});
