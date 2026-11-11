export interface Startup {
  description: string;
  sectors: ("climate" | "health" | "fintech" | "software" | "education")[];
  stage: "pre-seed" | "seed" | "series-a" | "series-b" | "growth" | null;
  geography: "uk" | "us" | "india" | "europe" | null;
}
export interface MatchBasis {
  eligible: boolean;
  sectors: string[];
  stage: string | null;
  geography: string | null;
  recent: boolean;
  unknowns: string[];
}

/** Self-contained and shared verbatim with the static browser. No network or inference beyond this vocabulary. */
export function extractFundingStartup(description: string): Startup {
  if (
    description.length < 15 ||
    description.length > 1000 ||
    /[\x00-\x1f\x7f]/.test(description)
  )
    throw new Error("Describe the startup in one line of 15–1000 characters.");
  const sectors = {
    climate: /\b(climate|clean.?tech|carbon|renewable|solar|decarboni[sz])\w*/i,
    health: /\b(health|medical|biotech|therapeutic|clinical)\w*/i,
    fintech: /\b(fintech|payments?|banking|financial)\w*/i,
    software: /\b(software|saas|developer|devtools)\b/i,
    education: /\b(education|edtech|learning)\b/i,
  };
  const stages = [
    "pre-seed",
    "seed",
    "series-a",
    "series-b",
    "growth",
  ] as const;
  const geographies = {
    uk: /\b(uk|united kingdom|britain|london)\b/i,
    us: /\b(us|usa|united states|american)\b/i,
    india: /\bindia\b/i,
    europe: /\b(europe|european|eu)\b/i,
  };
  const stageHits = stages.filter((s) =>
    new RegExp(`\\b${s.replace("-", "[ -]")}\\b`, "i").test(description),
  );
  const explicit = stageHits.includes("pre-seed")
    ? stageHits.filter((s) => s !== "seed")
    : stageHits;
  const geoHits = (
    Object.keys(geographies) as (keyof typeof geographies)[]
  ).filter((g) => geographies[g].test(description));
  return {
    description,
    sectors: (Object.keys(sectors) as (keyof typeof sectors)[]).filter((s) =>
      sectors[s].test(description),
    ),
    stage: explicit.length === 1 ? explicit[0]! : null,
    geography: geoHits.length === 1 ? geoHits[0]! : null,
  };
}

/** Match the startup only against already established snapshot facts; never discover new investors. */
export function scoreInvestor(startup: Startup, basis: MatchBasis) {
  const reasons: string[] = [],
    unknowns = [...basis.unknowns];
  let score = 0;
  if (basis.eligible) {
    score = 30;
    reasons.push(
      "+30: primary investment evidence identifies this investor and company.",
    );
    const overlap = startup.sectors.filter((s) => basis.sectors.includes(s));
    if (overlap.length) {
      score += 35;
      reasons.push(`+35: evidenced sector overlap (${overlap.join(", ")}).`);
    } else
      unknowns.push(
        startup.sectors.length
          ? "No evidenced sector overlap."
          : "Startup sector is unspecified.",
      );
    if (startup.stage && basis.stage === startup.stage) {
      score += 20;
      reasons.push(`+20: historical investment at ${startup.stage}.`);
    } else
      unknowns.push("Comparable investment stage is unknown or different.");
    if (startup.geography && basis.geography === startup.geography) {
      score += 10;
      reasons.push(`+10: evidenced geography (${startup.geography}).`);
    } else
      unknowns.push("Comparable investment geography is unknown or different.");
    if (basis.recent) {
      score += 5;
      reasons.push("+5: dated investment within two years.");
    }
  }
  return { score, reasons, unknowns };
}
