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
const DEFAULT_SIGNALING_SERVER = 'wss://signaling.ghostpipe.dev'
const DEFAULT_CONFIG_FILE_PATH = 'ghostpipe.config.json'
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

program.action(async (url, filePatterns, options) => {
  VERBOSE = options.verbose
  await connect(url, filePatterns, options)
})

const log = (...args) => VERBOSE && console.log(chalk.gray(...args))
log.error = (...args) => VERBOSE && console.error(chalk.red(...args))
log.warn = (...args) => VERBOSE && console.warn(chalk.yellow(...args))

const connect = async (url, file, {diff}) => {
  diff = diff === true ? 'main' : diff
  if (diff && !isGitRepo) {
    console.warn(chalk.yellow('Warning: --diff flag specified but current directory is not a git repository'))
    diff = null
  }
  const options = {
    signalingServer: DEFAULT_SIGNALING_SERVER
  }

  if (file) {
    if (!fs.existsSync(path.dirname(file))) {
      fs.mkdirSync(dir, { recursive: true })
      console.log(chalk.green(`✓ Created directory: ${dir}`))
    }
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, '', 'utf8')
      console.log(chalk.green(`✓ Created file: ${file}`))
    }
  }

  if (url && !file) {
    const hostname = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9.-]/g, '_')
    const defaultPath = `${hostname}.txt`
    
    if (fs.existsSync(defaultPath)) {
      log(chalk.blue(`Using existing file: ${defaultPath}`))
      file = defaultPath
    } else {
      log(`No existing file, creating it`)
      const defaultFilePath = await promptForDefaultFile(defaultPath)
      
      if (!defaultFilePath) {
        console.error(chalk.red('\nExiting without creating interface.'))
        process.exit(0)
      }
      
      const dir = path.dirname(defaultFilePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
        console.log(chalk.green(`✓ Created directory: ${dir}`))
      }
      
      if (!fs.existsSync(defaultFilePath)) {
        fs.writeFileSync(defaultFilePath, '', 'utf8')
        console.log(chalk.green(`✓ Created file: ${defaultFilePath}`))
      }
      
      file = defaultFilePath
      console.log()
    }
  }
  
  const config = url ? {interfaces: [{host: url, file, name: 'interface'}]} : readJson(DEFAULT_CONFIG_FILE_PATH)
  if (!config) {
    console.log('No url or config found. See https://github.com/inputlogic/ghostpipe#quick-start for a quickstart guide')
    process.exit(0)
  }
  const interfaces = config.interfaces.map(intf => {
    const pipe = crypto.randomBytes(16).toString('hex')
    const params = new URLSearchParams({
      pipe,
      signaling: options.signalingServer
    })
    const ydoc = new YDoc()
    const provider = new WebrtcProvider(pipe, ydoc, {signaling: [options.signalingServer], peerOpts: { wrtc }})
    const meta = ydoc.getMap('meta')
    if (isGitRepo) {
      meta.set('base-branch', diff)
      meta.set('head-branch', getHeadBranch())
    }
    ydoc.getMap('data').observe((event, transaction) => {
      log(intf.name, 'transaction origin:', transaction.origin?.peerId || 'local')
      if (!transaction.origin?.peerId) return
      event.changes.keys.forEach((change, key) => {
        if (change.action === 'update' || change.action === 'add') {
          log(intf.name, 'ydoc event', change.action, key)
          debouncedWriteFile(intf.file, ydoc, intf, diff)
        } else if (change.action === 'delete') {
          log('TODO: handle delete file')
        }
      })
    })
    console.log(chalk.cyan(`${intf.name}: `) + chalk.underline(`${intf.host}?${params.toString()}`))
    return {
      ...intf,
      ydoc,
      provider
    }
  })
  console.log(' ')
  const allFilePatterns = interfaces.map(intf => intf.file)
  if (allFilePatterns.length === 0) {
    console.error(chalk.red('No file patterns configured in .ghostpipe.json'))
    console.error(chalk.yellow('Please add file patterns to the "files" array in your interfaces'))
    process.exit(1)
  }
  
  const chokidarPatterns = allFilePatterns.map(pattern => {
    if (pattern.includes('**')) {
      return pattern.replace('/**', '')
    }
    return pattern
  })
  
  const watcher = chokidar.watch(chokidarPatterns, {
    persistent: true,
    ignoreInitial: false
  })
  
  watcher.on('error', error => {
    console.error(chalk.red('ERROR:'), chalk.red(error.message))
    process.exit(1)
  })
  
  watcher.on('all', (event, path) => {
    if (event === 'add') {
      debouncedAdd(path, interfaces, diff)
    }
    if (event === 'change') {
      debouncedChange(path, interfaces, diff)
    }
  })
}

const promptForDefaultFile = async (defaultPath) => {
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

const debouncedAdd = debounceByKey((path, interfaces, diff) => {
  const content = fs.readFileSync(path, 'utf8')
  interfaces.filter(intf => intf.file === path).forEach(intf => {
    log('file add', path)
    intf.ydoc.transact(() => {
      intf.ydoc.getMap('data').set('content', content)
    })
    addDiffFile({intf, diff, file: path})
  })
}, 300)

const debouncedChange = debounceByKey((path, interfaces, diff) => {
  const fileContent = fs.readFileSync(path, 'utf8')
  
  interfaces.filter(intf => intf.file === path).forEach(intf => {
    const content = intf.ydoc.getMap('data').get('content')
    if (content !== fileContent) {
      log('file change local', path)
      intf.ydoc.transact(() => {
        intf.ydoc.getMap('data').set('content', fileContent)
      })
    }
    addDiffFile({intf, diff, file: path})
  })
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

const hashContent = (content) =>
  crypto.createHash('sha256').update(content).digest('hex')


program.parse()
