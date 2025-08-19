#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const { Command } = require('commander')
const { Doc: YDoc } = require('yjs')
const { WebrtcProvider } = require('y-webrtc')
const wrtc = require('@roamhq/wrtc')
const chokidar = require('chokidar')

// Constants
const DEFAULT_HOST = 'https://ghostpipe.dev'
const DEFAULT_SIGNALING = 'wss://signaling.ghostpipe.dev'
const IGNORED_PATHS = ['node_modules', 'dist', 'build', '.git', '.DS_Store', '.env']

let VERBOSE = false
const log = (...args) => VERBOSE && console.log(...args)

// Utility functions
const safeReadFile = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    return null
  }
}

const safeWriteFile = (filePath, content) => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content, 'utf8')
    return true
  } catch (error) {
    console.error(`Error writing ${filePath}:`, error.message)
    return false
  }
}

const openBrowser = (url) => {
  const { exec } = require('child_process')
  
  // Determine the command based on the platform
  let command
  switch (process.platform) {
    case 'darwin':
      command = `open "${url}"`
      break
    case 'win32':
      command = `start "${url}"`
      break
    default: // Linux and other Unix-like systems
      command = `xdg-open "${url}"`
      break
  }
  
  exec(command, (error) => {
    if (error) {
      log(`Failed to open browser: ${error.message}`)
    } else {
      log(`Browser opened with URL: ${url}`)
    }
  })
}

// Config & Args
const loadConfig = () => {
  const configPaths = [
    path.join(process.cwd(), '.ghostpipe.json'),
    path.join(os.homedir(), '.config', 'ghostpipe.json')
  ]
  
  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'))
      } catch (error) {
        console.error(`Error loading ${configPath}:`, error.message)
      }
    }
  }
  
  return {}
}

// Interface configuration utilities
const createInterfaceConfig = (interfaceConfig) => {
  if (typeof interfaceConfig === 'string') {
    return {
      host: interfaceConfig,
      name: 'Default',
      allowedFiles: null
    }
  }
  
  return {
    host: interfaceConfig.host,
    name: interfaceConfig.name || 'Default',
    allowedFiles: interfaceConfig.files || null
  }
}

// File Operations
const getAllFiles = (dirPath, basePath = '', fileList = [], allowedFiles = null) => {
  const files = fs.readdirSync(dirPath)
  
  for (const file of files) {
    if (IGNORED_PATHS.some(ignored => file === ignored || file.startsWith(ignored + '/'))) {
      continue
    }
    
    const filePath = path.join(dirPath, file)
    const relativePath = path.join(basePath, file)
    const stat = fs.statSync(filePath)
    
    if (stat.isDirectory()) {
      getAllFiles(filePath, relativePath, fileList, allowedFiles)
    } else if (stat.isFile()) {
      if (allowedFiles && !allowedFiles.includes(relativePath)) {
        log(`Skipping file (not in allowed list): ${relativePath}`)
      } else {
        const content = safeReadFile(filePath)
        if (content !== null) {
          fileList.push({ path: relativePath, content })
          log(`Added file: ${relativePath}`)
        } else {
          log(`Skipping binary: ${relativePath}`)
        }
      }
    }
  }
  
  return fileList
}

// File watcher creation is now handled by chokidar in setupFileWatching

// WebRTC & URL Generation
const createProvider = (pipeId, signalingServer) => {
  const ydoc = new YDoc()
  const provider = new WebrtcProvider(pipeId, ydoc, {
    signaling: [signalingServer],
    peerOpts: { wrtc }
  })
  
  return { ydoc, provider }
}

const generateUrl = (host, pipeId, signalingServer, mode = 'gui') => {
  const baseUrl = host.startsWith('http') ? host : `http://${host}`
  const params = new URLSearchParams({
    pipe: pipeId,
    signaling: signalingServer
  })
  if (mode === 'diff') {
    params.append('mode', mode)
  }
  return `${baseUrl}?${params.toString()}`
}

// Session setup utilities
const setupSessionMetadata = (ydoc) => {
  const metadata = ydoc.getMap('metadata')
  metadata.set('created', new Date().toISOString())
  metadata.set('cwd', process.cwd())
  return metadata
}

