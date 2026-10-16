import { GEOMETRY, VALUE, baseOutline, outlineRadius, type BaseId, type Shape } from '../../shared/stones';
import { SHAPE_COLORS } from '../stage';

function polygon(sides: number, r: number, rot = 0) {
  return Array.from({ length: sides }, (_, k) => {
    const a = rot + (2 * Math.PI * k) / sides;
    return `${(r * Math.sin(a)).toFixed(3)},${(-r * Math.cos(a)).toFixed(3)}`;
  }).join(' ');
}

function outlinePoints(points: [number, number][], scale: number) {
  return points.map(([x, z]) => `${(x * scale).toFixed(3)},${(z * scale).toFixed(3)}`).join(' ');
}

/** Draw pentagons big, but never past the icon's edge. */
const fitScale = (pts: [number, number][]) => Math.min(1.15, 0.92 / Math.max(...pts.map(([x, z]) => Math.hypot(x, z))));

const PENTAGON = GEOMETRY.pentagon.kind === 'polygon' ? GEOMETRY.pentagon.points : [];

/** Top view of a base rock, scaled so the biggest base fills the box. */
export function BaseIcon({ id, size = 40, maxRadius }: { id: BaseId; size?: number; maxRadius: number }) {
  const o = baseOutline(id);
  const k = 0.95 / maxRadius;
  const style = { fill: '#55555c', stroke: '#0009', strokeWidth: 0.04 };
  return (
    <svg className="base-icon" width={size} height={size} viewBox="-1 -1 2 2" aria-label={id}>
      {o.kind === 'circle' ? <circle r={o.radius * k} {...style} /> : <polygon points={outlinePoints(o.points, k)} {...style} />}
      {/* A square stone for scale */}
      <rect x={-0.55 * k} y={-0.55 * k} width={1.1 * k} height={1.1 * k} fill="none" stroke="#e8b25c" strokeWidth={0.04} strokeDasharray="0.08 0.06" />
    </svg>
  );
}

export const maxBaseRadius = (ids: BaseId[]) => Math.max(...ids.map((id) => outlineRadius(baseOutline(id))));

/** Flat icon of a stone, as seen from above (the cube in a little 3D). */
export function StoneIcon({
  shape,
  points,
  size = 34,
  showValue = false,
}: {
  shape: Shape;
  /** A pentagon's own outline. */
  points?: [number, number][];
  size?: number;
  showValue?: boolean;
}) {
  const fill = SHAPE_COLORS[shape];
  const common = { fill, stroke: '#0008', strokeWidth: 0.06, strokeLinejoin: 'round' as const };
  return (
    <svg className="stone-icon" width={size} height={size} viewBox="-1 -1 2 2" aria-label={shape}>
      {shape === 'circle' && <circle r={0.55} {...common} />}
      {shape === 'shaft' && <rect x={-0.75} y={-0.17} width={1.5} height={0.34} rx={0.04} {...common} transform="rotate(-35)" />}
      {shape === 'triangle' && <polygon points={polygon(3, 0.85)} transform="translate(0 0.12)" {...common} />}
      {shape === 'square' && <rect x={-0.62} y={-0.62} width={1.24} height={1.24} rx={0.04} {...common} />}
      {shape === 'pentagon' && <polygon points={outlinePoints(points ?? PENTAGON, fitScale(points ?? PENTAGON))} {...common} />}
      {shape === 'cube' && (
        <g {...common}>
          <polygon points="0,-0.8 0.7,-0.4 0,0 -0.7,-0.4" style={{ filter: 'brightness(1.25)' }} />
          <polygon points="-0.7,-0.4 0,0 0,0.8 -0.7,0.4" />
          <polygon points="0.7,-0.4 0,0 0,0.8 0.7,0.4" style={{ filter: 'brightness(0.75)' }} />
        </g>
      )}
      {showValue && (
        <text x={0.62} y={0.9} fontSize={0.62} fontWeight={800} textAnchor="middle" fill="#fff" stroke="#000" strokeWidth={0.12} paintOrder="stroke">
          {VALUE[shape]}
        </text>
      )}
    </svg>
  );
}
