import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { RefinementNotice, RefinementDifference } from "./refinement-status";

test("a failed refinement explains that live text is kept and offers Retry", () => {
  const retry = vi.fn();
  render(
    <RefinementNotice
      status="failed"
      error="503 Service unavailable"
      onRetry={retry}
      onReview={() => {}}
      pending={false}
    />,
  );
  expect(screen.getByText(/live transcript is kept/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry refinement" }));
  expect(retry).toHaveBeenCalledOnce();
});

test("review highlights the affected text and only replaces it after an explicit click", () => {
  const confirm = vi.fn();
  render(
    <RefinementDifference
      before="Today we ship Tuesday thanks"
      after="Today we ship Thursday thanks"
      onConfirm={confirm}
      pending={false}
    />,
  );
  expect(screen.getByText("Tuesday").tagName).toBe("DEL");
  expect(screen.getByText("Thursday").tagName).toBe("INS");
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Replace with refined transcript" }),
  );
  expect(confirm).toHaveBeenCalledOnce();
});