const setupFileSync = (files, allowedFiles, name) => {
  let updatingFromGUI = false
  
  const handleGUIChanges = (event) => {
    updatingFromGUI = true
    
    event.changes.keys.forEach((change, key) => {
      if (allowedFiles && !allowedFiles.includes(key)) {
        return
      }
      
      const filePath = path.join(process.cwd(), key)
      
      if (change.action === 'update' || change.action === 'add') {
        if (safeWriteFile(filePath, files.get(key))) {
          log(`[${name}] Updated: ${key}`)
        }
      } else if (change.action === 'delete') {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
            log(`[${name}] Deleted: ${key}`)
          }
        } catch (error) {
          console.error(`Error deleting ${key}:`, error.message)
        }
      }
    })
    
    updatingFromGUI = false
  }
  
  files.observe(handleGUIChanges)
  
  return { 
    isUpdatingFromGUI: () => updatingFromGUI,
    setUpdatingFromGUI: (value) => { updatingFromGUI = value }
  }
}

const setupFileWatching = (allFiles, files, name, allowedFiles, syncState) => {
  // Prepare file paths to watch
  const filesToWatch = allFiles.map(file => path.join(process.cwd(), file.path))
  
  // Create chokidar watcher with optimized settings
  const watcher = chokidar.watch(filesToWatch, {
    persistent: true,
    ignoreInitial: true,
    ignored: IGNORED_PATHS.map(p => `**/${p}/**`),
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 100
    },
    usePolling: false, // Avoid polling to reduce CPU usage
    followSymlinks: false, // Don't follow symlinks to avoid loops
    atomic: true // Handle atomic writes
  })
  
  // Add current directory separately for new file detection
  if (!allowedFiles) {
    watcher.add(process.cwd())
  }
  
  // Handle file changes
  watcher.on('change', (fullPath) => {
    if (syncState.isUpdatingFromGUI()) {
      return
    }
    
    const relativePath = path.relative(process.cwd(), fullPath)
    
    if (allowedFiles && !allowedFiles.includes(relativePath)) {
      return
    }
    
    try {
      const content = safeReadFile(fullPath)
      if (content !== null && content !== files.get(relativePath)) {
        // Wrap Y.js operation in try-catch to prevent crashes
        try {
          files.set(relativePath, content)
          log(`[${name}] Local change: ${relativePath}`)
        } catch (yjsError) {
          console.error(`Error updating Y.js document for ${relativePath}:`, yjsError.message)
        }
      }
    } catch (error) {
      console.error(`Error handling change for ${relativePath}:`, error.message)
    }
  })
  
  // Handle new files
  watcher.on('add', (fullPath) => {
    if (syncState.isUpdatingFromGUI()) {
      return
    }
    
    const relativePath = path.relative(process.cwd(), fullPath)
    
    if (IGNORED_PATHS.some(ignored => relativePath.includes(ignored))) {
      return
    }
    
    if (allowedFiles && !allowedFiles.includes(relativePath)) {
      return
    }
    
    try {
      const content = safeReadFile(fullPath)
      if (content !== null && !files.has(relativePath)) {
        // Wrap Y.js operation in try-catch to prevent crashes
        try {
          files.set(relativePath, content)
          log(`[${name}] Local add: ${relativePath}`)
        } catch (yjsError) {
          console.error(`Error adding file to Y.js document ${relativePath}:`, yjsError.message)
        }
      }
    } catch (error) {
      console.error(`Error handling new file ${relativePath}:`, error.message)
    }
  })
  
  // Handle file deletions
  watcher.on('unlink', (fullPath) => {
    if (syncState.isUpdatingFromGUI()) {
      return
    }
    
    const relativePath = path.relative(process.cwd(), fullPath)
    
    if (files.has(relativePath)) {
      try {
        files.delete(relativePath)
        log(`[${name}] Local delete: ${relativePath}`)
      } catch (yjsError) {
        console.error(`Error deleting file from Y.js document ${relativePath}:`, yjsError.message)
      }
    }
  })
  
  return {
    watcher,
    cleanup: () => {
      watcher.close()
    }
  }
}

