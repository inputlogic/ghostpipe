#!/usr/bin/env node
import * as crypto from 'crypto'
import { Command } from 'commander'
import { Doc as YDoc } from 'yjs'
import { WebrtcProvider } from 'y-webrtc'
import * as wrtc from '@roamhq/wrtc'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import * as chokidar from 'chokidar'
import { execSync } from 'child_process'
import chalk from 'chalk'
import * as os from 'os'

interface Interface {
  name: string
  host: string
  file: string
  url?: string
  ydoc?: YDoc
  provider?: WebrtcProvider
}

interface Config {
  signalingServer: string
  globalConfigPath: string
  localConfigPath: string
  defaultDiffBaseBranch: string
  diff?: string | boolean
  isGitRepo?: boolean
  interfaces?: Interface[]
}

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'))

const program = new Command()
const DEFAULT_CONFIG: Config = {
  signalingServer: 'wss://signaling.ghostpipe.dev',
  globalConfigPath: path.join(os.homedir(), '.config', 'ghostpipe', 'config.json'),
  localConfigPath: 'ghostpipe.config.json',
  defaultDiffBaseBranch: 'main',
}
let VERBOSE = false

program
  .name('ghostpipe')
  .description('Interfaces for your codebase')
  .version(packageJson.version)
  .argument('[url]', 'Interface URL')
  .argument('[file]', 'The file this interface can use')
  .option('--verbose', 'Enable verbose logging')
  .option('--diff [branch]', 'Base branch for diff comparison')

program.action(async (url: string | undefined, file: string | undefined, options: { verbose?: boolean, diff?: string | boolean }) => {
  VERBOSE = options.verbose || false
  await main(url, file, options)
})

const log = (...args: any[]) => VERBOSE && console.log(chalk.gray(...args))
log.error = (...args: any[]) => VERBOSE && console.error(chalk.red(...args))
log.warn = (...args: any[]) => VERBOSE && console.warn(chalk.yellow(...args))

const main = async (url: string | undefined, file: string | undefined, options: { diff?: string | boolean }) => {
  const config = await buildConfig({ url, file, diff: options.diff })
    .then(validateConfig)
    .then(connectInterfaces)
  config.interfaces?.forEach(
    intf => console.log(chalk.cyan(`${intf.name}: `) + chalk.underline(intf.url))
  )
}

const buildConfig = async ({ url, file, diff }: { url?: string, file?: string, diff?: string | boolean }): Promise<Config> => {
  const globalConfig = readJson(DEFAULT_CONFIG.globalConfigPath)
  const localConfig = readJson(globalConfig?.localConfigPath || DEFAULT_CONFIG.localConfigPath)
  const inlineInterface = await prepareInlineInterface({ url, file })
  return {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...localConfig,
    diff: diff === true ? (localConfig?.defaultDiffBaseBranch || globalConfig?.defaultDiffBaseBranch || DEFAULT_CONFIG.defaultDiffBaseBranch) : diff,
    isGitRepo: isGitRepo(),
    interfaces: inlineInterface ? [inlineInterface] : localConfig?.interfaces
  }
}

const validateConfig = (config: Config): Config => {
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
      console.error(chalk.red(`No file specified for interface ${intf.name} (${intf.host})`))
      process.exit(1)
    }
    if (!fs.existsSync(intf.file)) {
      console.error(chalk.red(`File does not exist for interface ${intf.name}: ${intf.file}`))
      process.exit(1)
    }
  })
  return config
}

const connectInterfaces = (config: Config): Config => ({
  ...config,
  interfaces: config.interfaces?.map(intf => connectInterface(intf, config))
})

const connectInterface = (intf: Interface, config: Config): Interface => {
  const connectedInterface = connectInterfaceToYjs(intf, config)
  watchLocalFile(connectedInterface, config)
  return connectedInterface
}

