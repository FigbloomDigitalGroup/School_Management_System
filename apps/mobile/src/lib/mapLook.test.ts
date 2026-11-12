import { createMapLookStore, MAP_LOOK_KEY } from "./mapLook";

// The map's look (road map or satellite, traffic on or off), held once for every map on the phone and remembered.

/** A phone's storage holding what was chosen last time (or nothing). */
function storageWith(saved: string | null) {
  const items = new Map<string, string>(saved == null ? [] : [[MAP_LOOK_KEY, saved]]);
  return {
    items,
    getItem: jest.fn(async (key: string) => items.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => { items.set(key, value); }),
  };
}

/** Lets the read of the saved look come back. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the map's look on this phone", () => {
  it("is the plain road map, and the phone's storage is not read until a map asks", () => {
    const storage = storageWith(JSON.stringify({ base: "satellite", traffic: true }));
    const store = createMapLookStore(storage);
    expect(store.get()).toEqual({ base: "map", traffic: false });
    expect(storage.getItem).not.toHaveBeenCalled();
  });

  it("reads what was chosen last time when the first map asks, once, and tells every map", async () => {
    const storage = storageWith(JSON.stringify({ base: "satellite", traffic: true }));
    const store = createMapLookStore(storage);
    const first = jest.fn();
    const second = jest.fn();
    store.subscribe(first);
    store.subscribe(second);
    await settle();

    expect(store.get()).toEqual({ base: "satellite", traffic: true });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.getItem).toHaveBeenCalledWith(MAP_LOOK_KEY);
  });

  it("says nothing when what was saved is what is already showing", async () => {
    const store = createMapLookStore(storageWith(null));
    const map = jest.fn();
    store.subscribe(map);
    const before = store.get();
    await settle();

    expect(map).not.toHaveBeenCalled();
    expect(store.get()).toBe(before); // the same object, so no map draws itself again for nothing
  });

  it("tells every map when the look changes, and saves it for next time", async () => {
    const storage = storageWith(null);
    const store = createMapLookStore(storage);
    const first = jest.fn();
    const second = jest.fn();
    store.subscribe(first);
    store.subscribe(second);
    await settle();

    store.set({ base: "satellite", traffic: false });
    expect(store.get()).toEqual({ base: "satellite", traffic: false });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(storage.items.get(MAP_LOOK_KEY)).toBe(JSON.stringify({ base: "satellite", traffic: false }));

    // and a store made later on the same phone (the next launch) starts from it
    const nextLaunch = createMapLookStore(storage);
    nextLaunch.subscribe(() => {});
    await settle();
    expect(nextLaunch.get()).toEqual({ base: "satellite", traffic: false });
  });

  it("keeps a choice made before the saved one has been read", async () => {
    const store = createMapLookStore(storageWith(JSON.stringify({ base: "satellite", traffic: true })));
    const map = jest.fn();
    store.subscribe(map); // the read starts here
    store.set({ base: "map", traffic: true }); // and the person is quicker than it
    await settle();

    expect(store.get()).toEqual({ base: "map", traffic: true });
    expect(map).toHaveBeenCalledTimes(1);
  });

  it("stops telling a map that has gone", async () => {
    const store = createMapLookStore(storageWith(null));
    const gone = jest.fn();
    const stays = jest.fn();
    const leave = store.subscribe(gone);
    store.subscribe(stays);
    await settle();
    leave();

    store.set({ base: "map", traffic: true });
    expect(gone).not.toHaveBeenCalled();
    expect(stays).toHaveBeenCalledTimes(1);
  });

  it("still shows and changes the map on a phone whose storage cannot be read or written", async () => {
    const broken = {
      getItem: jest.fn(async () => { throw new Error("storage is full"); }),
      setItem: jest.fn(async () => { throw new Error("storage is full"); }),
    };
    const store = createMapLookStore(broken);
    const map = jest.fn();
    store.subscribe(map);
    await settle();
    expect(store.get()).toEqual({ base: "map", traffic: false });

    store.set({ base: "satellite", traffic: true });
    await settle();
    expect(store.get()).toEqual({ base: "satellite", traffic: true });
    expect(map).toHaveBeenCalledTimes(1);
  });
});
