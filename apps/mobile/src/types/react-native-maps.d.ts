/**
 * Types for the parts of react-native-maps BusMap uses.
 *
 * 1.26.0 (pinned in package.json) ships only its TypeScript source, no .d.ts,
 * so tsc type-checks the library itself under this repo's
 * noUncheckedIndexedAccess and fails inside node_modules. tsconfig.json points
 * "react-native-maps" here for type-checking only; Metro still bundles the
 * real package. Later versions ship declarations (dist/src/index.d.ts), so
 * this file can go when the pin is lifted.
 */
import type { Component, ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";

export interface LatLng { latitude: number; longitude: number }
export interface Region extends LatLng { latitudeDelta: number; longitudeDelta: number }

/** One rule of a Google Maps style: which features, which part of them, and what to do to it. */
export interface MapStyleElement {
  featureType?: string;
  elementType?: string;
  stylers: Record<string, string | number | boolean>[];
}

export interface MapViewProps {
  style?: StyleProp<ViewStyle>;
  /** A Google Maps style (Android and Google-provider iOS): the dark theme passes a night style. */
  customMapStyle?: MapStyleElement[];
  initialRegion?: Region;
  region?: Region;
  pitchEnabled?: boolean;
  rotateEnabled?: boolean;
  scrollEnabled?: boolean;
  zoomEnabled?: boolean;
  toolbarEnabled?: boolean;
  /** Fires while a finger drags the map (not when the map is moved from code). */
  onPanDrag?: () => void;
  children?: ReactNode;
}
export default class MapView extends Component<MapViewProps> {
  animateCamera(camera: { center?: LatLng }, opts?: { duration?: number }): void;
}

export interface MarkerProps {
  coordinate: LatLng;
  title?: string;
  description?: string;
  anchor?: { x: number; y: number };
  children?: ReactNode;
}
export class Marker extends Component<MarkerProps> {
  /** Slides the marker to a new position, natively, over `duration` ms (default 500). */
  animateMarkerToCoordinate(coordinate: LatLng, duration?: number): void;
}

export interface PolylineProps {
  coordinates: LatLng[];
  strokeColor?: string;
  strokeWidth?: number;
}
export class Polyline extends Component<PolylineProps> {}
