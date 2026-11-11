import { isIP } from "node:net";
import { ZombieError } from "./types.js";

/** Syntax guard only: live transports must also enforce DNS and redirect boundaries. */
export function publicUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ZombieError("INVALID_URL", "Use an absolute public HTTPS URL.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const labelsValid = hostname
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if (
    value.length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !hostname.includes(".") ||
    !labelsValid ||
    hostname.length > 253 ||
    hostname.includes("..") ||
    isIP(hostname.replace(/^\[|\]$/g, "")) ||
    /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(hostname) ||
    [...url.searchParams.keys()].some(
      (key) =>
        /^(?:key|sig|authorization|session)$/i.test(key) ||
        /(?:^|[_-])(?:token|secret|password|signature|credential|auth|api[_-]?key|access[_-]?key)(?:$|[_-])/i.test(
          key,
        ),
    )
  )
    throw new ZombieError(
      "INVALID_URL",
      "Use a public HTTPS URL without credentials or access tokens.",
    );
  url.hostname = hostname;
  return url.href;
}
export function sameOrigin(left: string, right: string): boolean {
  return new URL(left).origin === new URL(right).origin;
}