// Main Session
const createSession = (interfaceConfig, signalingServer, interfaceUrls = null) => {
  const { host, name, allowedFiles } = createInterfaceConfig(interfaceConfig)
  const pipeId = `ghostpipe-${Math.random().toString(36).substring(7)}`
  const { ydoc, provider } = createProvider(pipeId, signalingServer)
  
  log(`\nPipe created for ${name}: ${pipeId}`)
  const url = generateUrl(host, pipeId, signalingServer)
  console.log(`${name}: ${url}`)
  
  // Store URL if collecting for manager
  if (interfaceUrls !== null) {
    interfaceUrls[name] = url
  }
  
  // Auto-open browser if configured
  if (typeof interfaceConfig === 'object' && interfaceConfig.open === true) {
    openBrowser(url)
  }
  
  const files = ydoc.getMap('files')
  setupSessionMetadata(ydoc)
  
  // Load initial files
  const allFiles = getAllFiles(process.cwd(), '', [], allowedFiles)
  log(`[${name}] Loading ${allFiles.length} files...`)
  if (allowedFiles) {
    log(`[${name}] Allowed files filter: ${JSON.stringify(allowedFiles)}`)
  }
  allFiles.forEach(file => {
    files.set(file.path, file.content)
    log(`[${name}] Loaded file: ${file.path}`)
  })
  
  // Setup file synchronization
  const syncState = setupFileSync(files, allowedFiles, name)
  const fileWatching = setupFileWatching(allFiles, files, name, allowedFiles, syncState)
  
  return {
    provider,
    cleanup: () => {
      provider.destroy()
      fileWatching.cleanup()
    }
  }
}

// Diff Session
const createDiffSession = (interfaceConfig, baseBranch, headBranch, signalingServer, interfaceUrls = null) => {
  const { name = 'Default', host, files: allowedFiles = null } = typeof interfaceConfig === 'string' 
    ? { host: interfaceConfig, name: 'Default', files: null }
    : interfaceConfig
  const pipeId = `ghostpipe-diff-${Math.random().toString(36).substring(7)}`
  const { ydoc, provider } = createProvider(pipeId, signalingServer)
  
  log(`\nDiff pipe created for ${name}: ${pipeId}`)
  
  const baseFiles = ydoc.getMap('base-files')
  const headFiles = ydoc.getMap('head-files')
  const metadata = ydoc.getMap('metadata')
  
  // Check if head is current working branch
  const isWorkingDirectory = (() => {
    try {
      return execSync('git branch --show-current').toString().trim() === headBranch
    } catch {
      return false
    }
  })()
  
  metadata.set('mode', 'diff')
  metadata.set('baseBranch', baseBranch)
  metadata.set('headBranch', headBranch)
  metadata.set('created', new Date().toISOString())
  metadata.set('includesWorkingDirectory', isWorkingDirectory)
  
  try {
    // Get changed files - using exact original logic
    const changedFilesOutput = isWorkingDirectory
      ? Array.from(new Set([
          ...execSync(`git diff --name-only ${baseBranch}...${headBranch}`).toString().trim().split('\n').filter(Boolean),
          ...execSync(`git diff --name-only ${baseBranch}`).toString().trim().split('\n').filter(Boolean)
        ])).join('\n')
      : execSync(`git diff --name-only ${baseBranch}...${headBranch}`).toString().trim()
    
    if (!changedFilesOutput) {
      console.log(`[${name}] No files changed between branches`)
      metadata.set('changedFiles', [])
      return {
        provider,
        cleanup: () => provider.destroy()
      }
    }
    
    const changedFiles = changedFilesOutput.split('\n')
      .filter(file => !allowedFiles || allowedFiles.includes(file))
    
    metadata.set('changedFiles', changedFiles)
    log(`[${name}] Loading ${changedFiles.length} changed files...`)
    
    // Load files from both branches - using exact original logic
    changedFiles.forEach(file => {
      // Base branch
      try {
        baseFiles.set(file, execSync(`git show ${baseBranch}:${file} 2>/dev/null`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore']
        }))
      } catch {
        baseFiles.set(file, '') // New file
      }
      
      // Head branch
      if (isWorkingDirectory) {
        try {
          const filePath = path.join(process.cwd(), file)
          headFiles.set(file, fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '')
        } catch {
          headFiles.set(file, '')
        }
      } else {
        try {
          headFiles.set(file, execSync(`git show ${headBranch}:${file} 2>/dev/null`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
          }))
        } catch {
          headFiles.set(file, '') // Deleted file
        }
      }
    })
  } catch (error) {
    console.error('Error getting diff:', error.message)
    provider.destroy()
    process.exit(1)
  }
  
  const url = generateUrl(host, pipeId, signalingServer, 'diff')
  console.log(`${name}: ${url}`)
  log(`  Comparing: ${baseBranch} ↔ ${headBranch}${isWorkingDirectory ? ' (with working changes)' : ''}`)
  
  // Store URL if collecting for manager
  if (interfaceUrls !== null) {
    interfaceUrls[name] = url
  }
  
  // Auto-open browser if configured
  if (typeof interfaceConfig === 'object' && interfaceConfig.open === true) {
    openBrowser(url)
  }
  
  let watcher = null
  
  // Watch working directory changes if applicable
  if (isWorkingDirectory) {
    const changedFiles = metadata.get('changedFiles') || []
    log(`[${name}] Setting up file watchers for ${changedFiles.length} files in working directory`)
    
    // Create full paths for changed files
    const filesToWatch = changedFiles.map(file => path.join(process.cwd(), file))
    
    // Create chokidar watcher for diff mode
    watcher = chokidar.watch(filesToWatch, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 100
      },
      usePolling: false, // Avoid polling to reduce CPU usage
      followSymlinks: false, // Don't follow symlinks to avoid loops
      atomic: true // Handle atomic writes
    })
    
    // Handle file changes
    watcher.on('change', (fullPath) => {
      const relativePath = path.relative(process.cwd(), fullPath)
      log(`[${name}] Detected change for: ${relativePath}`)
      
      try {
        const content = fs.readFileSync(fullPath, 'utf8')
        const currentContent = headFiles.get(relativePath)
        
        log(`[${name}] File size - old: ${currentContent ? currentContent.length : 0}, new: ${content.length}`)
        
        if (content !== currentContent) {
          // Use Y.js transaction to ensure proper sync
          ydoc.transact(() => {
            headFiles.set(relativePath, content)
          })
          log(`[${name}] Updated file in diff: ${relativePath} (${content.length} bytes)`)
        } else {
          log(`[${name}] File content unchanged: ${relativePath}`)
        }
      } catch (err) {
        console.error(`[${name}] Error reading changed file ${relativePath}:`, err.message)
      }
    })
    
    // Handle file deletions
    watcher.on('unlink', (fullPath) => {
      const relativePath = path.relative(process.cwd(), fullPath)
      log(`[${name}] File deleted: ${relativePath}`)
      
      // Update headFiles to reflect deletion
      if (headFiles.has(relativePath)) {
        ydoc.transact(() => {
          headFiles.set(relativePath, '')
        })
        log(`[${name}] Marked file as deleted in diff: ${relativePath}`)
      }
    })
    
    // Handle new files (if they were previously tracked but recreated)
    watcher.on('add', (fullPath) => {
      const relativePath = path.relative(process.cwd(), fullPath)
      log(`[${name}] File added: ${relativePath}`)
      
      try {
        const content = fs.readFileSync(fullPath, 'utf8')
        ydoc.transact(() => {
          headFiles.set(relativePath, content)
        })
        log(`[${name}] Added file to diff: ${relativePath}`)
      } catch (err) {
        console.error(`[${name}] Error reading new file ${relativePath}:`, err.message)
      }
    })
  }
  
  return {
    provider,
    cleanup: () => {
      provider.destroy()
      if (watcher) {
        watcher.close()
      }
    }
  }
}

