import { fireEvent, render, screen } from "@testing-library/react-native";
import { ChildSwitcher } from "./ChildSwitcher";

const faith = { id: "a", name: "Faith Achieng", first: "Faith" };
const samuel = { id: "b", name: "Samuel Achieng", first: "Samuel" };
const tint = "#7A1F2B";

describe("ChildSwitcher", () => {
  it("shows each child's initials, so a parent never wonders whose figures these are", () => {
    render(<ChildSwitcher children={[faith, samuel]} index={0} onChange={() => {}} tint={tint} />);
    expect(screen.getByText("FA")).toBeTruthy();
    expect(screen.getByText("SA")).toBeTruthy();
  });

  it("marks only the child being shown as selected", () => {
    render(<ChildSwitcher children={[faith, samuel]} index={1} onChange={() => {}} tint={tint} />);
    expect(screen.getByRole("button", { name: "Samuel Achieng", selected: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Faith Achieng", selected: true })).toBeNull();
  });

  it("switches to the other child when its button is tapped", () => {
    const onChange = jest.fn();
    render(<ChildSwitcher children={[faith, samuel]} index={0} onChange={onChange} tint={tint} />);
    fireEvent.press(screen.getByRole("button", { name: "Samuel Achieng" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it("shows one initial for a one-word name, not the word 'undefined'", () => {
    render(<ChildSwitcher children={[{ id: "c", name: "Wanjiru", first: "Wanjiru" }]} index={0} onChange={() => {}} tint={tint} />);
    expect(screen.getByText("W")).toBeTruthy();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });
});
