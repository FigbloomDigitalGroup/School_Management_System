import { noteRecordedPayment, takeRecordedPayment } from "./recordedPayment";

// The note a payment form leaves for the fees screen under it.

describe("the note a recorded payment leaves", () => {
  it("is nothing until a payment has been recorded", () => {
    expect(takeRecordedPayment()).toBeNull();
  });

  it("is read once: the screen says it, and the next time it is focused there is nothing to say", () => {
    noteRecordedPayment("KSh 6,000 recorded for Ann Wanjiru");
    expect(takeRecordedPayment()).toBe("KSh 6,000 recorded for Ann Wanjiru");
    expect(takeRecordedPayment()).toBeNull();
  });

  it("keeps only the latest when two are left before the screen looks", () => {
    noteRecordedPayment("KSh 1,000 recorded for Ann Wanjiru");
    noteRecordedPayment("KSh 2,000 recorded for Dan Otieno");
    expect(takeRecordedPayment()).toBe("KSh 2,000 recorded for Dan Otieno");
  });
});
