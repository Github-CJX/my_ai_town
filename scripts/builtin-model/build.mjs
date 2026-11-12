// 纯浏览器版内置模型 llama-server 构建脚本（供本机 Rust Host 调用）。
// Linux 构建 CPU 版；macOS 构建 Metal 版。模型文件仍由游戏内下载。
// 用法：node scripts/builtin-model/build.mjs [--llama <源码目录>] [--gguf <模型.gguf>]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataRoot } from '../towns/storage.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
const out = path.join(root, 'target/builtin-model')
const build = path.join(root, 'target/llama-build')
const SERVER = 'llama-server'
/** 和训练仓库评测量化版时用的同一版 llama.cpp */
const LLAMA_REPO = 'https://github.com/ggml-org/llama.cpp.git'
const LLAMA_COMMIT = '78651c4'
const MIN_MACOS = '13.0'
/** 共同的编译选项：静态链接、不要联网下载模型用的 OpenSSL，只编服务 */
const COMMON = [
  '-DCMAKE_BUILD_TYPE=Release',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DGGML_NATIVE=OFF',
  '-DLLAMA_OPENSSL=OFF',
  '-DLLAMA_BUILD_TESTS=OFF',
  '-DLLAMA_BUILD_EXAMPLES=OFF',
  '-DLLAMA_BUILD_APP=OFF',
  '-DLLAMA_BUILD_SERVER=ON',
]

function run(command, list, extra = {}) {
  console.log(`$ ${command} ${list.join(' ')}`)
  execFileSync(command, list, { stdio: 'inherit', cwd: root, ...extra })
}

function option(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function llamaSource() {
  const given = option('--llama')
  if (given) return path.resolve(given)
  const dir = path.join(root, 'target/llama.cpp')
  if (!fs.existsSync(path.join(dir, '.git')))
    run('git', ['clone', '--filter=blob:none', LLAMA_REPO, dir])
  run('git', ['-C', dir, 'checkout', '--quiet', LLAMA_COMMIT])
  return dir
}

/** Mac：Metal 着色器编进程序，一个文件就能跑，以后也能直接放进应用包 */
function macFlags() {
  return [
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${MIN_MACOS}`,
    '-DGGML_METAL=ON',
    '-DGGML_METAL_EMBED_LIBRARY=ON',
  ]
}

/** Linux 私人服务器：不需要 Metal、Android/Windows 交叉编译工具链。 */
function linuxFlags() {
  return ['-DGGML_METAL=OFF', '-DGGML_OPENMP=OFF']
}

/** macOS 检查系统库；Linux 上用 ldd 检查可执行文件是否能加载。 */
function checkLinkage(server) {
  if (process.platform === 'darwin') {
    const libs = execFileSync('otool', ['-L', server], { encoding: 'utf8' })
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(' ')[0])
      .filter(Boolean)
    const foreign = libs.filter(
      (lib) => !lib.startsWith('/usr/lib/') && !lib.startsWith('/System/')
    )
    if (foreign.length) throw Error(`llama-server 依赖外部动态库：${foreign.join('、')}`)
  } else {
    const result = execFileSync('ldd', [server], { encoding: 'utf8' })
    if (/not found/.test(result)) throw Error(`llama-server 缺少动态库：${result}`)
  }
}

function buildServer(source) {
  const commit = execFileSync('git', ['-C', source, 'rev-parse', '--short=7', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  if (commit !== LLAMA_COMMIT)
    console.warn(`注意：llama.cpp 是 ${commit}，评测用的是 ${LLAMA_COMMIT}`)
  const flags = process.platform === 'darwin' ? macFlags() : linuxFlags()
  run('cmake', ['-S', source, '-B', build, ...COMMON, ...flags])
  run('cmake', ['--build', build, '--config', 'Release', '--target', 'llama-server', '-j'])
  const server = path.join(build, 'bin', SERVER)
  checkLinkage(server)
  fs.mkdirSync(out, { recursive: true })
  const dest = path.join(out, SERVER)
  fs.copyFileSync(server, dest)
  fs.chmodSync(dest, 0o755)
}

/** 本机测试版装进用户数据目录，写法和下载装好的一样（installed.json 见 builtin_store.rs） */
function installLocal(gguf) {
  const store = path.join(dataRoot(), 'builtin-model')
  fs.mkdirSync(store, { recursive: true })
  const model = path.join(store, 'model.gguf')
  // APFS 上是写时复制，几百 MB 的模型瞬间就好
  fs.copyFileSync(path.resolve(gguf), model + '.tmp', fs.constants.COPYFILE_FICLONE)
  fs.renameSync(model + '.tmp', model)
  const hash = createHash('sha256').update(fs.readFileSync(model)).digest('hex')
  const date = new Date().toISOString().slice(0, 10)
  const installed = {
    date,
    size: fs.statSync(model).size,
    sha256: hash,
    notes: '本机测试版',
    installed_at: Date.now(),
  }
  fs.writeFileSync(path.join(store, 'installed.json'), JSON.stringify(installed, null, 2))
  for (const name of ['download.json', 'progress.json', 'model.gguf.part'])
    fs.rmSync(path.join(store, name), { force: true })
  console.log(
    `已装进 ${store}（${(installed.size / 1e6).toFixed(0)} MB，当作 ${date} 的本机测试版）`
  )
}

const gguf = option('--gguf')
if (!['linux', 'darwin'].includes(process.platform)) throw Error('这个脚本仅支持 Linux 和 macOS')
if (args.includes('--android') || args.includes('--windows'))
  throw Error('纯浏览器版不再支持原生 App 交叉构建')
if (gguf && !fs.existsSync(gguf)) throw Error('--gguf 只给电脑版用，要指向一个存在的 .gguf 文件')
buildServer(llamaSource())
console.log(
  `推理程序已准备好：${out}（${(fs.statSync(path.join(out, SERVER)).size / 1e6).toFixed(0)} MB）`
)
if (gguf) installLocal(gguf)
console.log('管理服务要重启才认得出新目录：重新运行 corepack pnpm preview')
