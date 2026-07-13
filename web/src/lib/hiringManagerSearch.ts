// LinkedIn hiring-manager search launcher. There's no accessible LinkedIn API
// for this — the real workflow is "generate the right search, open it as the
// signed-in user, capture what they find." This module builds that search.

const SENIORITY_PREFIXES = [
  "principal", "staff", "senior", "sr\\.?", "lead", "junior", "jr\\.?",
  "associate", "entry.level",
];

const SENIORITY_STRIP_RE = new RegExp(
  `^(${SENIORITY_PREFIXES.join("|")})\\s+`,
  "i",
);

// Ordered most-specific-first: a title is matched against the first entry
// whose keyword appears in it, so multi-word keywords must precede the
// generic single-word ones they'd otherwise be shadowed by.
const FUNCTION_LADDERS: Array<{ keywords: string[]; ladder: string[] }> = [
  { keywords: ["data scientist", "data science"], ladder: ["Data Science Manager", "Director of Data Science", "VP Data Science"] },
  { keywords: ["data engineer"], ladder: ["Data Engineering Manager", "Director of Data Engineering", "VP Data"] },
  { keywords: ["ml engineer", "machine learning", "ai engineer"], ladder: ["ML Engineering Manager", "Director of Machine Learning", "VP AI"] },
  { keywords: ["software engineer", "swe", "developer", "backend", "front end", "frontend", "full stack", "fullstack"], ladder: ["Engineering Manager", "Director of Engineering", "VP Engineering"] },
  { keywords: ["product manager", "product management"], ladder: ["Group Product Manager", "Director of Product", "VP Product"] },
  { keywords: ["designer", "design"], ladder: ["Design Manager", "Director of Design", "VP Design"] },
  { keywords: ["marketing"], ladder: ["Marketing Manager", "Director of Marketing", "VP Marketing"] },
  { keywords: ["sales", "account executive"], ladder: ["Sales Manager", "Director of Sales", "VP Sales"] },
  { keywords: ["finance", "accounting"], ladder: ["Finance Manager", "Director of Finance", "VP Finance"] },
  { keywords: ["operations"], ladder: ["Operations Manager", "Director of Operations", "VP Operations"] },
  { keywords: ["people", "human resources", "recruit"], ladder: ["People Manager", "Director of People", "VP People"] },
  { keywords: ["legal", "counsel"], ladder: ["Legal Manager", "Director of Legal", "General Counsel"] },
  { keywords: ["security"], ladder: ["Security Manager", "Director of Security", "VP Security"] },
];

const DEFAULT_LADDER = ["Hiring Manager", "Director", "VP"];

// "Senior AI Engineer" -> "ai engineer". Only strips one seniority prefix —
// "Senior Staff Engineer" -> "staff engineer", not bare "engineer".
export function stripSeniority(title: string): string {
  return title.trim().replace(SENIORITY_STRIP_RE, "").trim();
}

// Ordered, most-likely-first candidate titles for whoever this role reports
// to. Falls back to a generic ladder when the role's function isn't recognized
// — so an un-enriched or unusual title still gets a usable starting point.
export function inferManagerTitles(roleTitle: string): string[] {
  const stripped = stripSeniority(roleTitle).toLowerCase();
  for (const { keywords, ladder } of FUNCTION_LADDERS) {
    if (keywords.some((k) => stripped.includes(k))) return ladder;
  }
  return DEFAULT_LADDER;
}

// A LinkedIn people-search URL for a title at a company. Kept to a plain
// `keywords` query (no company URN / filter param) since that requires a
// LinkedIn-internal id we have no way to look up — this mirrors typing the
// same query into LinkedIn's own search bar, run as the signed-in user so
// their real network (2nd-degree, mutual connections) is what's reflected.
export function buildLinkedInSearchUrl(title: string, companyName: string): string {
  const keywords = [title, companyName].filter((s) => s && s.trim()).join(" ");
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;
}
