#!/usr/bin/env node
const crypto = require('crypto')
const { Command } = require('commander')
const { Doc: YDoc } = require('yjs')
const { WebrtcProvider } = require('y-webrtc')
const { minimatch } = require('minimatch')
const wrtc = require('@roamhq/wrtc')
const fs = require('fs')
const path = require('path')
const readline = require('readline')
const chokidar = require('chokidar')
const { execSync } = require('child_process')
const chalk = require('chalk')

const program = new Command()
const DEFAULT_GLOBAL_CONFIG_PATH = '~/.config/ghostpipe/config.json'
const DEFAULT_SIGNALING_SERVER = 'wss://signaling.ghostpipe.dev'
const DEFAULT_LOCAL_CONFIG_PATH = 'ghostpipe.config.json'
const DEFAULT_DIFF_BASE_BRANCH = 'main'
let VERBOSE = false

const isGitRepo = (() => {
  try {
    execSync('git rev-parse --git-dir', { encoding: 'utf8', stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()

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
  const config = await buildConfig({url, file, diff})
    .then(validateConfig)
    .then(yjsConnect)
  localConnect(config)
  config.interfaces.forEach(printInterface)
  console.log(' ')
}

const buildConfig = async ({url, file, diff}) => {
  const globalConfig = readJson(DEFAULT_GLOBAL_CONFIG_PATH)
  const localConfig = readJson(globalConfig?.localConfigPath || DEFAULT_LOCAL_CONFIG_PATH)
  const inlineInterface = await prepareInlineInterface({url, file})
  return {
    diff: diff === true ? (localConfig?.diffBaseBranch || globalConfig?.diffBaseBranch || DEFAULT_DIFF_BASE_BRANCH) : diff,
    isGitRepo,
    signalingServer: DEFAULT_SIGNALING_SERVER,
    localConfig,
    globalConfig,
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
  return config
}

const yjsConnect = config => ({
  ...config,
  interfaces: config.interfaces.map(intf => connectInterfaceToYjs(intf, config))
})

const localConnect = config => config.interfaces.forEach(intf => watchLocalFile(intf, config))

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
  if (!intf.file) {
    console.error(chalk.red(`No file specified for ${intf.name}`))
    process.exit(1)
  }
  
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
}

// const watchLocalFiles = config => {
//   const allFilePatterns = config.interfaces.map(intf => intf.file)
//   if (allFilePatterns.length === 0) {
//     console.error(chalk.red('No file patterns configured in .ghostpipe.json'))
//     console.error(chalk.yellow('Please add file patterns to the "files" array in your interfaces'))
//     process.exit(1)
//   }
  
//   const chokidarPatterns = allFilePatterns.map(pattern => {
//     if (pattern.includes('**')) {
//       return pattern.replace('/**', '')
//     }
//     return pattern
//   })
  
//   const watcher = chokidar.watch(chokidarPatterns, {
//     persistent: true,
//     ignoreInitial: false
//   })
  
//   watcher.on('error', error => {
//     console.error(chalk.red('ERROR:'), chalk.red(error.message))
//     process.exit(1)
//   })
  
//   watcher.on('all', (event, path) => {
//     if (event === 'add') {
//       debouncedAdd(path, config.interfaces, config.diff)
//     }
//     if (event === 'change') {
//       debouncedChange(path, config.interfaces, config.diff)
//     }
//   })
// }

const printInterface = intf =>
  console.log(chalk.cyan(`${intf.name}: `) + chalk.underline(intf.url))

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

program.parse()
