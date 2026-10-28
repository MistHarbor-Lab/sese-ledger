// ===== 数据时光机 =====
//
// 数据源 = 台账记账条目（带楼层锚点）：
// - 时间轴：条目按 at.aiFloor 分组 → 每层一行（楼层号/时间/涉及表/操作数）；只列有记账条目的层；
// - 逐格 diff：bakeStateAt(n) vs bakeStateAt(n-1) 逐表逐行逐格比对；
// - 否决 = 补偿记录（source='veto'，ops=被勾选格的反向改写 + 行删除的反向插入），
//   追加在最新楼——seq 链不可变（单写者模型），不物理改历史条目；
// - 回滚本层 = 物理裁剪该层锚点上的全部条目 + schedule 回退到上一层 + 可选用该层原文重填
//   （接线在 index.ts，用 runtime.pruneEntriesAtAnchors + scribe.runRefillForStory）；
// - 结转点（foldInfo.aiFloor：最近保留 FOLD_KEEP 条流水之前的折叠边界）之前的层不可逐格否决（条目已折进快照），只读。
import type { LedgerEntry, LedgerOp, WorkbookJson } from './types';
import type { BookModel, TableModel } from './book';
import { createBook, resolveColumn } from './book';
import type { LedgerRuntime } from './runtime';

export interface TimelineFloor {
  aiFloor: number;
  anchor: string;
  time: number;
  tables: string[];
  opCount: number;
  /** 结转点之前（条目已折叠，仅可查看快照）。 */
  folded: boolean;
}

export interface CellDiff {
  table: string;
  tableId: string;
  rowId: number;
  /** 行标签（首个非 row_id 列的值，通常是姓名）。 */
  rowLabel: string;
  column: string;
  oldValue: string;
  newValue: string;
  kind: 'cell' | 'row_insert' | 'row_delete';
}

/** 审核面板的按表折叠分组（组序＝首次出现顺序）。`items[].index` ＝原始 diffs 下标（否决勾选与全选/取消共用同一口径）。 */
export interface DiffGroup {
  table: string;
  tableId: string;
  items: { index: number; diff: CellDiff }[];
}

/** 逐格 diff → 按表分组（楼层审核按表折叠用）。 */
export function groupDiffsByTable(diffs: CellDiff[]): DiffGroup[] {
  const out: DiffGroup[] = [];
  const byKey = new Map<string, DiffGroup>();
  (diffs || []).forEach((diff, index) => {
    const key = String(diff?.tableId || diff?.table || '');
    let group = byKey.get(key);
    if (!group) {
      group = { table: String(diff?.table || diff?.tableId || ''), tableId: key, items: [] };
      byKey.set(key, group);
      out.push(group);
    }
    group.items.push({ index, diff });
  });
  return out;
}

/** 时间轴（条目按楼层分组，楼层降序）。foldBoundary=结转边界（≤ 该层的楼已折叠）。 */
export function buildFloorTimeline(entries: LedgerEntry[], foldBoundary: number | null): TimelineFloor[] {
  const byFloor = new Map<number, TimelineFloor>();
  for (const e of entries) {
    const floor = Number(e.at?.aiFloor) || 0;
    if (floor <= 0) continue;
    let item = byFloor.get(floor);
    if (!item) {
      item = { aiFloor: floor, anchor: String(e.at?.anchor || ''), time: Number(e.atTime || 0), tables: [], opCount: 0, folded: false };
      byFloor.set(floor, item);
    }
    item.time = Math.max(item.time, Number(e.atTime || 0));
    item.opCount += (e.ops || []).length;
    for (const t of e.changedTables || []) {
      if (!item.tables.includes(t)) item.tables.push(t);
    }
  }
  const floors = [...byFloor.values()].sort((a, b) => b.aiFloor - a.aiFloor);
  for (const f of floors) f.folded = foldBoundary !== null && f.aiFloor <= foldBoundary;
  return floors;
}

