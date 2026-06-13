/**
 * 悬浮球 / 伴侣窗拖拽落点（PRD 0.2.35）——纯函数，可单测，两个 fb 窗共用。
 *
 * 窗口原点 = 光标全局点 − 抓取偏移（抓取偏移在 pointerdown 锁定、全程恒定）。
 * 绝对落点：**无回读窗口位置、无增量累计、与拖拽历史无关**（同一光标位置永远
 * 得到同一落点）。这正是修掉「读改写增量振荡」闪烁的不变量——旧实现让 Rust
 * `outer_position()`（同步读）+ delta → `set_position()`（tao GCD 异步写），连续帧
 * 读到同一未落地的旧 frame、增量互相覆盖 → 位置高频横跳 = 跨屏拖拽闪烁/闪空。
 *
 * 坐标空间：浏览器 `e.screenX/Y`（CSS 像素 = AppKit 点、左上原点、全屏统一）与
 * tao `set_position(LogicalPosition)`（全局逻辑点、左上原点）同一空间——已对 tao
 * 0.34.8 源码核对（`window_position` 仅做 y 翻转，scale 在 Logical 入参下被忽略）。
 * 故落点跨屏统一、与各屏 backingScaleFactor 无关。
 */
export function computeDragOrigin(
    pointerScreenX: number,
    pointerScreenY: number,
    grabX: number,
    grabY: number,
): { x: number; y: number } {
    return { x: pointerScreenX - grabX, y: pointerScreenY - grabY };
}
