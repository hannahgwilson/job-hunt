import { describe, expect, it } from "vitest";
import { buildLinkedInSearchUrl, inferManagerTitles, stripSeniority } from "./hiringManagerSearch";

describe("stripSeniority", () => {
  it("strips a single leading seniority word", () => {
    expect(stripSeniority("Senior AI Engineer")).toBe("AI Engineer");
    expect(stripSeniority("Staff Software Engineer")).toBe("Software Engineer");
    expect(stripSeniority("Principal Product Manager")).toBe("Product Manager");
  });

  it("only strips one prefix, not chained ones", () => {
    expect(stripSeniority("Senior Staff Engineer")).toBe("Staff Engineer");
  });

  it("leaves titles with no seniority prefix untouched", () => {
    expect(stripSeniority("Product Manager")).toBe("Product Manager");
  });

  it("is case-insensitive", () => {
    expect(stripSeniority("senior data scientist")).toBe("data scientist");
  });
});

describe("inferManagerTitles", () => {
  it("maps a data science IC title to the data science ladder", () => {
    expect(inferManagerTitles("Senior Data Scientist")).toEqual([
      "Data Science Manager", "Director of Data Science", "VP Data Science",
    ]);
  });

  it("prefers the more specific data engineer ladder over the generic data one", () => {
    expect(inferManagerTitles("Senior Data Engineer")).toEqual([
      "Data Engineering Manager", "Director of Data Engineering", "VP Data",
    ]);
  });

  it("maps a software engineering title to the engineering ladder", () => {
    expect(inferManagerTitles("Staff Software Engineer")).toEqual([
      "Engineering Manager", "Director of Engineering", "VP Engineering",
    ]);
  });

  it("maps product roles to the product ladder", () => {
    expect(inferManagerTitles("Senior Product Manager")).toEqual([
      "Group Product Manager", "Director of Product", "VP Product",
    ]);
  });

  it("falls back to the generic ladder for an unrecognized function", () => {
    expect(inferManagerTitles("Chief of Staff")).toEqual(["Hiring Manager", "Director", "VP"]);
  });

  it("matches regardless of seniority prefix", () => {
    expect(inferManagerTitles("VP Marketing")).toEqual([
      "Marketing Manager", "Director of Marketing", "VP Marketing",
    ]);
  });
});

describe("buildLinkedInSearchUrl", () => {
  it("builds a people-search URL with both title and company as keywords", () => {
    const url = buildLinkedInSearchUrl("VP Engineering", "Acme Corp");
    expect(url).toBe(
      "https://www.linkedin.com/search/results/people/?keywords=VP%20Engineering%20Acme%20Corp",
    );
  });

  it("URL-encodes special characters", () => {
    const url = buildLinkedInSearchUrl("Engineering Manager", "AT&T");
    expect(url).toContain(encodeURIComponent("AT&T"));
  });

  it("omits an empty title or company rather than leaving a stray space", () => {
    expect(buildLinkedInSearchUrl("", "Acme Corp")).toBe(
      "https://www.linkedin.com/search/results/people/?keywords=Acme%20Corp",
    );
    expect(buildLinkedInSearchUrl("VP Engineering", "")).toBe(
      "https://www.linkedin.com/search/results/people/?keywords=VP%20Engineering",
    );
  });
});
