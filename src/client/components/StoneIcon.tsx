import { VALUE, type Shape } from '../../shared/stones';
import { SHAPE_COLORS } from '../stage';

function polygon(sides: number, r: number, rot = 0) {
  return Array.from({ length: sides }, (_, k) => {
    const a = rot + (2 * Math.PI * k) / sides;
    return `${(r * Math.sin(a)).toFixed(3)},${(-r * Math.cos(a)).toFixed(3)}`;
  }).join(' ');
}

/** Flat icon of a stone, as seen from above (the cube in a little 3D). */
export function StoneIcon({ shape, size = 34, showValue = false }: { shape: Shape; size?: number; showValue?: boolean }) {
  const fill = SHAPE_COLORS[shape];
  const common = { fill, stroke: '#0008', strokeWidth: 0.06, strokeLinejoin: 'round' as const };
  return (
    <svg className="stone-icon" width={size} height={size} viewBox="-1 -1 2 2" aria-label={shape}>
      {shape === 'circle' && <circle r={0.55} {...common} />}
      {shape === 'shaft' && <rect x={-0.95} y={-0.17} width={1.9} height={0.34} rx={0.04} {...common} transform="rotate(-35)" />}
      {shape === 'triangle' && <polygon points={polygon(3, 0.85)} transform="translate(0 0.12)" {...common} />}
      {shape === 'square' && <rect x={-0.62} y={-0.62} width={1.24} height={1.24} rx={0.04} {...common} />}
      {shape === 'pentagon' && <polygon points={polygon(5, 0.78)} transform="translate(0 0.05)" {...common} />}
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
