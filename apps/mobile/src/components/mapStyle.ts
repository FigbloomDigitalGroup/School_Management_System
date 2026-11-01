import type { MapStyleElement } from "react-native-maps";

/**
 * A night style for Google Maps, in the app's warm greys rather than the stock blue-grey, so the map sits in
 * a dark screen as the cards do. Roads stay readable (they are the point of the bus map); points of interest
 * and transit labels are removed, as they are on the light map, so the route is what the eye finds.
 */
export const DARK_MAP_STYLE: MapStyleElement[] = [
  { elementType: "geometry", stylers: [{ color: "#1c1718" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#a59b9a" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#141011" }] },
  { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#3a3132" }] },
  { featureType: "administrative.land_parcel", stylers: [{ visibility: "off" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: "#1a1516" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#3a3132" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#211a1b" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#bdb3b2" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#4d4445" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#211a1b" }] },
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#f4efef" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0e1923" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#6b7a88" }] },
];
