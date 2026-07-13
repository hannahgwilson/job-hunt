import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import FindHiringManager from "./FindHiringManager";
import type { CompanyConnection } from "../lib/types";

const { fetchProspects, saveProspectContact, promoteProspectContact } = vi.hoisted(() => ({
  fetchProspects: vi.fn(),
  saveProspectContact: vi.fn(),
  promoteProspectContact: vi.fn(),
}));

vi.mock("../lib/api", () => ({ fetchProspects, saveProspectContact, promoteProspectContact }));

const PROSPECT: CompanyConnection = {
  id: "contact-1",
  name: "Jamie Rivera",
  title: "VP Engineering",
  tags: ["job-hunt", "prospect"],
  linkedin_url: "https://www.linkedin.com/in/jamie-rivera-example",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FindHiringManager", () => {
  it("pre-fills the target title from the role's inferred manager ladder, and the search link reflects it", async () => {
    fetchProspects.mockResolvedValue([]);
    render(
      <FindHiringManager organizationId="org-1" organizationName="Acme Corp" roleTitle="Senior Software Engineer" />,
    );

    const input = await screen.findByPlaceholderText(/Title to search for/i);
    expect(input).toHaveValue("Engineering Manager");

    const link = screen.getByRole("link", { name: /Search LinkedIn/i });
    expect(link).toHaveAttribute(
      "href",
      "https://www.linkedin.com/search/results/people/?keywords=Engineering%20Manager%20Acme%20Corp",
    );

    // suggestion chips for the rest of the ladder
    expect(screen.getByRole("button", { name: "Director of Engineering" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "VP Engineering" })).toBeInTheDocument();
  });

  it("clicking a suggestion chip updates the search title and URL", async () => {
    fetchProspects.mockResolvedValue([]);
    const user = userEvent.setup();
    render(
      <FindHiringManager organizationId="org-1" organizationName="Acme Corp" roleTitle="Senior Software Engineer" />,
    );

    await user.click(await screen.findByRole("button", { name: "VP Engineering" }));

    expect(screen.getByPlaceholderText(/Title to search for/i)).toHaveValue("VP Engineering");
    expect(screen.getByRole("link", { name: /Search LinkedIn/i })).toHaveAttribute(
      "href",
      "https://www.linkedin.com/search/results/people/?keywords=VP%20Engineering%20Acme%20Corp",
    );
  });

  it("saves a prospect and shows it in the list", async () => {
    fetchProspects.mockResolvedValueOnce([]).mockResolvedValueOnce([PROSPECT]);
    saveProspectContact.mockResolvedValue(PROSPECT);
    const user = userEvent.setup();

    render(<FindHiringManager organizationId="org-1" organizationName="Acme Corp" roleTitle="Senior Software Engineer" />);
    await waitFor(() => expect(fetchProspects).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "+ I found someone" }));
    await user.type(screen.getByPlaceholderText("Name"), "Jamie Rivera");
    await user.type(screen.getByPlaceholderText("Their title"), "VP Engineering");
    await user.type(screen.getByPlaceholderText("LinkedIn profile URL"), PROSPECT.linkedin_url!);
    await user.click(screen.getByRole("button", { name: "Save prospect" }));

    await waitFor(() => expect(saveProspectContact).toHaveBeenCalledWith({
      organizationId: "org-1",
      name: "Jamie Rivera",
      title: "VP Engineering",
      linkedinUrl: PROSPECT.linkedin_url,
      notes: 'Found via LinkedIn search for "Engineering Manager"',
    }));

    expect(await screen.findByText("Jamie Rivera")).toBeInTheDocument();
    expect(fetchProspects).toHaveBeenCalledTimes(2);
    // form closes and clears after a successful save
    expect(screen.queryByPlaceholderText("Name")).not.toBeInTheDocument();
  });

  it("the Save button is disabled until a name is entered", async () => {
    fetchProspects.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<FindHiringManager organizationId="org-1" organizationName="Acme Corp" />);

    await user.click(await screen.findByRole("button", { name: "+ I found someone" }));
    expect(screen.getByRole("button", { name: "Save prospect" })).toBeDisabled();

    await user.type(screen.getByPlaceholderText("Name"), "Jamie");
    expect(screen.getByRole("button", { name: "Save prospect" })).toBeEnabled();
  });

  it("shows a save error without losing the entered form data", async () => {
    fetchProspects.mockResolvedValue([]);
    saveProspectContact.mockRejectedValue(new Error("network blip"));
    const user = userEvent.setup();

    render(<FindHiringManager organizationId="org-1" organizationName="Acme Corp" />);
    await user.click(await screen.findByRole("button", { name: "+ I found someone" }));
    await user.type(screen.getByPlaceholderText("Name"), "Jamie Rivera");
    await user.click(screen.getByRole("button", { name: "Save prospect" }));

    expect(await screen.findByText("network blip")).toBeInTheDocument();
    // form stays open with the name preserved so the user doesn't retype it
    expect(screen.getByPlaceholderText("Name")).toHaveValue("Jamie Rivera");
  });

  it("prefers a title stated in the JD over the inferred ladder, and labels it distinctly", async () => {
    fetchProspects.mockResolvedValue([]);
    render(
      <FindHiringManager
        organizationId="org-1"
        organizationName="CVS Health"
        roleTitle="Senior Data Analyst"
        jdContext="This role is reporting to the SVP of Health Care Analytics."
      />,
    );

    expect(await screen.findByPlaceholderText(/Title to search for/i)).toHaveValue("SVP of Health Care Analytics");
    expect(screen.getByRole("button", { name: "from JD: SVP of Health Care Analytics" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Search LinkedIn/i })).toHaveAttribute(
      "href",
      "https://www.linkedin.com/search/results/people/?keywords=SVP%20of%20Health%20Care%20Analytics%20CVS%20Health",
    );
  });

  it("falls back to the ladder (not a bare 'Hiring Manager' guess) when the JD states no reporting line", async () => {
    fetchProspects.mockResolvedValue([]);
    render(
      <FindHiringManager organizationId="org-1" organizationName="Acme Corp" roleTitle="Chief of Staff" />,
    );

    const input = await screen.findByPlaceholderText(/Title to search for/i);
    expect(input).toHaveValue("Director");
    expect(screen.queryByRole("button", { name: /Hiring Manager/i })).not.toBeInTheDocument();
  });

  it("extracts a title live from a pasted JD line", async () => {
    fetchProspects.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<FindHiringManager organizationId="org-1" organizationName="Acme Corp" />);

    const pasteBox = await screen.findByPlaceholderText(/paste a line from the JD/i);
    await user.type(pasteBox, "You will report to the VP of Engineering.");

    expect(screen.getByPlaceholderText(/Title to search for/i)).toHaveValue("VP of Engineering");
  });

  it("doesn't clobber the title field when a pasted line has no reporting line in it", async () => {
    fetchProspects.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<FindHiringManager organizationId="org-1" organizationName="Acme Corp" roleTitle="Senior Software Engineer" />);

    const pasteBox = await screen.findByPlaceholderText(/paste a line from the JD/i);
    await user.type(pasteBox, "5+ years of experience required.");

    expect(screen.getByPlaceholderText(/Title to search for/i)).toHaveValue("Engineering Manager");
  });

  it("promotes a prospect to a confirmed contact", async () => {
    fetchProspects.mockResolvedValueOnce([PROSPECT]).mockResolvedValueOnce([]);
    promoteProspectContact.mockResolvedValue({ ...PROSPECT, tags: ["job-hunt", "professional"] });
    const user = userEvent.setup();

    render(<FindHiringManager organizationId="org-1" organizationName="Acme Corp" />);
    const item = await screen.findByText("Jamie Rivera");
    const listItem = item.closest("li")!;

    await user.click(within(listItem).getByRole("button", { name: /Mark as contact/i }));

    await waitFor(() => expect(promoteProspectContact).toHaveBeenCalledWith("contact-1"));
    await waitFor(() => expect(fetchProspects).toHaveBeenCalledTimes(2));
  });
});
