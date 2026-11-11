// 摆道具的格子：把服务端给的一个地点的格子换算成格心、查某一格能不能放、把点的位置吸附到最近的空格。
// 只做算术，不碰界面；单独编译得起来，好测（tests/grid.test.mjs）。

/** 只需要这几个字段；PlaceGrid 结构上满足它 */
export interface GridLike {
  origin: [number, number]
  columns: number
  rows: number
  step: number
  cells: string
}

/** cells 里表示「这里能放」的字符 */
export const FREE = '.'

/** 落在第几格（行优先，从上到下、从左到右）；在格子范围外时为空 */
export function cellIndex(grid: GridLike, position: [number, number]): number | null {
  if (!(grid.step > 0)) return null
  const column = Math.round((position[0] - grid.origin[0]) / grid.step)
  const row = Math.round((position[1] - grid.origin[1]) / grid.step)
  if (column < 0 || row < 0 || column >= grid.columns || row >= grid.rows) return null
  return row * grid.columns + column
}

/** 第 index 格的中心（米） */
export function cellCenter(grid: GridLike, index: number): [number, number] | null {
  if (!Number.isInteger(index) || index < 0 || index >= grid.columns * grid.rows) return null
  const row = Math.floor(index / grid.columns)
  const column = index - row * grid.columns
  return [grid.origin[0] + column * grid.step, grid.origin[1] + row * grid.step]
}

/** 这一点所在格能放时，回它的格心；不能放（或者压根在格子外）为空 */
export function snapToCell(grid: GridLike, position: [number, number]): [number, number] | null {
  const index = cellIndex(grid, position)
  if (index === null || grid.cells[index] !== FREE) return null
  return cellCenter(grid, index)
}

/** 从这点往外一圈圈找最近的空格，最多看 limit 格远；一个都没有时为空。
 *  点偏了半格也能落到最近的空位，而不是直接说「这里放不下」 */
export function nearestFree(
  grid: GridLike,
  position: [number, number],
  limit = 12
): [number, number] | null {
  const index = cellIndex(grid, position)
  if (index === null) return null
  const row0 = Math.floor(index / grid.columns)
  const column0 = index - row0 * grid.columns
  let best: { distance: number; index: number } | null = null
  const rowFrom = Math.max(0, row0 - limit)
  const rowTo = Math.min(grid.rows - 1, row0 + limit)
  const columnFrom = Math.max(0, column0 - limit)
  const columnTo = Math.min(grid.columns - 1, column0 + limit)
  for (let row = rowFrom; row <= rowTo; row++)
    for (let column = columnFrom; column <= columnTo; column++) {
      const i = row * grid.columns + column
      if (grid.cells[i] !== FREE) continue
      const distance = (row - row0) ** 2 + (column - column0) ** 2
      if (!best || distance < best.distance) best = { distance, index: i }
    }
  return best ? cellCenter(grid, best.index) : null
}
