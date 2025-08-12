#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const os = require('os')
const { Doc: YDoc } = require('yjs')
const { WebrtcProvider } = require('y-webrtc')
const wrtc = require('@roamhq/wrtc')

const args = process.argv.slice(2)

const DEFAULT_HOST = 'https://ghostpipe.dev'
const DEFAULT_SIGNALING_SERVER = 'wss://signaling.ghostpipe.dev'

const loadConfig = () => {
  const localConfigPath = path.join(process.cwd(), '.ghostpipe.json')
  const globalConfigPath = path.join(os.homedir(), '.config', 'ghostpipe.json')
  
  // Try local config first (highest priority)
  try {
    if (fs.existsSync(localConfigPath)) {
      const configData = fs.readFileSync(localConfigPath, 'utf8')
      return JSON.parse(configData)
    }
  } catch (error) {
    console.error('Error loading local config:', error.message)
  }
  
  // Try global config second
  try {
    if (fs.existsSync(globalConfigPath)) {
      const configData = fs.readFileSync(globalConfigPath, 'utf8')
      return JSON.parse(configData)
    }
  } catch (error) {
    console.error('Error loading global config:', error.message)
  }
  
  return {}
}

const getAllFiles = (dirPath, basePath = '', fileList = []) => {
  const files = fs.readdirSync(dirPath)
  
  files.forEach(file => {
    const filePath = path.join(dirPath, file)
    const relativePath = path.join(basePath, file)
    
    // Skip hidden files, node_modules, and common build directories
    if (file.startsWith('.') || 
        file === 'node_modules' || 
        file === 'dist' || 
        file === 'build' ||
        file === '.git') {
      return
    }
    
    const stat = fs.statSync(filePath)
    
    if (stat.isDirectory()) {
      getAllFiles(filePath, relativePath, fileList)
    } else if (stat.isFile()) {
      try {
        const content = fs.readFileSync(filePath, 'utf8')
        fileList.push({ path: relativePath, content })
      } catch (err) {
        // Skip files that can't be read as text
        console.warn(`Skipping binary or unreadable file: ${relativePath}`)
      }
    }
  })
  
  return fileList
}

const parseArgs = (args) => {
  const parsed = {
    host: null,
    command: null,
    showHelp: false,
    showVersion: false
  }
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    
    if (arg === '--help') {
      parsed.showHelp = true
    } else if (arg === '-h' || arg === '--host') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        parsed.host = args[i + 1]
        i++
      } else if (arg === '-h') {
        parsed.showHelp = true
      }
    } else if (arg === '-v' || arg === '--version') {
      parsed.showVersion = true
    } else if (!arg.startsWith('-')) {
      parsed.command = arg
    }
  }
  
  return parsed
}

