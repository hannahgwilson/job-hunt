import { describe, expect, it } from "vitest";
import {
  buildLinkedInSearchUrl, extractStatedManagerTitle, inferManagerTitles, stripSeniority,
} from "./hiringManagerSearch";

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
    expect(inferManagerTitles("Chief of Staff")).toEqual(["Director", "VP"]);
  });

  it("matches regardless of seniority prefix", () => {
    expect(inferManagerTitles("VP Marketing")).toEqual([
      "Marketing Manager", "Director of Marketing", "VP Marketing",
    ]);
  });
});

describe("extractStatedManagerTitle", () => {
  it("extracts the title from 'reporting to the X' (the CVS example)", () => {
    expect(extractStatedManagerTitle("This role is reporting to the SVP of Health Care Analytics."))
      .toBe("SVP of Health Care Analytics");
  });

  it("extracts from 'reports to the X'", () => {
    expect(extractStatedManagerTitle("You will report to the VP of Engineering, who leads the platform org."))
      .toBe("VP of Engineering");
  });

  it("extracts from 'reporting directly to X' with no 'the'", () => {
    expect(extractStatedManagerTitle("Reporting directly to Director of Product, you will own the roadmap."))
      .toBe("Director of Product");
  });

  it("stops at the end of the string when there's no trailing punctuation", () => {
    expect(extractStatedManagerTitle("This role reports to the Head of Data Platform"))
      .toBe("Head of Data Platform");
  });

  it("returns null when the JD says nothing about a reporting line", () => {
    expect(extractStatedManagerTitle("5+ years of experience with SQL and Python required.")).toBeNull();
  });

  it("returns null for empty or missing text", () => {
    expect(extractStatedManagerTitle("")).toBeNull();
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
