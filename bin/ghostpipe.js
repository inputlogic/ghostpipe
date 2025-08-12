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
  
  // Add "Hello world" to the files
  files.set('welcome.txt', 'Hello world')
  
  // Keep the process running
  console.log('\nGhostpipe is running. Press Ctrl+C to stop.')
  
  // Handle cleanup on exit
  process.on('SIGINT', () => {
    console.log('\nShutting down Ghostpipe...')
    provider.destroy()
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
