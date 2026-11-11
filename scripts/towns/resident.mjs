// 常驻小镇：管理员在首页挑一个小镇一直开着（页面全关了也不停），别人只能进这个镇。
// 记在数据目录的 resident.json 里；电脑版（crates/manager/src/resident.rs）读同一份。
import fs from 'node:fs/promises'
import path from 'node:path'

export const residentFile = (root) => path.join(root, 'resident.json')

/** 现在常驻的是哪个小镇、按什么速度跑；没设或文件坏了都算没设 */
export async function readResident(root) {
  try {
    const value = JSON.parse(await fs.readFile(residentFile(root), 'utf8'))
    return {
      town: typeof value.town === 'string' && value.town ? value.town : null,
      speed: typeof value.speed === 'number' && value.speed >= 0 ? value.speed : 1,
    }
  } catch {
    return { town: null, speed: 1 }
  }
}

/** 写常驻小镇；town 为 null 表示不常驻 */
export async function writeResident(root, { town, speed }) {
  await fs.mkdir(root, { recursive: true })
  const file = residentFile(root),
    temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, `${JSON.stringify({ town: town ?? null, speed }, null, 2)}\n`)
  await fs.rename(temp, file)
}

/** 常驻的是哪个小镇、什么速度：运行时问它，不读盘 */
export function createResident(root, { town = null, speed = 1 } = {}) {
  let state = { town, speed }
  return {
    town: () => state.town,
    speed: () => state.speed,
    async set(town) {
      state = { town: town ?? null, speed: state.speed }
      await writeResident(root, state)
    },
    async setSpeed(speed) {
      state = { town: state.town, speed }
      await writeResident(root, state)
    },
  }
}