const createSession = (host, signalingServer) => {
  // Generate a random pipe ID for this session
  const pipeId = `ghostpipe-${Math.random().toString(36).substring(7)}`
  
  // Create a new Y.js document
  const ydoc = new YDoc()
  
  // Create WebRTC provider for collaboration
  const provider = new WebrtcProvider(pipeId, ydoc, {
    signaling: [signalingServer],
    peerOpts: {
      wrtc: wrtc
    }
  })
  
  console.log(`Pipe created: ${pipeId}`)
  
  // URL-encode the signaling server URL
  const encodedSignaling = encodeURIComponent(signalingServer)
  
  // Parse host to build proper URL
  let connectUrl
  if (host.startsWith('http://') || host.startsWith('https://')) {
    connectUrl = `${host}?pipe=${pipeId}&signaling=${encodedSignaling}`
  } else {
    // Assume http:// if no protocol specified
    connectUrl = `http://${host}?pipe=${pipeId}&signaling=${encodedSignaling}`
  }
  
  console.log(`Connect at: ${connectUrl}`)
  
  // Set up basic Y.js data structures
  const files = ydoc.getMap('files')
  const metadata = ydoc.getMap('metadata')
  
  // Initialize metadata
  metadata.set('created', new Date().toISOString())
  metadata.set('cwd', process.cwd())
  
  // Load all files from current directory
  console.log('Loading files from current directory...')
  const allFiles = getAllFiles(process.cwd())
  
  if (allFiles.length === 0) {
    console.log('No files found in current directory')
    files.set('welcome.txt', 'No files found in the current directory')
  } else {
    console.log(`Loading ${allFiles.length} files...`)
    allFiles.forEach(file => {
      files.set(file.path, file.content)
    })
    console.log(`Loaded ${allFiles.length} files`)
  }
  
  // Track if we're currently updating from GUI to avoid loops
  let updatingFromGUI = false
  
  // Watch for changes from the GUI and write them back to filesystem
  files.observe((event) => {
    updatingFromGUI = true
    event.changes.keys.forEach((change, key) => {
      if (change.action === 'update' || change.action === 'add') {
        const content = files.get(key)
        const filePath = path.join(process.cwd(), key)
        
        try {
          // Create directory if it doesn't exist
          const dir = path.dirname(filePath)
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
          }
          
          // Write the file
          fs.writeFileSync(filePath, content, 'utf8')
          console.log(`Updated file: ${key}`)
        } catch (err) {
          console.error(`Error writing file ${key}:`, err.message)
        }
      } else if (change.action === 'delete') {
        const filePath = path.join(process.cwd(), key)
        
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
            console.log(`Deleted file: ${key}`)
          }
        } catch (err) {
          console.error(`Error deleting file ${key}:`, err.message)
        }
      }
    })
    updatingFromGUI = false
  })
  
  // Watch for local filesystem changes
  const watchedFiles = new Map()
  const watchTimeout = new Map()
  
  const watchFile = (relativePath) => {
    const fullPath = path.join(process.cwd(), relativePath)
    
    if (watchedFiles.has(relativePath)) {
      return
    }
    
    try {
      const watcher = fs.watch(fullPath, (eventType) => {
        // Debounce rapid changes
        if (watchTimeout.has(relativePath)) {
          clearTimeout(watchTimeout.get(relativePath))
        }
        
        watchTimeout.set(relativePath, setTimeout(() => {
          if (!updatingFromGUI) {
            if (eventType === 'change') {
              try {
                const content = fs.readFileSync(fullPath, 'utf8')
                const currentContent = files.get(relativePath)
                if (content !== currentContent) {
                  files.set(relativePath, content)
                  console.log(`Local file changed: ${relativePath}`)
                }
              } catch (err) {
                console.error(`Error reading changed file ${relativePath}:`, err.message)
              }
            }
          }
          watchTimeout.delete(relativePath)
        }, 100))
      })
      
      watchedFiles.set(relativePath, watcher)
    } catch (err) {
      console.error(`Error watching file ${relativePath}:`, err.message)
    }
  }
  
  // Start watching all initial files
  allFiles.forEach(file => {
    watchFile(file.path)
  })
  
  // Watch the current directory for new files
  const dirWatcher = fs.watch(process.cwd(), { recursive: true }, (eventType, filename) => {
    if (!filename || updatingFromGUI) return
    
    // Skip ignored paths
    if (filename.startsWith('.') || 
        filename.includes('node_modules') || 
        filename.includes('dist') || 
        filename.includes('build') ||
        filename.includes('.git')) {
      return
    }
    
    const fullPath = path.join(process.cwd(), filename)
    
    // Debounce directory changes
    if (watchTimeout.has(filename)) {
      clearTimeout(watchTimeout.get(filename))
    }
    
    watchTimeout.set(filename, setTimeout(() => {
      try {
        if (fs.existsSync(fullPath)) {
          const stat = fs.statSync(fullPath)
          if (stat.isFile()) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8')
              const currentContent = files.get(filename)
              if (content !== currentContent) {
                files.set(filename, content)
                console.log(`Local file added/changed: ${filename}`)
                watchFile(filename)
              }
            } catch (err) {
              // Skip binary files
            }
          }
        } else {
          // File was deleted
          if (files.has(filename)) {
            files.delete(filename)
            console.log(`Local file deleted: ${filename}`)
            if (watchedFiles.has(filename)) {
              watchedFiles.get(filename).close()
              watchedFiles.delete(filename)
            }
          }
        }
      } catch (err) {
        console.error(`Error handling file change for ${filename}:`, err.message)
      }
      watchTimeout.delete(filename)
    }, 100))
  })
  
  // Keep the process running
  console.log('\nGhostpipe is running. Press Ctrl+C to stop.')
  
  // Handle cleanup on exit
  process.on('SIGINT', () => {
    console.log('\nShutting down Ghostpipe...')
    provider.destroy()
    
    // Clean up file watchers
    watchedFiles.forEach(watcher => watcher.close())
    dirWatcher.close()
    
    process.exit(0)
  })
}

const main = () => {
  const parsed = parseArgs(args)
  
  if (parsed.showHelp) {
    console.log('ghostpipe - CLI tool')
    console.log('\nUsage:')
    console.log('  ghostpipe [options] [command]')
    console.log('\nOptions:')
    console.log('  --help         Show help')
    console.log('  -h, --host     Specify host URL')
    console.log('  -v, --version  Show version')
    return
  }

  if (parsed.showVersion) {
    const { version } = require('../package.json')
    console.log(`ghostpipe v${version}`)
    return
  }
  
  const config = loadConfig()
  const resolvedHost = parsed.host || config.host || DEFAULT_HOST
  const signalingServer = config.signalingServer || DEFAULT_SIGNALING_SERVER
  
  if (parsed.command) {
    console.log('Unknown command:', parsed.command)
    console.log('Run "ghostpipe --help" for usage information')
    process.exit(1)
  }
  
  // No command provided - create a Y.js session
  createSession(resolvedHost, signalingServer)
}

main()