const connectInterfaceToYjs = (intf: Interface, config: Config): Interface => {
  const pipe = crypto.randomBytes(16).toString('hex')
  const params = new URLSearchParams({ pipe, signaling: config.signalingServer })
  const ydoc = new YDoc()
  const provider = new WebrtcProvider(pipe, ydoc, { signaling: [config.signalingServer], peerOpts: { wrtc } })
  const meta = ydoc.getMap('meta')
  if (config.isGitRepo) {
    meta.set('base-branch', config.diff as string)
    meta.set('head-branch', getHeadBranch())
  }
  ydoc.getMap('data').observe((event, transaction) => {
    log(intf.name, 'transaction origin:', (transaction.origin as any)?.peerId || 'local')
    if (!(transaction.origin as any)?.peerId) return
    event.changes.keys.forEach((change, key) => {
      if (change.action === 'update' || change.action === 'add') {
        log(intf.name, 'ydoc event', change.action, key)
        debouncedWriteFile(intf.file, ydoc, intf, config.diff as string)
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

const watchLocalFile = (intf: Interface, config: Config): void => {
  const watcher = chokidar.watch([intf.file], {
    persistent: true,
    ignoreInitial: false
  })
  
  watcher.on('error', (error) => {
    console.error(chalk.red('ERROR:'), chalk.red((error as Error).message))
    process.exit(1)
  })
  
  watcher.on('all', (event, path) => {
    if (event === 'add') {
      debouncedAdd(path, intf, config.diff as string)
    }
    if (event === 'change') {
      debouncedChange(path, intf, config.diff as string)
    }
  })
}

const prepareInlineInterface = async ({ url, file }: { url?: string, file?: string }): Promise<Interface | null> => {
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

const createFileIfDoesNotExist = (file: string): void => {
  if (!fs.existsSync(path.dirname(file))) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  }
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '', 'utf8')
  }
}

const getFilePath = async (defaultPath: string): Promise<string> => {
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

const isGitRepo = (): boolean => {
  try {
    execSync('git rev-parse --git-dir', { encoding: 'utf8', stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const addDiffFile = ({ intf, diff, file }: { intf: Interface, diff: string, file: string }): void => {
  if (!diff || !isGitRepo()) return
  try {
    const content = execSync(`git show ${diff}:${file}`, { encoding: 'utf8', stdio: 'pipe' })
    intf.ydoc?.getMap('base-data').set('content', content)
    log(`Loaded diff file for ${intf.name}: ${file}`)
  } catch (error) {
    log.error(`File not in ${diff} branch: ${file}`)
  }
}

const readJson = (file: string): any => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    log.error(error)
    return null
  }
}

const debounceByKey = <T extends (...args: any[]) => void>(func: T, delay: number): T => {
  const timers = new Map<string, NodeJS.Timeout>()
  return ((...args: Parameters<T>) => {
    const key = args[0] as string
    clearTimeout(timers.get(key))
    timers.set(key, setTimeout(() => {
      timers.delete(key)
      func.apply(null, args)
    }, delay))
  }) as T
}

const debouncedAdd = debounceByKey((path: string, intf: Interface, diff: string) => {
  const content = fs.readFileSync(path, 'utf8')
  intf.ydoc?.transact(() => {
    intf.ydoc?.getMap('data').set('content', content)
  })
  addDiffFile({ intf, diff, file: path })
}, 300)

const debouncedChange = debounceByKey((path: string, intf: Interface, diff: string) => {
  const fileContent = fs.readFileSync(path, 'utf8')
  const content = intf.ydoc?.getMap('data').get('content')
  if (content !== fileContent) {
    log('file change local', path)
    intf.ydoc?.transact(() => {
      intf.ydoc?.getMap('data').set('content', fileContent)
    })
  }
  addDiffFile({ intf, diff, file: path })
}, 300)

const debouncedWriteFile = debounceByKey((key: string, ydoc: YDoc, intf: Interface, diff: string) => {
  const content = ydoc.getMap('data').get('content')
  const fileContent = fs.readFileSync(key, 'utf8')
  if (content === fileContent) return
  log(intf.name, 'file change remote', key)
  fs.writeFileSync(key, content as string, 'utf8')
  addDiffFile({ diff, intf, file: key })
}, 300)

const getHeadBranch = (): string | null => {
  if (!isGitRepo()) return null
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch (error) {
    log.error('Error getting branch:', (error as Error).message)
    return null
  }
}

program.parse()
