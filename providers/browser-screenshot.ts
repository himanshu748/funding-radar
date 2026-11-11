/** Inactivity timeout resets on CDP traffic; it is not a nonrenewable billable lifetime. */
export const SCREENSHOT_BLOCKER = Object.freeze({
  code: "SCREENSHOT_BOUNDS_UNVERIFIED",
  source: "https://docs.tinyfish.ai/browser-api/reference",
  reason:
    "Browser documents an inactivity timeout and explicit deletion, but no nonrenewable session lifetime cap. No Browser session is created by this adapter.",
});
export type ScreenshotEvidence = {
  status: "blocked";
  code: typeof SCREENSHOT_BLOCKER.code;
};
export async function captureChangeScreenshot(): Promise<ScreenshotEvidence> {
  return { status: "blocked", code: SCREENSHOT_BLOCKER.code };
}