// Git Utilities
const gitUtils = {
  verifyRepo: () => {
    try {
      execSync('git rev-parse --git-dir', { stdio: 'ignore' })
      return true
    } catch {
      console.error('Error: Not in a git repository')
      process.exit(1)
    }
  },
  
  getCurrentBranch: () => {
    try {
      const branch = execSync('git branch --show-current').toString().trim()
      if (!branch) {
        throw new Error('Detached HEAD state')
      }
      return branch
    } catch (error) {
      console.error('Error getting current branch:', error.message)
      process.exit(1)
    }
  },
  
  getDefaultBranch: () => {
    const branches = ['main', 'master']
    
    for (const branch of branches) {
      try {
        execSync(`git show-ref --verify refs/heads/${branch}`, { stdio: 'ignore' })
        return branch
      } catch {
        continue
      }
    }
    
    console.error('Error: No main or master branch found')
    process.exit(1)
  },
  
  verifyBranch: (branch) => {
    try {
      execSync(`git show-ref --verify refs/heads/${branch}`, { stdio: 'ignore' })
    } catch {
      console.error(`Error: Branch '${branch}' does not exist`)
      process.exit(1)
    }
  }
}

// Command Handlers
const handleDiff = (config, signalingServer, diffArgs) => {
  gitUtils.verifyRepo()
  
  const currentBranch = gitUtils.getCurrentBranch()
  const defaultBranch = gitUtils.getDefaultBranch()
  const baseBranch = diffArgs[0] || defaultBranch
  const headBranch = diffArgs[1] || currentBranch
  
  if (diffArgs.length > 2) {
    console.error('Error: Too many arguments for diff command')
    process.exit(1)
  }
  
  gitUtils.verifyBranch(baseBranch)
  gitUtils.verifyBranch(headBranch)
  
  if (!config.interfaces || config.interfaces.length === 0) {
    console.error('Error: No interfaces configured. Please create a .ghostpipe.json config file.')
    process.exit(1)
  }
  
  console.log(`\nComparing: ${baseBranch} ↔ ${headBranch}${currentBranch === headBranch ? ' (with working changes)' : ''}`)
  
  // Check if any interface is a manager
  const hasManager = config.interfaces.some(iface => iface.manager === true)
  
  if (hasManager) {
    // Collect URLs for all interfaces and share them with manager interfaces
    const interfaceUrls = {}
    const sessions = config.interfaces.map(interfaceConfig => {
      const session = createDiffSession(interfaceConfig, baseBranch, headBranch, signalingServer, interfaceUrls)
      return session
    })
    
    // Share the collected URLs with all manager interfaces
    sessions.forEach((session, index) => {
      if (config.interfaces[index].manager === true && session.provider) {
        const metadata = session.provider.doc.getMap('metadata')
        metadata.set('interfaceUrls', interfaceUrls)
        log(`[Manager] Shared ${Object.keys(interfaceUrls).length} interface URLs`)
      }
    })
    
    return sessions.map(s => s.cleanup)
  }
  
  return config.interfaces.map(interfaceConfig => createDiffSession(interfaceConfig, baseBranch, headBranch, signalingServer).cleanup)
}

