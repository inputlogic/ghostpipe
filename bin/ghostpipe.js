#!/usr/bin/env node
const crypto = require('crypto')
const { Command } = require('commander')
const { Doc: YDoc } = require('yjs')
const { WebrtcProvider } = require('y-webrtc')
const wrtc = require('@roamhq/wrtc')
const fs = require('fs')
const path = require('path')
const readline = require('readline')
const chokidar = require('chokidar')
const { execSync } = require('child_process')
const chalk = require('chalk')

const program = new Command()
const DEFAULT_CONFIG = {
  signalingServer: 'wss://signaling.ghostpipe.dev',
  globalConfigPath: '~/.config/ghostpipe/config.json',
  localConfigPath: 'ghostpipe.config.json',
  defaultDiffBaseBranch: 'main',
}
let VERBOSE = false

program
  .name('ghostpipe')
  .description('Interfaces for your codebase')
  .version(require('../package.json').version)
  .argument('[url]', 'Interface URL')
  .argument('[file]', 'The file this interface can use')
  .option('--verbose', 'Enable verbose logging')
  .option('--diff [branch]', 'Base branch for diff comparison')

program.action(async (url, file, options) => {
  VERBOSE = options.verbose
  await main(url, file, options)
})

const log = (...args) => VERBOSE && console.log(chalk.gray(...args))
log.error = (...args) => VERBOSE && console.error(chalk.red(...args))
log.warn = (...args) => VERBOSE && console.warn(chalk.yellow(...args))

const main = async (url, file, {diff}) => {
  const config = await asyncPipe(
    buildConfig,
    validateConfig,
    connectInterfaces
  )({url, file, diff})
  config.interfaces.forEach(
    intf => console.log(chalk.cyan(`${intf.name}: `) + chalk.underline(intf.url))
  )
}

const buildConfig = async ({url, file, diff}) => {
  const globalConfig = readJson(DEFAULT_CONFIG.globalConfigPath)
  const localConfig = readJson(globalConfig?.localConfigPath || DEFAULT_CONFIG.localConfigPath)
  const inlineInterface = await prepareInlineInterface({url, file})
  return {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...localConfig,
    diff: diff === true ? (localConfig?.diffBaseBranch || globalConfig?.diffBaseBranch || DEFAULT_CONFIG.defaultDiffBaseBranch) : diff,
    isGitRepo,
    interfaces: inlineInterface ? [inlineInterface] : localConfig?.interfaces
  }
}

const validateConfig = config => {
  if (config.diff && !config.isGitRepo) {
    console.warn(chalk.yellow('Warning: --diff flag specified but current directory is not a git repository'))
    process.exit(0)
  }
  if (!config.interfaces) {
    console.log('No url or config found. See https://github.com/inputlogic/ghostpipe#quick-start for a quickstart guide')
    process.exit(0)
  }
  config.interfaces.forEach(intf => {
    if (!intf.file) {
      console.error(chalk.red(`No file specified for ${intf.name}`))
      process.exit(1)
    }
  })
  return config
}

const connectInterfaces = config => ({
  ...config,
  interfaces: config.interfaces.map(intf => connectInterface(intf, config))
})

const connectInterface = (intf, config) =>
  pipe(
    intf => connectInterfaceToYjs(intf, config),
    intf => watchLocalFile(intf, config),
  )(intf)

const connectInterfaceToYjs = (intf, config) => {
  const pipe = crypto.randomBytes(16).toString('hex')
  const params = new URLSearchParams({pipe, signaling: config.signalingServer})
  const ydoc = new YDoc()
  const provider = new WebrtcProvider(pipe, ydoc, {signaling: [config.signalingServer], peerOpts: { wrtc }})
  const meta = ydoc.getMap('meta')
  if (config.isGitRepo) {
    meta.set('base-branch', config.diff)
    meta.set('head-branch', getHeadBranch())
  }
  ydoc.getMap('data').observe((event, transaction) => {
    log(intf.name, 'transaction origin:', transaction.origin?.peerId || 'local')
    if (!transaction.origin?.peerId) return
    event.changes.keys.forEach((change, key) => {
      if (change.action === 'update' || change.action === 'add') {
        log(intf.name, 'ydoc event', change.action, key)
        debouncedWriteFile(intf.file, ydoc, intf, config.diff)
      } else if (change.action === 'delete') {
        log('TODO: handle delete file')
      }
    })
  })
  return {
    ...intf,
    url: `${intf.host}?${params.toString()}`,
    ydoc,
    provider
  }
}

