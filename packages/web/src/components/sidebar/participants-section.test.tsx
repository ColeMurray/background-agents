// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it } from "vitest";
import { ParticipantsSection } from "./participants-section";

expect.extend(matchers);

afterEach(cleanup);

describe("ParticipantsSection", () => {
  it("reserves participant height until initial presence synchronizes", () => {
    render(<ParticipantsSection participants={[]} presenceSynced={false} />);

    expect(screen.getByTestId("participants-skeleton")).toHaveClass("h-6", "animate-pulse");
  });

  it("renders synchronized participants", () => {
    render(
      <ParticipantsSection
        presenceSynced
        participants={[
          {
            participantId: "participant-1",
            userId: "user-1",
            name: "Ada",
            status: "active",
            lastSeen: 1,
          },
        ]}
      />
    );

    expect(screen.getByText("1 prompt engineer")).toBeInTheDocument();
    expect(screen.queryByTestId("participants-skeleton")).not.toBeInTheDocument();
  });

  it("renders nothing after an empty presence sync", () => {
    const { container } = render(<ParticipantsSection participants={[]} presenceSynced />);

    expect(container).toBeEmptyDOMElement();
  });
});
