import { leftEarlyLine } from "./leftEarlyLine";

describe("leftEarlyLine", () => {
  it("names the time, the collector and the relationship", () => {
    expect(leftEarlyLine({ signed_out_local: "10:45:30", collected_by_name: "Jane Doe", collected_by_relationship: "Mother" }))
      .toBe("Left early at 10:45, collected by Jane Doe (Mother)");
  });

  it("never carries the collector's ID number or phone", () => {
    const row = { signed_out_local: "09:05:00", collected_by_name: "Jo", collected_by_relationship: "Uncle", id_number: "12345678", phone: "0712345678" };
    const line = leftEarlyLine(row);
    expect(line).not.toContain("12345678");
    expect(line).not.toContain("0712345678");
  });
});