const watchLocalFile = (intf, config) => {
  const watcher = chokidar.watch([intf.file], {
    persistent: true,
    ignoreInitial: false
  })
  
  watcher.on('error', error => {
    console.error(chalk.red('ERROR:'), chalk.red(error.message))
    process.exit(1)
  })
  
  watcher.on('all', (event, path) => {
    if (event === 'add') {
      debouncedAdd(path, intf, config.diff)
    }
    if (event === 'change') {
      debouncedChange(path, intf, config.diff)
    }
  })

  return intf
}

const prepareInlineInterface = async ({url, file}) => {
  if (!url) return null
  if (!file) {
    file = await getFilePath(`${url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9.-]/g, '_')}.txt`)
  }
  createFileIfDoesNotExist(file)
  return {
    host: url,
    file,
    name: 'interface'
  }
}

const createFileIfDoesNotExist = file => {
  if (!fs.existsSync(path.dirname(file))) {
    fs.mkdirSync(dir, { recursive: true })
  }
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '', 'utf8')
  }
}

const getFilePath = async (defaultPath) => {
  if (fs.existsSync(defaultPath))
    return defaultPath

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  
  return new Promise((resolve) => {
    rl.question(`file (${defaultPath}): `, (customPath) => {
      rl.close()
      resolve(customPath.trim() || defaultPath)
    })
  })
}

const addDiffFile = ({intf, diff, file}) => {
  if (!diff || !isGitRepo) return
  try {
    const content = execSync(`git show ${diff}:${file}`, {encoding: 'utf8', stdio: 'pipe'})
    intf.ydoc.getMap('base-data').set('content', content)
    log(`Loaded diff file for ${intf.name}: ${file}`)
  } catch (error) {
    log.error(`File not in ${diff} branch: ${file}`)
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    log.error(error)
    return null
  }
}

const debounceByKey = (func, delay) => {
  const timers = new Map()
  return (...args) => {
    const key = args[0]
    clearTimeout(timers.get(key))
    timers.set(key, setTimeout(() => {
      timers.delete(key)
      func.apply(this, args)
    }, delay))
  }
}

const debouncedAdd = debounceByKey((path, intf, diff) => {
  const content = fs.readFileSync(path, 'utf8')
  intf.ydoc.transact(() => {
    intf.ydoc.getMap('data').set('content', content)
  })
  addDiffFile({intf, diff, file: path})
}, 300)

const debouncedChange = debounceByKey((path, intf, diff) => {
  const fileContent = fs.readFileSync(path, 'utf8')
  const content = intf.ydoc.getMap('data').get('content')
  if (content !== fileContent) {
    log('file change local', path)
    intf.ydoc.transact(() => {
      intf.ydoc.getMap('data').set('content', fileContent)
    })
  }
  addDiffFile({intf, diff, file: path})
}, 300)

const debouncedWriteFile = debounceByKey((key, ydoc, intf, diff) => {
  const content = ydoc.getMap('data').get('content')
  const fileContent = fs.readFileSync(key, 'utf8')
  if (content === fileContent) return
  log(intf.name, 'file change remote', key)
  fs.writeFileSync(key, content, 'utf8')
  addDiffFile({diff, intf, file: key})
}, 300)

const getHeadBranch = () => {
  if (!isGitRepo) return null
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch (error) {
    log.error('Error getting branch:', error.message)
  }
}

const pipe = (...functions) => (value) => 
  functions.reduce((acc, fn) => fn(acc), value)

const isGitRepo = (() => {
  try {
    execSync('git rev-parse --git-dir', { encoding: 'utf8', stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()

const asyncPipe = (...functions) => async (value) => {
  let result = value
  for (const fn of functions) {
    result = await fn(result)
  }
  return result
}

program.parse()