const handleFileSharing = (config, signalingServer, options) => {
  if (!config.interfaces || config.interfaces.length === 0) {
    console.error('Error: No interfaces configured. Please create a .ghostpipe.json config file with an "interfaces" array.')
    process.exit(1)
  }
  
  log(`Starting with ${config.interfaces.length} interface(s)...`)
  
  // Check if any interface is a manager
  const hasManager = config.interfaces.some(iface => iface.manager === true)
  
  if (hasManager) {
    // Collect URLs for all interfaces and share them with manager interfaces
    const interfaceUrls = {}
    const sessions = config.interfaces.map(interfaceConfig => {
      const session = createSession(interfaceConfig, signalingServer, interfaceUrls)
      return session
    })
    
    // Share the collected URLs with all manager interfaces
    sessions.forEach((session, index) => {
      if (config.interfaces[index].manager === true && session.provider) {
        const metadata = session.provider.doc.getMap('metadata')
        metadata.set('interfaceUrls', interfaceUrls)
        log(`[Manager] Shared ${Object.keys(interfaceUrls).length} interface URLs`)
      }
    })
    
    return sessions.map(s => s.cleanup)
  }
  
  return config.interfaces.map(interfaceConfig => createSession(interfaceConfig, signalingServer).cleanup)
}

const setupShutdownHandler = (cleanups) => {
  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    cleanups.forEach(cleanup => cleanup())
    process.exit(0)
  })
  
  // Handle segmentation faults and other crashes
  process.on('uncaughtException', (error) => {
    console.error('\nUncaught exception:', error.message)
    console.error(error.stack)
    cleanups.forEach(cleanup => {
      try {
        cleanup()
      } catch (cleanupError) {
        // Ignore cleanup errors during crash
      }
    })
    process.exit(1)
  })
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error('\nUnhandled Rejection at:', promise, 'reason:', reason)
    // Don't exit on unhandled rejection, just log it
  })
}

// Main
const program = new Command()

program
  .name('ghostpipe')
  .description('CLI tool that connects codebase files to GUIs (requires interfaces configuration)')
  .version(require('../package.json').version)
  .option('--verbose', 'Enable verbose logging')

// Default file sharing action
program.action((options) => {
  VERBOSE = options.verbose
  const config = loadConfig()
  const signalingServer = config.signalingServer || DEFAULT_SIGNALING
  
  const cleanups = handleFileSharing(config, signalingServer, options)
  console.log('\nPress Ctrl+C to stop.')
  setupShutdownHandler(cleanups)
})

// Diff command
program
  .command('diff')
  .description('Compare files between git branches')
  .argument('[base]', 'Base branch (defaults to main/master)')
  .argument('[head]', 'Head branch (defaults to current)')
  .action((base, head, options) => {
    VERBOSE = program.opts().verbose
    const config = loadConfig()
    const signalingServer = config.signalingServer || DEFAULT_SIGNALING
    
    const diffArgs = [base, head].filter(Boolean)
    const cleanups = handleDiff(config, signalingServer, diffArgs)
    console.log('\nPress Ctrl+C to stop.')
    setupShutdownHandler(cleanups)
  })

program.parse()
