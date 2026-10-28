/**
 * Extensions the media renderer owns, shared with the panel dispatcher.
 *
 * Only formats the built-in Chromium engine can actually decode are listed —
 * `mkv`, `avi` and `3gp` are not, and claiming them would promise a player that
 * shows a black frame. Those keep going to the system player.
 */

/** Images: `<img>` does all of it. SVG renders in an `<img>` context, so its
 *  scripts and external references never run — that is the safe way to show it. */
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'];

/** Progressive/MP4-family containers Chromium demuxes. Codec is a separate
 *  question (H.264 plays, HEVC usually does not) and is handled by the error
 *  state, not by shrinking this list. */
export const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'm4v'];

export const AUDIO_EXTS = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'aac'];

export const MEDIA_EXTS = [...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS];
