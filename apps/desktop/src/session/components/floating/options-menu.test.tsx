import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateSession: vi.fn(),
}));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ i18n: { locale: "en" }, t: (value: string) => value }),
}));

vi.mock("@anlg/ui/components/ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} />
  ),
}));

vi.mock("@anlg/ui/components/ui/popover", () => ({
  AppFloatingPanel: ({ children }: { children: ReactNode }) => children,
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverContent: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@anlg/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("~/session/queries", () => ({
  updateSession: mocks.updateSession,
  useSession: () => null,
}));

vi.mock("~/shared/config", () => ({
  useConfigValue: (key: string) => (key === "ai_language" ? "en" : []),
}));

vi.mock("~/stt/useSTTConnection", () => ({
  useSTTConnection: () => ({
    conn: {
      provider: "assemblyai",
      model: "universal-3-pro",
      baseUrl: "https://api.assemblyai.com",
      apiKey: "key",
    },
  }),
}));

vi.mock("~/stt/useUploadFile", () => ({
  useUploadFile: () => ({ uploadAudio: vi.fn(), uploadTranscript: vi.fn() }),
}));

import { OptionsMenu } from "./options-menu";

describe("OptionsMenu meeting language", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateSession.mockResolvedValue(undefined);
  });

  it("persists a per-meeting multilingual override from the English default", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <OptionsMenu sessionId="session-1" disabled={false} warningMessage="">
          <button>Start listening</button>
        </OptionsMenu>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Multilingual/ }));
    fireEvent.click(screen.getByRole("button", { name: "Spanish" }));
    fireEvent.click(screen.getByRole("button", { name: /Apply multilingual/ }));

    await waitFor(() => {
      expect(mocks.updateSession).toHaveBeenCalledWith("session-1", {
        transcription: {
          provider: "assemblyai",
          model: "universal-3-pro",
          languages: ["en", "es"],
        },
      });
    });
  });
});
