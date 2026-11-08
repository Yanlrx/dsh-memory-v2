import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const parent = dirname(fileURLToPath(import.meta.url))
const projectRoot = dirname(parent)
const scanner = join(projectRoot, 'tools', 'privacy-check.mjs')
const temporaryRoot = fs.mkdtempSync(join(parent, '.privacy-check-'))

function scan(mode, denylist = '') {
  return spawnSync(process.execPath, [scanner, `--mode=${mode}`], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, DSH_MEMORY_PRIVACY_ROOT: temporaryRoot, DSH_MEMORY_PRIVACY_DENYLIST: denylist },
  })
}

try {
  fs.writeFileSync(join(temporaryRoot, 'README.md'), 'synthetic clean release fixture\n')
  assert.equal(scan('artifact').status, 0)

  const machinePath = ['C:', 'Users', 'private-profile', 'secret'].join('\\')
  fs.writeFileSync(join(temporaryRoot, '.gitignore'), `${machinePath}\n`)
  assert.notEqual(scan('artifact').status, 0, 'ignore 文件中的机器路径必须被扫描')
  fs.rmSync(join(temporaryRoot, '.gitignore'))

  fs.mkdirSync(join(temporaryRoot, 'node_modules'))
  fs.writeFileSync(join(temporaryRoot, 'node_modules', 'dependency.js'), 'export default true\n')
  assert.notEqual(scan('artifact').status, 0, '发布物不得包含 node_modules')
  assert.equal(scan('installed').status, 0, '已安装模式可以跳过第三方依赖')
  fs.rmSync(join(temporaryRoot, 'node_modules'), { recursive: true })

  const dependencyTarget = fs.mkdtempSync(join(parent, '.privacy-dependencies-'))
  try {
    fs.symlinkSync(dependencyTarget, join(temporaryRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(scan('installed').status, 0, '已安装模式应兼容包管理器创建的依赖链接')
    assert.notEqual(scan('artifact').status, 0, '发布物模式仍须拒绝依赖链接')
    if (process.platform === 'win32') fs.rmdirSync(join(temporaryRoot, 'node_modules'))
    else fs.unlinkSync(join(temporaryRoot, 'node_modules'))
  } catch (error) {
    if (error?.code !== 'EPERM') throw error
  } finally {
    fs.rmSync(dependencyTarget, { recursive: true, force: true })
  }

  fs.mkdirSync(join(temporaryRoot, '.git'))
  fs.writeFileSync(join(temporaryRoot, '.git', 'config'), '[core]\n')
  assert.notEqual(scan('artifact').status, 0, '发布物不得包含 Git 元数据')
  assert.equal(scan('repository').status, 0, '仓库模式可以跳过 Git 对象目录')
  fs.rmSync(join(temporaryRoot, '.git'), { recursive: true })

  const privateToken = ['private', 'fixture', 'token'].join('-')
  fs.writeFileSync(join(temporaryRoot, '.npmignore'), `${privateToken}\n`)
  assert.notEqual(scan('artifact', privateToken).status, 0, '自定义 denylist 必须覆盖 ignore 文件')
  console.log('隐私扫描器测试：模式边界、ignore 文件与自定义 denylist 均生效')
} finally {
  const safe = resolve(temporaryRoot)
  if (safe.startsWith(resolve(parent, '.privacy-check-'))) {
    const dependencyLink = join(safe, 'node_modules')
    try {
      if (fs.existsSync(dependencyLink) || fs.lstatSync(dependencyLink).isSymbolicLink()) {
        if (process.platform === 'win32') fs.rmdirSync(dependencyLink)
        else fs.unlinkSync(dependencyLink)
      }
    } catch (error) {
      if (!['ENOENT', 'EINVAL'].includes(error?.code)) throw error
    }
    fs.rmSync(safe, { recursive: true, force: true })
  }
}
