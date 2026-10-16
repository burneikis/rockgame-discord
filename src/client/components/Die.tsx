const PIPS: Record<number, [number, number][]> = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [2, 0], [0, 2], [2, 2]],
  5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
  6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
};

/** A die face; while rolling it tumbles and flickers through random faces. */
export function Die({ value, rolling, face }: { value: number | null; rolling: boolean; face: number }) {
  const shown = rolling ? face : value;
  return (
    <div className={`die${rolling ? ' rolling' : ''}${shown ? '' : ' blank'}`}>
      {shown &&
        PIPS[shown].map(([x, y], i) => <span key={i} className="pip" style={{ gridColumn: x + 1, gridRow: y + 1 }} />)}
    </div>
  );
}
