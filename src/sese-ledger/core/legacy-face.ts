// ===== 兼容门面：AutoCardUpdaterAPI 形状投影 =====
//
// S4 红线：老版状态栏 + 现版小手机产物零改动实机跑通。方法名/参数/返回结构/同步语义
// 与数据库插件公开 API 保持一致，调研锚点见方法注释。
// 条件注册策略（方案 C）：装载时未检测到真数据库 → defineProperty 别名挂 AutoCardUpdaterAPI。

import type { WorkbookJson } from './types';
import type { LedgerRuntime } from './runtime';
import { executeSqlSubset, splitStatements, stripComments } from './sql-subset';
import { projectWorkbook, resolveColumn, resolveTable, workbookSignatures, type TableModel } from './book';
import { convergeBookToTemplate, normalizeTemplate, normalizeTemplateAny } from './blueprint';
import type { SettingsStore } from './settings-store';
import { createGuards, type Guards } from './guards';
import { aiFloorOrdinalAt, writeScope } from './floor-scope';

/** 模板归一化统一口径：
 *  - v2 模板（schemaVersion:2）→ 校验 + 投影；
 *  - v1/v2 混合 workbook（sheet 带 ledgerV2，如修复链路回灌的结构）→ v1 结构校验直通（保 v2 def 不再转换）；
 *  - 纯 v1（数据库模板 JSON）→ 转换为 v2（readMode/分组/注入极简化）。 */
function normalizeForApply(tpl: unknown): { ok: boolean; errors: string[]; workbook: WorkbookJson | null } {
  if (tpl && typeof tpl === 'object' && (tpl as any).schemaVersion === 2) {
    const normalized = normalizeTemplateAny(tpl);
    return { ok: normalized.ok, errors: normalized.errors, workbook: normalized.workbook };
  }
  const raw = tpl as WorkbookJson | null;
  const sheetKeys = raw && typeof raw === 'object' ? Object.keys(raw).filter((k) => k.startsWith('sheet_')) : [];
  if (sheetKeys.length > 0 && sheetKeys.every((k) => (raw as any)[k]?.ledgerV2 && Array.isArray((raw as any)[k].ledgerV2.columns))) {
    const v1 = normalizeTemplate(raw);
    if (v1.ok && v1.template) return { ok: true, errors: [], workbook: v1.template };
    return { ok: false, errors: v1.errors, workbook: null };
  }
  const normalized = normalizeTemplateAny(tpl);
  return { ok: normalized.ok, errors: normalized.errors, workbook: normalized.workbook };
}

export interface LegacyFaceDeps {
  runtime: LedgerRuntime;
  settings: SettingsStore;
  /** 宿主聊天读取（getStoryContext / 楼层换算）。 */
  getChat(): any[];
  /** 标准模板（全局预设缺失时兜底）。 */
  standardTemplate: WorkbookJson;
  standardPresetName: string;
  /** 世界书投影刷新（lens；未接线时仅通知）。force 绕过「未变更跳过」门（显式刷新 API 语义）。 */
  refreshWorldbook?: (opts?: { force?: boolean }) => Promise<boolean>;
  /** 触发浏览器下载（exportJsonData 备份）。 */
  downloadJson?: (filename: string, value: unknown) => void;
  /** SQL 桥写入失败上报（工作台「日志」页；只在失败时调用，成功零开销）。 */
  onLog?: (entry: { level: 'error' | 'warn' | 'info'; source?: string; message: string; detail?: string }) => void;
}

// ---- 参数归一（对齐原库 parseXxxArgs 的别名容忍） ----

interface SqlArgs { sql: string; options: Record<string, any> }
function parseSqlArgs(a: unknown, b?: unknown, c?: unknown): SqlArgs {
  if (typeof a === 'string') return { sql: a, options: (b && typeof b === 'object' ? b : c && typeof c === 'object' ? c : {}) || {} };
  const o = (a && typeof a === 'object' ? a : {}) as Record<string, any>;
  const sql = o.sql ?? o.statement ?? o.query ?? '';
  const options = { ...o };
  delete options.sql; delete options.statement; delete options.query;
  return { sql: String(sql), options };
}

function rowIndexFrom(options: Record<string, any>, fallback: unknown): number {
  const raw = options.rowIndex ?? options.row ?? options.index ?? fallback;
  return Number(raw);
}

