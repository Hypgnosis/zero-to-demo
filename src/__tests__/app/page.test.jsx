/**
 * Component Tests for src/app/page.jsx (App)
 *
 * Tests the 3-step UI flow with premium "Trojan Horse" dashboard:
 * upload → process → chat, including i18n, user interactions,
 * state transitions, and error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ─── Mock R3F (Canvas can't render in jsdom) ─────────────────────────
vi.mock("@react-three/fiber", () => ({
  Canvas: ({ children }) => <div data-testid="r3f-canvas">{children}</div>,
  useFrame: vi.fn(),
}));

vi.mock("@react-three/drei", () => ({
  Float: ({ children }) => <div>{children}</div>,
  Environment: () => null,
  ContactShadows: () => null,
}));

vi.mock("framer-motion", () => {
  const actual = {
    motion: {
      div: ({ children, ...props }) => {
        const { variants, initial, animate, exit, transition, whileHover, whileTap, ...domProps } = props;
        return <div {...domProps}>{children}</div>;
      },
    },
    AnimatePresence: ({ children }) => <>{children}</>,
  };
  return actual;
});

// Now import the component after mocks are set up
import App from "@/app/page";

// ─── Global Fetch Mock ───────────────────────────────────────────────
const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
  // jsdom doesn't implement scrollIntoView
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ─── Helper ───────────────────────────────────────────────────────────
function createPdfFile(name = "catalog.pdf") {
  return new File(["fake pdf"], name, { type: "application/pdf" });
}

// ─── Tests ────────────────────────────────────────────────────────────
describe("App – Navigation & Branding", () => {
  it("renders the High Archytech branding with Reshapex name", () => {
    render(<App />);
    // "Reshapex" appears in both nav and heading
    const matches = screen.getAllByText("Reshapex");
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("shows system status indicators in the nav", () => {
    render(<App />);
    expect(screen.getByText("System: Online")).toBeInTheDocument();
    expect(screen.getByText("Latency: 12ms")).toBeInTheDocument();
    expect(screen.getByText("Vector Store: Ready")).toBeInTheDocument();
  });

  it("renders the footer with strategic branding", () => {
    render(<App />);
    expect(screen.getByText(/High ArchyTech Solutions/)).toBeInTheDocument();
    expect(screen.getByText(/Autonomous Systems Division/)).toBeInTheDocument();
  });

  it("displays the 3D HA Core canvas", () => {
    render(<App />);
    expect(screen.getAllByTestId("r3f-canvas").length).toBeGreaterThan(0);
  });
});

describe("App – i18n (Bilingual)", () => {
  it("starts in English by default", () => {
    render(<App />);
    expect(screen.getByText("Deploy Intelligence Source")).toBeInTheDocument();
  });

  it("switches to Spanish when language toggle is clicked", async () => {
    render(<App />);
    const langBtn = screen.getByLabelText("Toggle language");
    await userEvent.click(langBtn);

    expect(screen.getByText("Desplegar Fuente de Inteligencia")).toBeInTheDocument();
    expect(screen.getByText("Sistema: En Línea")).toBeInTheDocument();
  });

  it("switches back to English on second toggle", async () => {
    render(<App />);
    const langBtn = screen.getByLabelText("Toggle language");
    await userEvent.click(langBtn); // → ES
    await userEvent.click(langBtn); // → EN

    expect(screen.getByText("Deploy Intelligence Source")).toBeInTheDocument();
  });
});

describe("App – Step 1: Upload", () => {
  it("renders the upload UI with premium dark aesthetic", () => {
    render(<App />);
    expect(screen.getByText("Deploy Intelligence Source")).toBeInTheDocument();
    expect(screen.getByText("Browse Files")).toBeInTheDocument();
    expect(screen.getByText(/Accepted: PDF/)).toBeInTheDocument();
  });

  it("renders step progress indicators", () => {
    const { container } = render(<App />);
    // Step dots have w-8 width, distinguishing them from status dots
    const dots = container.querySelectorAll(".rounded-full.w-8");
    expect(dots.length).toBe(3);
  });

  it("advances to step 2 when a file is selected", async () => {
    render(<App />);
    const input = document.querySelector('input[type="file"]');
    await userEvent.upload(input, createPdfFile());

    expect(screen.getByText("Document Loaded")).toBeInTheDocument();
    expect(screen.getByText("catalog.pdf")).toBeInTheDocument();
  });
});

describe("App – Step 2: Processing", () => {
  async function goToStep2() {
    render(<App />);
    const input = document.querySelector('input[type="file"]');
    await userEvent.upload(input, createPdfFile());
  }

  it("shows the Initialize Live Agent button", async () => {
    await goToStep2();
    expect(screen.getByText("Initialize Live Agent")).toBeInTheDocument();
  });

  it("shows thinking steps and processing state when deploy button is clicked", async () => {
    global.fetch.mockReturnValue(new Promise(() => {})); // hang

    await goToStep2();
    fireEvent.click(screen.getByText("Initialize Live Agent"));

    await waitFor(() => {
      expect(screen.getByText("Vectorizing...")).toBeInTheDocument();
    });
  });

  it("shows an error banner on failed upload response", async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "Missing API key" }),
    });

    await goToStep2();
    fireEvent.click(screen.getByText("Initialize Live Agent"));

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("Missing API key");
    });
  });

  it("shows an error banner on network error", async () => {
    global.fetch.mockRejectedValue(new Error("Network failed"));

    await goToStep2();
    fireEvent.click(screen.getByText("Initialize Live Agent"));

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("An unexpected error occurred during processing.");
    });
  });
});

describe("App – Step 3: Chat", () => {
  async function goToStep3() {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, chunksProcessed: 5 }),
    });

    render(<App />);
    const input = document.querySelector('input[type="file"]');
    await userEvent.upload(input, createPdfFile());
    fireEvent.click(screen.getByText("Initialize Live Agent"));

    // Wait for thinking steps + transition delay
    await waitFor(() => screen.getByText(/Agent Deployed/), { timeout: 8000 });
  }

  it("displays the chat interface with initial AI message", async () => {
    await goToStep3();

    expect(screen.getByText(/System online/)).toBeInTheDocument();
    expect(screen.getByText("Autonomous Agent")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ask a technical question...")).toBeInTheDocument();
  }, 10000);

  it("displays the source file name in the sidebar", async () => {
    await goToStep3();
    expect(screen.getByText("catalog.pdf")).toBeInTheDocument();
  }, 10000);

  it("shows Reset System button that returns to step 1", async () => {
    await goToStep3();
    fireEvent.click(screen.getByText("Reset System"));
    expect(screen.getByText("Deploy Intelligence Source")).toBeInTheDocument();
  }, 10000);

  it("sends a chat message and displays user bubble", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("AI reply"));
        controller.close();
      },
    });

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, chunksProcessed: 5 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: stream,
      });

    render(<App />);
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(fileInput, createPdfFile());
    fireEvent.click(screen.getByText("Initialize Live Agent"));
    await waitFor(() => screen.getByText(/Agent Deployed/), { timeout: 8000 });

    const chatInput = screen.getByPlaceholderText("Ask a technical question...");
    await userEvent.type(chatInput, "What is Widget A?");
    fireEvent.submit(chatInput.closest("form"));

    await waitFor(() => {
      expect(screen.getByText("What is Widget A?")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("AI reply")).toBeInTheDocument();
    });
  }, 12000);

  it("does not send an empty message", async () => {
    await goToStep3();
    global.fetch.mockClear();

    const chatInput = screen.getByPlaceholderText("Ask a technical question...");
    fireEvent.submit(chatInput.closest("form"));

    expect(global.fetch).not.toHaveBeenCalled();
  }, 10000);

  it("displays error in AI bubble when chat request fails", async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, chunksProcessed: 5 }),
      })
      .mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ error: "No catalog data" }),
      });

    render(<App />);
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(fileInput, createPdfFile());
    fireEvent.click(screen.getByText("Initialize Live Agent"));
    await waitFor(() => screen.getByText(/Agent Deployed/), { timeout: 8000 });

    const chatInput = screen.getByPlaceholderText("Ask a technical question...");
    await userEvent.type(chatInput, "test");
    fireEvent.submit(chatInput.closest("form"));

    await waitFor(() => {
      expect(screen.getByText(/Error: No catalog data/)).toBeInTheDocument();
    });
  }, 12000);
});

describe("App – Premium Design Verification", () => {
  it("uses the obsidian dark background", () => {
    const { container } = render(<App />);
    const mainDiv = container.firstChild;
    expect(mainDiv.className).toContain("bg-[#0A0A0A]");
  });

  it("renders the sales tip with gold accent", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, chunksProcessed: 5 }),
    });

    render(<App />);
    const input = document.querySelector('input[type="file"]');
    await userEvent.upload(input, createPdfFile());
    fireEvent.click(screen.getByText("Initialize Live Agent"));
    await waitFor(() => screen.getByText(/Agent Deployed/), { timeout: 8000 });

    expect(screen.getByText("Sales Rep Tip:")).toBeInTheDocument();
  }, 10000);
});
