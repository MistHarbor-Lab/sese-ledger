// ===== 行/列/单元格保护锁（兼容 getTableLockState 消费面） =====
//
// 口径对齐原库：rowIndex 为 content 数组下标（1 起数据行），colIndex 为表头下标（0 起），
// cells 键 `${rowIndex}:${colIndex}`。锁状态仅影响前端编辑器交互，不参与引擎写入判定。

export interface SheetLockState { rows: number[]; cols: number[]; cells: string[] }

export function createGuards() {
  const locks = new Map<string, { rows: Set<number>; cols: Set<number>; cells: Set<string> }>();

  function ensure(sheetKey: string) {
    let s = locks.get(sheetKey);
    if (!s) { s = { rows: new Set(), cols: new Set(), cells: new Set() }; locks.set(sheetKey, s); }
    return s;
  }

  return {
    getTableLockState(sheetKey: string): SheetLockState | null {
      if (!sheetKey) return null;
      const s = locks.get(String(sheetKey));
      if (!s) return { rows: [], cols: [], cells: [] };
      return { rows: [...s.rows].sort((a, b) => a - b), cols: [...s.cols].sort((a, b) => a - b), cells: [...s.cells].sort() };
    },
    setTableLockState(sheetKey: string, state: Partial<SheetLockState>, opts?: { merge?: boolean }): boolean {
      if (!sheetKey || !state) return false;
      if (!opts?.merge) locks.delete(String(sheetKey));
      const s = ensure(String(sheetKey));
      for (const r of state.rows || []) if (Number.isInteger(Number(r))) s.rows.add(Number(r));
      for (const c of state.cols || []) if (Number.isInteger(Number(c))) s.cols.add(Number(c));
      for (const cell of state.cells || []) {
        const pair = Array.isArray(cell) ? cell : String(cell).split(':');
        if (pair.length >= 2 && Number.isInteger(Number(pair[0])) && Number.isInteger(Number(pair[1]))) {
          s.cells.add(`${Number(pair[0])}:${Number(pair[1])}`);
        }
      }
      return true;
    },
    lockTableRow(sheetKey: string, rowIndex: number, locked = true): boolean {
      if (!sheetKey || !Number.isInteger(Number(rowIndex)) || Number(rowIndex) < 0) return false;
      const s = ensure(String(sheetKey));
      const r = Number(rowIndex);
      if (locked) s.rows.add(r); else s.rows.delete(r);
      return true;
    },
    lockTableCol(sheetKey: string, colIndex: number, locked = true): boolean {
      if (!sheetKey || !Number.isInteger(Number(colIndex)) || Number(colIndex) < 0) return false;
      const s = ensure(String(sheetKey));
      const c = Number(colIndex);
      if (locked) s.cols.add(c); else s.cols.delete(c);
      return true;
    },
    lockTableCell(sheetKey: string, rowIndex: number, colIndex: number, locked = true): boolean {
      if (!sheetKey || !Number.isInteger(Number(rowIndex)) || !Number.isInteger(Number(colIndex))) return false;
      const s = ensure(String(sheetKey));
      const key = `${Number(rowIndex)}:${Number(colIndex)}`;
      if (locked) s.cells.add(key); else s.cells.delete(key);
      return true;
    },
    toggleTableRowLock(sheetKey: string, rowIndex: number): boolean {
      const s = ensure(String(sheetKey));
      const r = Number(rowIndex);
      if (s.rows.has(r)) s.rows.delete(r); else s.rows.add(r);
      return true;
    },
    toggleTableColLock(sheetKey: string, colIndex: number): boolean {
      const s = ensure(String(sheetKey));
      const c = Number(colIndex);
      if (s.cols.has(c)) s.cols.delete(c); else s.cols.add(c);
      return true;
    },
    clearTableLocks(sheetKey?: string): boolean {
      if (sheetKey) locks.delete(String(sheetKey));
      else locks.clear();
      return true;
    },
  };
}
export type Guards = ReturnType<typeof createGuards>;
