import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ThreeBureauReportImport from "../ThreeBureauReportImport";

const okBody = {
  success: true,
  reportId: "rep-1",
  summary: {
    source: "identityiq",
    reportDate: "2026-09-15",
    bureaus: ["transunion", "experian", "equifax"],
    scores: { transunion: 612, experian: 598, equifax: 605 },
    accounts: 5,
    negativeAccounts: 3,
    inquiries: 3,
    publicRecords: 0,
    discrepancies: { total: 1, high: 1, medium: 0, low: 0 },
    warnings: [],
  },
  discrepancies: [
    {
      type: "late_history_mismatch",
      severity: "high",
      bureaus: ["experian"],
      description: "CAPITAL ONE: late payment reported by Experian only.",
      legalBasis: "FCRA §607(b)",
    },
  ],
};

function pickFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe("ThreeBureauReportImport", () => {
  afterEach(() => jest.restoreAllMocks());

  it("uploads the file and shows scores and dispute leads", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => okBody });
    global.fetch = fetchMock as unknown as typeof fetch;
    const onDone = jest.fn();
    render(<ThreeBureauReportImport onImportComplete={onDone} />);

    pickFile(new File(["<html></html>"], "report.html", { type: "text/html" }));

    expect(await screen.findByText("612")).toBeInTheDocument();
    expect(screen.getByText("598")).toBeInTheDocument();
    expect(screen.getByText(/late payment reported by Experian only/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/credit-bureau/import",
      expect.objectContaining({ method: "POST" }),
    );

    fireEvent.click(screen.getByText("View reports"));
    expect(onDone).toHaveBeenCalledWith("rep-1");
  });

  it("shows the server's error message", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, error: "PDF reports lose their table layout" }),
    }) as unknown as typeof fetch;
    const onError = jest.fn();
    render(<ThreeBureauReportImport onError={onError} />);

    pickFile(new File(["%PDF"], "r.pdf", { type: "application/pdf" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/PDF reports lose/),
    );
    expect(onError).toHaveBeenCalled();
  });
});
