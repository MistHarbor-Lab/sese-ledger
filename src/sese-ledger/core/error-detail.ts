// ===== 错误原文提取（工作台日志 / 失败提示共用） =====
//
// 背景：宿主 generateRaw 失败时抛出的错误对象，关键信息常不在 message 上——
// HTTP 状态与状态文本在 status/statusText，供应商错误体在 response/body/data，
// 网络层原因在 cause，定位调用点在 stack。旧实现一律只取 `e.message`，
// 于是工作台日志只留一行「AI 请求失败：Failed to fetch」，比酒馆/供应商那边
// 看到的错误少一截。这里统一把能拿到的都提取出来（detail 给日志，summary 给toast）。
//
// 纯函数、零依赖、绝不抛（日志链路不能因错误对象形状怪异而中断）。

/** 详情默认上限（日志层还会再按 LEDGER_LOG_DETAIL_LIMIT 截断，这里只是防御异常巨大的对象）。 */
export const ERROR_DETAIL_LIMIT = 4000;
/** 单字段（响应体 / JSON 序列化）上限：错误页 HTML 可能几十 KB。 */
const ERROR_FIELD_LIMIT = 600;
/** 摘要（单行，用于 toast / 错误清单）上限。 */
const ERROR_SUMMARY_LIMIT = 300;
/** cause 链最大深度（自引用/超长链保护）。 */
const CAUSE_MAX_DEPTH = 3;

/** 压成单行并截断（toast 与错误清单不能带换行，否则一条通知炸成多行）。 */
function oneLine(text: string, limit: number): string {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** 任意值 → 可读文本（对象走 JSON；循环引用/不可序列化回落 String）。 */
function valueText(value: unknown, limit = ERROR_FIELD_LIMIT): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return oneLine(value, limit);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'function') return '';
  try {
    const json = JSON.stringify(value);
    return json && json !== '{}' ? oneLine(json, limit) : '';
  } catch (_e) {
    try { return oneLine(String(value), limit); } catch (_e2) { return ''; }
  }
}

/** 响应体提取：兼容 `response.text` / `body` / `data` / 嵌套 error.message。 */
function responseText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return oneLine(value, ERROR_FIELD_LIMIT);
  if (typeof value !== 'object') return valueText(value);
  const node = value as Record<string, unknown>;
  for (const key of ['text', 'body', 'error', 'message', 'data', 'detail']) {
    const inner = node[key];
    if (typeof inner === 'string' && inner.trim()) return oneLine(inner, ERROR_FIELD_LIMIT);
    if (inner && typeof inner === 'object') {
      const nested = valueText(inner, ERROR_FIELD_LIMIT);
      if (nested) return nested;
    }
  }
  return valueText(value, ERROR_FIELD_LIMIT);
}

/** 状态码 / 状态文本（兼容 status、statusCode 两族命名）。 */
function statusText(error: any): string {
  const code = error?.status ?? error?.statusCode;
  const line = [code, error?.statusText].filter((v) => v !== undefined && v !== null && String(v).trim() !== '').join(' ');
  return line;
}

/**
 * 完整错误原文（多行）：消息 / 状态 / 代码 / 地址 / 响应体 / 堆栈 / cause 链。
 * 日志「详情」用它——比单行 message 多出排查所需的全部上下文。
 */
export function describeErrorDetail(error: unknown, opts: { limit?: number; includeStack?: boolean } = {}): string {
  const limit = Math.max(1, Math.trunc(Number(opts.limit) || ERROR_DETAIL_LIMIT));
  const includeStack = opts.includeStack !== false;
  const lines: string[] = [];
  const seen = new Set<string>();
  const push = (label: string, value: string): void => {
    const text = String(value ?? '').trim();
    if (!text) return;
    const key = `${label}\u0000${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(label ? `${label}：${text}` : text);
  };
  const visit = (err: unknown, depth: number): void => {
    if (err === undefined || err === null) return;
    if (typeof err === 'string') { push('', err); return; }
    if (typeof err !== 'object') { push('', String(err)); return; }
    const node = err as any;
    const isError = err instanceof Error;
    const head = isError
      ? `${node.name || 'Error'}${node.message ? `：${node.message}` : ''}`
      : (valueText(node, ERROR_FIELD_LIMIT) || Object.prototype.toString.call(err));
    push('', head);
    if (depth >= CAUSE_MAX_DEPTH) return;
    push('状态', statusText(node));
    push('代码', valueText(node.code));
    push('地址', valueText(node.url ?? node.requestUrl ?? node.endpoint));
    push('响应', responseText(node.response ?? node.body ?? node.data));
    if (includeStack && typeof node.stack === 'string') {
      // 首行通常与 head 重复，只留调用栈本体
      const stackLines = node.stack.split('\n');
      const rest = stackLines.slice(stackLines[0] && stackLines[0].includes(String(node.message || '\u0000')) ? 1 : 0).join('\n');
      push('堆栈', rest);
    }
    if (node.cause !== undefined && node.cause !== null) {
      const before = lines.length;
      lines.push('原因：');
      visit(node.cause, depth + 1);
      if (lines.length === before + 1) lines.pop(); // cause 提取不出任何内容：别留空标题
    }
  };
  visit(error, 0);
  const text = lines.join('\n').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 单行错误摘要：消息 + 状态 / 代码 / 响应体 / cause（压成一行，≤300 字）。
 * 失败清单与 toast 用它——既保留关键上下文，又不会把一条通知撑成多行。
 */
export function describeErrorSummary(error: unknown): string {
  if (error === undefined || error === null) return '';
  if (typeof error === 'string') return oneLine(error, ERROR_SUMMARY_LIMIT);
  if (typeof error !== 'object') return oneLine(String(error), ERROR_SUMMARY_LIMIT);
  const node = error as any;
  const parts: string[] = [];
  const message = node instanceof Error || typeof node.message === 'string'
    ? String(node.message || node.name || '')
    : valueText(node, ERROR_SUMMARY_LIMIT);
  parts.push(oneLine(message || Object.prototype.toString.call(error), ERROR_SUMMARY_LIMIT));
  const status = statusText(node);
  if (status) parts.push(`状态 ${status}`);
  if (node.code !== undefined && node.code !== null && String(node.code).trim()) parts.push(`代码 ${valueText(node.code, 80)}`);
  const response = responseText(node.response ?? node.body ?? node.data);
  if (response) parts.push(`响应 ${oneLine(response, ERROR_SUMMARY_LIMIT)}`);
  if (node.cause !== undefined && node.cause !== null) {
    const cause = describeErrorSummary(node.cause);
    if (cause) parts.push(`原因 ${oneLine(cause, ERROR_SUMMARY_LIMIT)}`);
  }
  return oneLine(parts.filter(Boolean).join(' · '), ERROR_SUMMARY_LIMIT);
}
