import Svg, { Circle, G, Path, Rect } from "react-native-svg";

/** School-bus yellow, the same in light and dark: the map is what changes behind it, not the bus. */
export const BUS_YELLOW = "#FFC20E";
const OUTLINE = "#1B1B1B";
const GLASS = "#CFE6F5";

/**
 * The bus on the map: a yellow school bus, side on, nose to the right, on a white disc so it
 * reads against both the light map and the dark one. The ring around the disc is the route's
 * colour, so a parent with two children's buses can still tell which route this one runs.
 */
export function BusIcon({ ring, size = 44 }: { ring: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 44 44">
      <Circle cx={22} cy={22} r={20} fill="#fff" stroke={ring} strokeWidth={3} />
      {/* the bus, drawn in a 44-unit box and scaled up to fill the disc */}
      <G transform="translate(22 22) scale(1.12) translate(-22 -23.5)">
        {/* body, with the sloped nose */}
        <Path
          d="M9 17.5 A2.5 2.5 0 0 1 11.5 15 H29.5 A3 3 0 0 1 31.9 16.2 L35 21 V28 A1.5 1.5 0 0 1 33.5 29.5 H10.5 A1.5 1.5 0 0 1 9 28Z"
          fill={BUS_YELLOW}
          stroke={OUTLINE}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
        {/* windows, then the windscreen */}
        <Rect x={11} y={17.4} width={4} height={4.6} rx={0.8} fill={GLASS} />
        <Rect x={16.2} y={17.4} width={4} height={4.6} rx={0.8} fill={GLASS} />
        <Rect x={21.4} y={17.4} width={4} height={4.6} rx={0.8} fill={GLASS} />
        <Path d="M27.2 17.4 H30.4 L33 21.6 H27.2Z" fill={GLASS} />
        {/* the black stripe along the side */}
        <Rect x={9.7} y={24.2} width={24.6} height={1.5} fill={OUTLINE} />
        {/* wheels */}
        <Circle cx={15.5} cy={29.8} r={3.2} fill={OUTLINE} stroke="#fff" strokeWidth={1} />
        <Circle cx={28.5} cy={29.8} r={3.2} fill={OUTLINE} stroke="#fff" strokeWidth={1} />
        <Circle cx={15.5} cy={29.8} r={1.1} fill="#C9CED2" />
        <Circle cx={28.5} cy={29.8} r={1.1} fill="#C9CED2" />
      </G>
    </Svg>
  );
}
