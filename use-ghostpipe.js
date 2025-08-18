'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import * as Y from 'yjs'
import { WebrtcProvider } from 'y-webrtc'

export function useGhostpipe() {
  const searchParams = useSearchParams()
  const [connected, setConnected] = useState(false)
  const [metadata, setMetadata] = useState({})
  const [files, setFiles] = useState(new Map())
  const [baseFiles, setBaseFiles] = useState(new Map())
  const [headFiles, setHeadFiles] = useState(new Map())
  const [provider, setProvider] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    const pipe = searchParams.get('pipe')
    const signalingParam = searchParams.get('signaling')
    
    if (!pipe) {
      setError('No pipe parameter provided. Please connect via the ghostpipe CLI.')
      return
    }

    if (!signalingParam) {
      setError('No signaling parameter provided. Please connect via the ghostpipe CLI.')
      return
    }

    const ydoc = new Y.Doc()
    
    // Decode the signaling server URL from the parameter
    const signalingServer = decodeURIComponent(signalingParam)
    
    const webrtcProvider = new WebrtcProvider(pipe, ydoc, {
      signaling: [signalingServer]
    })
    
    setProvider(webrtcProvider)
    
    // Get all possible maps
    const filesMap = ydoc.getMap('files')
    const baseFilesMap = ydoc.getMap('base-files')
    const headFilesMap = ydoc.getMap('head-files')
    const metadataMap = ydoc.getMap('metadata')
    
    const updateFiles = () => {
      const filesData = new Map()
      filesMap.forEach((value, key) => {
        filesData.set(key, value)
      })
      setFiles(new Map(filesData))
    }
    
    const updateBaseFiles = () => {
      const filesData = new Map()
      baseFilesMap.forEach((value, key) => {
        filesData.set(key, value)
      })
      setBaseFiles(new Map(filesData))
    }
    
    const updateHeadFiles = () => {
      const filesData = new Map()
      headFilesMap.forEach((value, key) => {
        filesData.set(key, value)
      })
      setHeadFiles(new Map(filesData))
    }
    
    const updateMetadata = () => {
      const metadataData = {}
      metadataMap.forEach((value, key) => {
        metadataData[key] = value
      })
      setMetadata(metadataData)
    }
    
    // Observe changes
    filesMap.observe(updateFiles)
    baseFilesMap.observe(updateBaseFiles)
    headFilesMap.observe(updateHeadFiles)
    metadataMap.observe(updateMetadata)
    
    // Connection status handlers
    webrtcProvider.on('status', ({ status }) => {
      setConnected(status === 'connected')
    })
    
    webrtcProvider.on('synced', () => {
      setConnected(true)
    })
    
    // Initial updates
    updateFiles()
    updateBaseFiles()
    updateHeadFiles()
    updateMetadata()
    
    // Check if we have data (which means we're synced even if not "connected")
    if (filesMap.size > 0 || baseFilesMap.size > 0 || headFilesMap.size > 0) {
      setConnected(true)
    }
    
    return () => {
      webrtcProvider.destroy()
    }
  }, [searchParams])

  const updateFile = useCallback((fileName, content) => {
    if (provider && provider.doc) {
      const filesMap = provider.doc.getMap('files')
      filesMap.set(fileName, content)
    }
  }, [provider])

  // Auto-detect mode based on available data
  const isDiffMode = baseFiles.size > 0 || headFiles.size > 0
  const isFilesMode = files.size > 0

  return {
    connected,
    error,
    metadata,
    files,
    baseFiles,
    headFiles,
    provider,
    updateFile,
    isDiffMode,
    isFilesMode,
    pipe: searchParams.get('pipe'),
    signalingServer: searchParams.get('signaling')
  }
}