function contentRowIndexToRowId(table: TableModel, rowIndex: number): number | null {
  const ids = [...table.rows.keys()].sort((x, y) => x - y);
  const i = Math.trunc(rowIndex) - 1;
  if (i < 0 || i >= ids.length) return null;
  return ids[i];
}

function messageIndexLabel(): number {
  const chat = depsGetChat();
  return Array.isArray(chat) ? chat.length - 1 : -1;
}
let depsGetChat: () => any[] = () => [];

export function createLegacyFace(deps: LegacyFaceDeps) {
  depsGetChat = deps.getChat;
  const guards: Guards = createGuards();
  const rt = deps.runtime;
  /** 表更新回调 → 注销器（unregisterTableUpdateCallback 真注销用）。 */
  const updateCallbackDisposers = new Map<(data: WorkbookJson) => void, () => void>();

  function readyBook() {
    const book = rt.book();
    if (!book) {
      // 未建账：异步兜底建账后回调补发（小手机 3s TTL + 状态栏轮询天然容错）
      void rt.ensureSeeded();
      return null;
    }
    return book;
  }

  /** SQL 桥失败上报：只记失败（成功零开销）；detail 带 SQL 与数字参数，
   *  字符串参数以「…」代替，避免整段正文进日志。 */
  function reportSqlFailure(sql: string, params: unknown[], errors: string[], stage: string): void {
    try {
      const safeSql = String(sql ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const paramText = params.length > 0
        ? `params=[${params.map((v) => (typeof v === 'number' ? v : '…')).join(', ')}]`
        : '';
      const detail = [
        `stage=${stage}`,
        safeSql ? `sql=${safeSql}` : '',
        paramText,
        errors.length > 0 ? `errors=${errors.join('；')}` : '',
      ].filter(Boolean).join('\n');
      deps.onLog?.({
        level: 'error',
        source: '其他',
        message: `SQL 桥写入失败：${(errors.join('；') || '未知原因').slice(0, 300)}`,
        detail,
      });
    } catch (_e) { /* 上报失败不影响失败返回 */ }
  }

  /** SQL 执行公共路径：执行器即时应用 → 按执行前签名记账 → 映射返回。
   *  有错=部分应用语义（对齐原库逐句执行：成功语句保持生效，失败即中止后续）。 */
  async function runSql(sql: string, params: unknown[], options: Record<string, any>, mutation: boolean) {
    const book = readyBook();
    if (!book) {
      const err = '台账未就绪';
      reportSqlFailure(sql, params, [err], 'ready');
      return mutation ? { changes: 0, errors: [err] } : { success: false, modifiedKeys: [], appliedEdits: 0, changes: 0, errors: [err] };
    }
    // 没有可写 AI 楼层时先拒绝：executeSqlSubset 会即时改内存，先执行再报失败会留下「幽灵写入」（D2）。
    const chat = deps.getChat();
    const scope = Array.isArray(chat) ? writeScope(chat) : null;
    if (!scope) {
      const err = '当前聊天没有可写入的 AI 楼层';
      reportSqlFailure(sql, params, [err], 'scope');
      return mutation ? { changes: 0, errors: [err] } : { success: false, modifiedKeys: [], appliedEdits: 0, changes: 0, errors: [err] };
    }
    const before = workbookSignatures(book);
    const exec = executeSqlSubset(book, sql, params);
    const commit = rt.commitAppliedOps('bridge', exec.ops, before, { notify: !options.silent && !options.skipNotify && !options.isSilent && !options.suppressNotify });
    const writeErrors = commit.ok ? [] : (commit.errors.length > 0 ? commit.errors : ['写入失败（未记录到楼层）']);
    if (!exec.ok || exec.errors.length > 0) {
      const errors = [...exec.errors, ...writeErrors];
      reportSqlFailure(sql, params, errors, 'exec');
      return mutation ? { changes: 0, errors } : { success: false, modifiedKeys: commit.changedTables, appliedEdits: exec.ops.length, changes: exec.changes, errors };
    }
    if (writeErrors.length > 0) {
      reportSqlFailure(sql, params, writeErrors, 'commit');
      return mutation
        ? { changes: 0, errors: writeErrors }
        : { success: false, modifiedKeys: commit.changedTables, appliedEdits: exec.ops.length, changes: exec.changes, errors: writeErrors };
    }
    if (mutation) {
      const base: Record<string, unknown> = { changes: exec.changes, errors: [] };
      if (!options.skipChatSave && !options.skipSave && !options.isImportMode) {
        base.saved = true;
        base.messageIndex = messageIndexLabel();
      }
      return base;
    }
    const base: Record<string, unknown> = {
      success: true,
      modifiedKeys: commit.changedTables,
      appliedEdits: exec.ops.length,
      changes: exec.changes,
      errors: [],
      saved: true,
      messageIndex: messageIndexLabel(),
    };
    if (options.skipChatSave || options.skipSave || options.isImportMode) {
      delete base.saved;
      delete base.messageIndex;
    }
    return base;
  }

  function templateOfBook(): WorkbookJson | null {
    const book = rt.book();
    if (!book) return null;
    const out: WorkbookJson = { mate: { ...(book.mate as any) } };
    for (const t of book.tables.values()) {
      const sheet: any = {
        uid: t.tableId,
        name: t.name,
        content: [t.headers.slice()],
        sourceData: t.sourceData,
        updateConfig: { ...t.updateConfig },
        exportConfig: { ...t.exportConfig },
        orderNo: t.orderNo,
      };
      if (t.v2def) sheet.ledgerV2 = t.v2def;
      out[t.tableId] = sheet;
    }
    return out;
  }

  function resolveTemplateFor(options: Record<string, any>): WorkbookJson | null {
    const scope = String(options.scope || 'chat');
    const presetName = options.presetName ? String(options.presetName) : '';
    if (scope === 'global') {
      const name = presetName || deps.settings.get().defaultTemplatePreset || deps.standardPresetName;
      const preset = name === deps.standardPresetName ? deps.standardTemplate : deps.settings.loadTemplatePreset(name);
      const normalized = preset ? normalizeForApply(preset) : null;
      return (normalized && normalized.ok ? normalized.workbook : null) || deps.standardTemplate;
    }
    if (scope === 'runtime') return rt.book() ? projectWorkbook(rt.book()!) : null;
    // chat：当前蓝图，取不到回退 global
    return templateOfBook() || resolveTemplateFor({ scope: 'global' });
  }

  const face: Record<string, unknown> = {
    // ===== 读（同步） =====
    exportTableAsJson() {
      const book = readyBook();
      return book ? projectWorkbook(book) : {};
    },
    queryTableRows(options: any) {
      const book = readyBook();
      if (!book || !options || typeof options !== 'object') return null;
      try {
        const target = String(options.sheetKey || options.tableName || options.table || '');
        const table = resolveTable(book, target);
        if (!table) return null;
        const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Math.trunc(Number(options.limit)) : 100;
        const offset = Number.isFinite(Number(options.offset)) && Number(options.offset) >= 0 ? Math.trunc(Number(options.offset)) : 0;
        const columns: string[] = Array.isArray(options.columns) && options.columns.length > 0 ? options.columns.map(String) : ['*'];
        const where = (options.where && typeof options.where === 'object') ? options.where : null;
        const orderBySpec = options.orderBy || options.order;
        let rowIds = [...table.rows.keys()].sort((a, b) => a - b);
        if (where) {
          rowIds = rowIds.filter((rid) => {
            const cells = table.rows.get(rid)!;
            for (const [colRaw, expected] of Object.entries(where)) {
              const idx = resolveColumn(table, colRaw);
              if (idx < 0) return false;
              const cell = cells[idx];
              if (Array.isArray(expected)) {
                if (!expected.some((v) => String(v ?? '') === String(cell ?? ''))) return false;
              } else if (expected === null) {
                if (cell !== '' && cell !== '无' && cell !== '-') return false;
              } else if (String(expected) !== String(cell ?? '')) {
                return false;
              }
            }
            return true;
          });
        }
        const orderSpec = typeof orderBySpec === 'string'
          ? { column: orderBySpec, direction: 'ASC' as const }
          : (orderBySpec && typeof orderBySpec === 'object' ? orderBySpec : null);
        if (orderSpec && orderSpec.column) {
          const idx = resolveColumn(table, String(orderSpec.column));
          if (idx >= 0) {
            const dir = String(orderSpec.direction || 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
            rowIds.sort((a, b) => {
              const ca = table.rows.get(a)![idx];
              const cb = table.rows.get(b)![idx];
              const na = Number(ca); const nb = Number(cb);
              const cmp = (Number.isFinite(na) && Number.isFinite(nb) && ca !== '' && cb !== '') ? na - nb : String(ca ?? '').localeCompare(String(cb ?? ''), 'zh-Hans-CN');
              return cmp * dir;
            });
          }
        }
        const page = rowIds.slice(offset, offset + limit);
        // 输出列名 = 调用方请求的名字（中文口径；台账不再有第二套英文名）
        const colIndexes = columns[0] === '*' ? null : columns.map((c) => resolveColumn(table, c));
        const outColumns = colIndexes ? columns.slice() : table.headers.slice();
        const values = page.map((rid) => {
          const cells = table.rows.get(rid)!;
          return (colIndexes ? colIndexes.map((i) => (i >= 0 ? (cells[i] === '' ? null : cells[i]) : null)) : cells.map((c) => (c === '' ? null : c)));
        });
        const rows = page.map((_, r) => {
          const obj: Record<string, unknown> = {};
          outColumns.forEach((c, i) => { obj[c] = values[r][i]; });
          return obj;
        });
        return { columns: outColumns, values, rows, sql: '', limit, offset };
      } catch (_e) {
        return null;
      }
    },
    querySql(sql: string, params?: unknown[]) {
      const book = readyBook();
      if (!book) return null;
      // 只读门：executeSqlSubset 会即时 applyOp，写语句会在不记账的情况下改内存（幽灵写入）。
      // 多语句也必须逐句都是 SELECT（`SELECT …; DELETE …` 不算只读）。
      const statements = splitStatements(stripComments(String(sql || '')));
      if (statements.length === 0 || statements.some((one) => !/^SELECT\b/i.test(one.trim()))) return null;
      const exec = executeSqlSubset(book, sql, params || []);
      if (!exec.ok) return null;
      return { columns: exec.columns || [], values: (exec.rows || []).map((r) => Object.values(r)), rows: exec.rows || [] };
    },
    getStoryContext(maxTurns?: number) {
      const chat = deps.getChat();
      if (!Array.isArray(chat)) return '';
      const n = Math.max(1, Number(maxTurns) || 3);
      const picked: string[] = [];
      for (let i = chat.length - 1; i >= 0 && picked.length < n; i--) {
        const msg = chat[i];
        if (msg && msg.is_user !== true && typeof msg.mes === 'string' && msg.mes) picked.unshift(msg.mes);
      }
      return picked.join('\n\n');
    },

    // ===== 回调 =====
    // 注销表：registerTableUpdateCallback 返回注销器（runtime.onTableUpdate）；
    // unregister 从「空操作」改为真注销——状态栏/手机脚本重注入时新实例可摘掉旧闭包
    // （旧闭包无法按身份从外部摘除，由注册方把回调存父窗口、重注册前先注销旧的）。
    registerTableUpdateCallback(cb: (data: WorkbookJson) => void) {
      if (typeof cb !== 'function') return;
      const existing = updateCallbackDisposers.get(cb);
      if (existing) existing();
      updateCallbackDisposers.set(cb, rt.onTableUpdate(cb));
    },
    unregisterTableUpdateCallback(cb: unknown) {
      if (typeof cb !== 'function') return;
      const dispose = updateCallbackDisposers.get(cb as (data: WorkbookJson) => void);
      if (dispose) {
        dispose();
        updateCallbackDisposers.delete(cb as (data: WorkbookJson) => void);
      }
    },
    _notifyTableUpdate() { rt.notifyUpdate(); },
    registerTableFillStartCallback(cb: () => void) {
      if (typeof cb === 'function') rt.onFillStart(cb);
    },
    _notifyTableFillStart() { rt.notifyFillStart(); },

    // ===== SQL 写 =====
    async executeSqlBatch(a: unknown, b?: unknown, c?: unknown) {
      const { sql, options } = parseSqlArgs(a, b, c);
      if (options.params) {
        const err = 'executeSqlBatch 不支持参数化，请用 executeSqlMutation';
        reportSqlFailure(sql, [], [err], 'batch-params');
        return { success: false, modifiedKeys: [], appliedEdits: 0, changes: 0, errors: [err] };
      }
      return runSql(sql, [], options, false);
    },
    async executeSqlMutation(a: unknown, b?: unknown, c?: unknown) {
      const { sql, options } = parseSqlArgs(a, b, c);
      const params = Array.isArray(b) ? b : Array.isArray((a as any)?.params) ? (a as any).params : [];
      return runSql(sql, params, options, true);
    },
    async executeSql(a: unknown, b?: unknown, c?: unknown) {
      const { sql } = parseSqlArgs(a, b, c);
      const params = Array.isArray(b) ? b : [];
      const trimmed = sql.trim().replace(/;+$/, '');
      if (/^select\b/i.test(trimmed)) {
        const book = readyBook();
        if (!book) return null;
        const exec = executeSqlSubset(book, sql, params);
        return exec.ok ? { type: 'query', result: { columns: exec.columns || [], values: (exec.rows || []).map((r) => Object.values(r)), rows: exec.rows || [] } } : null;
      }
      return { type: 'mutation', result: await (face.executeSqlMutation as Function)(a, b, c) };
    },

    // ===== CRUD（content 下标口径） =====
    async updateCell(a: unknown, b?: unknown, c?: unknown, d?: unknown) {
      let tableName: string; let rowIndex: number; let colId: unknown; let value: unknown; let options: Record<string, any> = {};
      if (typeof a === 'string') { tableName = a; rowIndex = Number(b); colId = c; value = d; }
      else {
        const o = (a || {}) as Record<string, any>;
        tableName = String(o.tableName ?? o.table ?? o.sheetName ?? o.name ?? '');
        rowIndex = rowIndexFrom(o, b);
        colId = o.colIdentifier ?? o.column ?? o.colName ?? o.colIndex ?? o.columnIndex;
        value = o.value;
        options = o;
      }
      const book = readyBook();
      const table = book ? resolveTable(book, tableName) : null;
      if (!table) return false;
      const rowId = contentRowIndexToRowId(table, rowIndex);
      if (rowId === null) return false;
      const column = typeof colId === 'number' && Number.isInteger(colId) && colId >= 0 && colId < table.headers.length
        ? table.headers[colId]
        : String(colId);
      const commit = rt.commitOps('bridge', [{ kind: 'cell', table: table.tableId, rowId, column, value: value === null || value === undefined ? '' : String(value) }], { notify: !options.skipNotify });
      return commit.ok && commit.changedTables.length > 0;
    },
    async updateRow(a: unknown, b?: unknown, c?: unknown) {
      let tableName: string; let rowIndex: number; let data: Record<string, unknown>; let options: Record<string, any> = {};
      if (typeof a === 'string') { tableName = a; rowIndex = Number(b); data = (c || {}) as Record<string, unknown>; }
      else {
        const o = (a || {}) as Record<string, any>;
        tableName = String(o.tableName ?? o.table ?? o.sheetName ?? o.name ?? '');
        rowIndex = rowIndexFrom(o, b);
        data = (o.data ?? o.values ?? o.rowData ?? {}) as Record<string, unknown>;
        options = o;
      }
      const book = readyBook();
      const table = book ? resolveTable(book, tableName) : null;
      if (!table) return false;
      const rowId = contentRowIndexToRowId(table, rowIndex);
      if (rowId === null) return false;
      const ops = Object.entries(data || {})
        .filter(([k]) => k !== 'isImportMode')
        .map(([col, value]) => ({ kind: 'cell' as const, table: table.tableId, rowId, column: col, value: value === null || value === undefined ? '' : String(value) }));
      const commit = rt.commitOps('bridge', ops, { notify: !options.skipNotify });
      return commit.ok && commit.changedTables.length > 0;
    },
    async insertRow(a: unknown, b?: unknown) {
      let tableName: string; let data: Record<string, unknown>; let options: Record<string, any> = {};
      if (typeof a === 'string') { tableName = a; data = (b || {}) as Record<string, unknown>; }
      else {
        const o = (a || {}) as Record<string, any>;
        tableName = String(o.tableName ?? o.table ?? o.sheetName ?? o.name ?? '');
        data = (o.data ?? o.values ?? o.rowData ?? {}) as Record<string, unknown>;
        options = o;
      }
      const book = readyBook();
      const table = book ? resolveTable(book, tableName) : null;
      if (!table) return -1;
      const row: Record<string, string> = {};
      for (const [k, v] of Object.entries(data || {})) row[k] = v === null || v === undefined ? '' : String(v);
      const commit = rt.commitOps('bridge', [{ kind: 'row_insert', table: table.tableId, row }], { notify: !options.skipNotify });
      if (!commit.ok || commit.changedTables.length === 0) return -1;
      return table.rows.size;
    },
    async deleteRow(a: unknown, b?: unknown) {
      let tableName: string; let rowIndex: number; let options: Record<string, any> = {};
      if (typeof a === 'string') { tableName = a; rowIndex = Number(b); }
      else {
        const o = (a || {}) as Record<string, any>;
        tableName = String(o.tableName ?? o.table ?? o.sheetName ?? o.name ?? '');
        rowIndex = rowIndexFrom(o, b);
        options = o;
      }
      const book = readyBook();
      const table = book ? resolveTable(book, tableName) : null;
      if (!table) return false;
      const rowId = contentRowIndexToRowId(table, rowIndex);
      if (rowId === null) return false;
      const commit = rt.commitOps('bridge', [{ kind: 'row_delete', table: table.tableId, rowId }], { notify: !options.skipNotify });
      return commit.ok;
    },

    // ===== 模板与导入 =====
    async importTableAsJson(jsonString: unknown, options?: any) {
      if (typeof jsonString !== 'string' || !jsonString.trim()) return false;
      let data: WorkbookJson;
      try { data = JSON.parse(jsonString); } catch (_e) { return false; }
      const o = options || {};
      const persist = !(o.persist === false || o.mode === 'restore' || o.mode === 'runtime' || o.mode === 'runtime-only' || o.mode === 'delete-layer-restore' || o.source === 'restore');
      if (!persist) {
        const okReady = rt.isReady() || await rt.ensureSeeded();
        if (!okReady) return false;
        return rt.restoreInMemory(data);
      }
      const okReady = rt.isReady() || await rt.ensureSeeded();
      if (!okReady) return false;
      const commit = rt.commitSnapshotReplace('import', data);
      void deps.refreshWorldbook?.();
      return commit.ok;
    },
    async restoreTableAsJson(jsonString: unknown) {
      return (face.importTableAsJson as Function)(jsonString, { mode: 'restore', persist: false });
    },
    async importTemplateFromData(templateData: unknown, options?: any) {
      const o = options || {};
      const scope = o.scope === 'chat' ? 'chat' : 'global';
      let tpl: unknown = templateData;
      if (typeof tpl === 'string') {
        try { tpl = JSON.parse(tpl); } catch (_e) {
          return { success: false, scope, message: '模板 JSON 解析失败', dataMode: o.dataMode, conflictPolicy: o.conflictPolicy, deduplication: [], error: '模板 JSON 解析失败' };
        }
      }
      const normalized = normalizeForApply(tpl);
      if (!normalized.ok || !normalized.workbook) {
        return { success: false, scope, message: '模板结构校验失败：' + normalized.errors.join('；'), dataMode: o.dataMode, conflictPolicy: o.conflictPolicy, deduplication: [], error: normalized.errors.join('；') };
      }
      if (scope === 'global') {
        const presetName = String(o.presetName || '');
        if (!presetName) return { success: false, scope, message: '缺少 presetName', dataMode: o.dataMode, conflictPolicy: o.conflictPolicy, deduplication: [], error: '缺少 presetName' };
        // 预设库统一存 v2 形态（零表空白模板也合法）
        const workbook = normalized.workbook;
        const sheetKeys = Object.keys(workbook).filter((k) => k.startsWith('sheet_'));
        const allV2 = sheetKeys.every((k) => (workbook as any)[k]?.ledgerV2);
        const presetObj = allV2
          ? { schemaVersion: 2 as const, name: presetName, groups: Array.isArray((workbook.mate as any)?.ledgerGroups) ? (workbook.mate as any).ledgerGroups : [{ id: 1, name: '分组1', frequency: 1 }], tables: sheetKeys.map((k) => (workbook as any)[k].ledgerV2), ...(workbook.mate ? { mate: workbook.mate } : {}) }
          : workbook;
        await deps.settings.saveTemplatePreset(presetName, JSON.stringify(presetObj));
        return { success: true, scope, message: `预设「${presetName}」已保存`, presetName, runtimeReady: true, dataMode: o.dataMode, conflictPolicy: o.conflictPolicy, deduplication: [] };
      }
      // chat：协调器套到当前账本（加表/加列/改名认领/缺省隐藏）→ 结构直写
      const okReady = rt.isReady() || await rt.ensureSeeded();
      if (!okReady) return { success: false, scope, message: '台账未就绪', dataMode: o.dataMode, conflictPolicy: o.conflictPolicy, deduplication: [], error: '台账未就绪' };
      const book = rt.book()!;
      const report = convergeBookToTemplate(book, normalized.workbook);
      const commit = rt.commitSnapshotReplace('import', projectWorkbook(book));
      void deps.refreshWorldbook?.();
      return {
        success: commit.ok,
        scope,
        message: commit.ok ? `蓝图已同步（新增表 ${report.addedTables.length} / 新增列 ${report.addedColumns.length}）` : '写入失败',
        runtimeReady: true,
        dataMode: o.dataMode,
        conflictPolicy: o.conflictPolicy,
        deduplication: [],
      };
    },
    getTemplatePresetNames() {
      return deps.settings.listTemplatePresetNames();
    },
    getTableTemplate(options?: any) {
      return resolveTemplateFor((options || {}) as Record<string, any>);
    },
    async switchTemplatePreset(presetName: string, options?: any) {
      const o = options || {};
      const scope = o.scope === 'chat' ? 'chat' : 'global';
      if (scope === 'chat') {
        // 聊天级切换没有调用方；旧实现只改内存、不写绑定，下次装载必被旧模板收敛回去。
        // 结构真源统一走工作台「表格」页（applyBlueprint + templateBinding.set + force 刷新）。
        return { success: false, scope, message: '台账不再支持聊天级模板切换，请在「表格」页切换模板', error: 'chat-scope-removed' };
      }
      const names = deps.settings.listTemplatePresetNames();
      if (presetName !== deps.standardPresetName && !names.includes(presetName)) {
        return { success: false, scope, message: `预设「${presetName}」不存在`, error: 'preset not found' };
      }
      await deps.settings.update({ defaultTemplatePreset: presetName });
      return { success: true, scope, message: `默认预设已切换为「${presetName}」`, runtimeReady: true };
    },
    async exportJsonData() {
      const book = readyBook();
      if (!book) return false;
      try {
        const data = projectWorkbook(book);
        const chat = deps.getChat();
        const name = (Array.isArray(chat) && chat[0]?.character_name) || 'chat';
        if (deps.downloadJson) deps.downloadJson(`SeseLedger_data_${String(name)}.json`, data);
        return true;
      } catch (_e) { return false; }
    },

    // ===== 搬家 / 持久化屏障 =====
    async exportFullCheckpointAtMessageIndex(messageIndex: number) {
      const chat = deps.getChat();
      const book = readyBook();
      if (!book || !Array.isArray(chat)) return { error: '台账未就绪' };
      const aiFloor = aiFloorOrdinalAt(chat, Math.max(0, Math.min(chat.length - 1, Number(messageIndex) || 0)));
      const data = rt.bakeStateAt(aiFloor);
      if (!data) return { error: '烘焙状态失败' };
      return {
        checkpoint: { kind: 'full', createdAt: Date.now(), reason: 'relocate', data },
        isolationKey: '',
      };
    },
    hasPendingSaves() {
      return rt.pending();
    },
    async flushPendingSaves() {
      return rt.flush();
    },

    // ===== 锁 =====
    getTableLockState: (sheetKey: string) => guards.getTableLockState(sheetKey),
    setTableLockState: (sheetKey: string, state: any, opts?: any) => guards.setTableLockState(sheetKey, state, opts),
    lockTableRow: (sheetKey: string, rowIndex: number, locked?: boolean) => guards.lockTableRow(sheetKey, rowIndex, locked !== false),
    lockTableCol: (sheetKey: string, colIndex: number, locked?: boolean) => guards.lockTableCol(sheetKey, colIndex, locked !== false),
    lockTableCell: (sheetKey: string, rowIndex: number, colIndex: number, locked?: boolean) => guards.lockTableCell(sheetKey, rowIndex, colIndex, locked !== false),
    toggleTableRowLock: (sheetKey: string, rowIndex: number) => guards.toggleTableRowLock(sheetKey, rowIndex),
    toggleTableColLock: (sheetKey: string, colIndex: number) => guards.toggleTableColLock(sheetKey, colIndex),
    clearTableLocks: (sheetKey?: string) => guards.clearTableLocks(sheetKey),

    // ===== 刷新 =====
    async refreshDataAndWorldbook() {
      rt.notifyUpdate();
      const refreshed = await deps.refreshWorldbook?.({ force: true });
      return refreshed !== false;
    },
    async syncWorldbookEntries(_options?: any) {
      const refreshed = await deps.refreshWorldbook?.({ force: true });
      return refreshed !== false;
    },

    // ===== 身份标识 =====
    __sese_ledger__: true,
    version: 'SeseLedger/1.0 (compat)',
  };
  return face;
}