/** 两个全量快照的逐格 diff（表名中文展示；行增删以 kind 标记）。 */
export function diffWorkbooks(before: WorkbookJson, after: WorkbookJson): CellDiff[] {
  const out: CellDiff[] = [];
  const beforeBook = createBook(before);
  const afterBook = createBook(after);
  const tables: TableModel[] = [...afterBook.tables.values()];
  for (const key of beforeBook.tables.keys()) {
    if (!afterBook.tables.has(key)) tables.push(beforeBook.tables.get(key)!);
  }
  for (const table of tables) {
    const key = table.tableId;
    const other = beforeBook.tables.has(key) ? beforeBook : afterBook;
    const beforeTable = beforeBook.tables.get(key) || null;
    const afterTable = afterBook.tables.get(key) || null;
    const view = afterTable || beforeTable!;
    const labelIdx = view.headers.length > 1 ? 1 : 0;
    // 列对齐：以 view 表头为准，before 列按列名四路寻址
    const colIdxBefore = view.headers.map((h) => (beforeTable ? resolveColumn(beforeTable, h) : -1));
    void other;
    // 行增（after 有、before 无）
    if (afterTable) {
      for (const [rowId, afterCells] of afterTable.rows) {
        if (beforeTable && beforeTable.rows.has(rowId)) continue;
        const firstCol = afterTable.headers.length > 1 ? afterTable.headers[1] : '';
        out.push({
          table: afterTable.name, tableId: key, rowId, rowLabel: String(afterCells[labelIdx] ?? ''),
          column: firstCol, oldValue: '', newValue: '新行', kind: 'row_insert',
        });
      }
    }
    // 行删（before 有、after 无）
    if (beforeTable) {
      for (const [rowId, beforeCells] of beforeTable.rows) {
        if (afterTable && afterTable.rows.has(rowId)) continue;
        const firstCol = beforeTable.headers.length > 1 ? beforeTable.headers[1] : '';
        out.push({
          table: beforeTable.name, tableId: key, rowId, rowLabel: String(beforeCells[labelIdx] ?? ''),
          column: firstCol, oldValue: '整行', newValue: '', kind: 'row_delete',
        });
      }
    }
    // 格改
    if (beforeTable && afterTable) {
      for (const [rowId, afterCells] of afterTable.rows) {
        const beforeCells = beforeTable.rows.get(rowId);
        if (!beforeCells) continue;
        for (let i = 1; i < afterTable.headers.length; i++) {
          const bi = colIdxBefore[i];
          const bv = bi >= 0 && bi < beforeCells.length ? String(beforeCells[bi] ?? '') : '';
          const av = String(afterCells[i] ?? '');
          if (bv !== av) {
            out.push({
              table: afterTable.name, tableId: key, rowId, rowLabel: String(afterCells[labelIdx] ?? ''),
              column: afterTable.headers[i], oldValue: bv, newValue: av, kind: 'cell',
            });
          }
        }
      }
    }
  }
  return out;
}

/** 否决 → 反向补偿操作（格回旧值 / 删新行 / 复原被删行）。beforeBook=该层前一状态。 */
export function buildVetoOps(diffs: CellDiff[], beforeBook: BookModel): LedgerOp[] {
  const ops: LedgerOp[] = [];
  for (const d of diffs) {
    if (d.kind === 'row_insert') {
      ops.push({ kind: 'row_delete', table: d.tableId, rowId: d.rowId });
      continue;
    }
    if (d.kind === 'row_delete') {
      const cells = beforeBook.tables.get(d.tableId)?.rows.get(d.rowId);
      if (cells) ops.push({ kind: 'row_upsert', table: d.tableId, rowId: d.rowId, cells: cells.slice() });
      continue;
    }
    ops.push({ kind: 'cell', table: d.tableId, rowId: d.rowId, column: d.column, value: d.oldValue });
  }
  return ops;
}

export interface TimeMachineDeps {
  runtime: LedgerRuntime;
  warn(message: string): void;
}

/** 时光机服务（纯函数之上的运行时薄封装）。 */
export function createTimeMachine(deps: TimeMachineDeps) {
  const rt = deps.runtime;
  // 烘焙缓存：bakeStateAt = 快照建库 + 全量重放，逐格 diff（n vs n-1）+ 快照预览 + 导出对同一层
  // 要 bake 2~3 次；以 runtime.revision 为失效键——任何提交/裁剪都会换 revision，缓存绝不跨越数据
  // 变更（否决/回滚后自动重烘）。返回的 workbook 仅供只读消费（diff/预览/导出/否决取旧值），
  // 调用方不得就地修改。
  let bakeCache = new Map<number, WorkbookJson | null>();
  let bakeCacheRev = -1;
  function bakedAt(aiFloor: number): WorkbookJson | null {
    const rev = rt.revision();
    if (rev !== bakeCacheRev) { bakeCache = new Map(); bakeCacheRev = rev; }
    if (bakeCache.has(aiFloor)) return bakeCache.get(aiFloor) ?? null;
    const value = rt.bakeStateAt(aiFloor);
    bakeCache.set(aiFloor, value);
    return value;
  }

  /** 结转边界：条目已折叠时 = 快照折叠楼序；条目还在 = null（无折叠）。 */
  function foldBoundary(): number | null {
    const store = rt.__store();
    if (!store) return null;
    const all = store.peekEntries();
    if (all.length > 0) return null;
    return store.peekFoldInfo()?.aiFloor ?? null;
  }

  function timeline(): TimelineFloor[] {
    return buildFloorTimeline(rt.visibleEntries(), foldBoundary());
  }

  /** 相邻层 diff（n vs n-1；烘焙失败返回 null）。 */
  function diffAtFloor(aiFloor: number): CellDiff[] | null {
    const before = bakedAt(aiFloor - 1);
    const after = bakedAt(aiFloor);
    if (!before || !after) return null;
    return diffWorkbooks(before, after);
  }

  /** 否决选中项：补偿记录落最新楼。 */
  function veto(aiFloor: number, diffs: CellDiff[]): boolean {
    if (diffs.length === 0) return false;
    const before = bakedAt(aiFloor - 1);
    if (!before) {
      deps.warn('否决失败：无法还原该层之前的状态（可能已折叠）');
      return false;
    }
    const beforeBook = createBook(before);
    const ops = buildVetoOps(diffs, beforeBook);
    if (ops.length === 0) return false;
    const commit = rt.commitOps('veto', ops);
    return commit.ok;
  }

  /** 导出该层快照（JSON 下载用）。 */
  function exportFloor(aiFloor: number): WorkbookJson | null {
    return bakedAt(aiFloor);
  }

  return { foldBoundary, timeline, diffAtFloor, veto, exportFloor };
}
