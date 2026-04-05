export { ENTER_ALT_SCREEN, EXIT_ALT_SCREEN, BSU, ESU, CURSOR_HOME, ERASE_SCREEN, HIDE_CURSOR, SHOW_CURSOR, parkCursor } from "./dec.js";
export { isSynchronizedOutputSupported, isTmuxCC } from "./terminal-detect.js";
export { createFrameWriter, type FrameWriter } from "./frame-writer.js";
export { AlternateScreen } from "./AlternateScreen.js";

/** Check if no-flicker mode is enabled via environment variable */
export function isNoFlickerEnabled(): boolean {
  const val = process.env.PULSEED_NO_FLICKER;
  if (!val) return false;
  return val === "1" || val.toLowerCase() === "true";
}
