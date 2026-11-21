import { describe, expect, it } from "vitest";
import { DEFAULT_MAP_LOOK, parseMapLook } from "./mapLook";

// The map's look (road map or satellite, traffic on or off) as the web and the phone save it.

describe("the saved look of the map", () => {
  it("is the plain road map with no traffic when nothing was saved", () => {
    expect(parseMapLook(null)).toEqual({ base: "map", traffic: false });
    expect(parseMapLook(undefined)).toEqual({ base: "map", traffic: false });
    expect(parseMapLook("")).toEqual({ base: "map", traffic: false });
  });

  it("reads back what was saved", () => {
    expect(parseMapLook(JSON.stringify({ base: "satellite", traffic: true }))).toEqual({ base: "satellite", traffic: true });
    expect(parseMapLook(JSON.stringify({ base: "satellite", traffic: false }))).toEqual({ base: "satellite", traffic: false });
    expect(parseMapLook(JSON.stringify({ base: "map", traffic: true }))).toEqual({ base: "map", traffic: true });
  });

  it("treats a save with no word on traffic as traffic off", () => {
    expect(parseMapLook(JSON.stringify({ base: "satellite" }))).toEqual({ base: "satellite", traffic: false });
  });

  it("falls back to the plain map when what is there cannot be read", () => {
    expect(parseMapLook("{not json")).toEqual({ base: "map", traffic: false });
    expect(parseMapLook("null")).toEqual({ base: "map", traffic: false });
    expect(parseMapLook("3")).toEqual({ base: "map", traffic: false });
    // a map type this version does not draw (an older or newer app wrote it)
    expect(parseMapLook(JSON.stringify({ base: "terrain", traffic: true }))).toEqual({ base: "map", traffic: false });
  });

  it("hands back a copy, so changing an answer never changes the default", () => {
    const first = parseMapLook(null);
    first.traffic = true;
    expect(parseMapLook(null)).toEqual({ base: "map", traffic: false });
    expect(DEFAULT_MAP_LOOK).toEqual({ base: "map", traffic: false });
  });
});
