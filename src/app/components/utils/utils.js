import { existsSync, mkdirSync, rmdirSync } from 'fs'
import { join } from 'path'

const elm = (selector) => document.querySelector(selector)

const createElm = (type, className = '', style = {}) => {
    const elm = document.createElement(type)
    elm.className = className
    Object.entries(style).forEach(([key, value]) => elm.style[key] = value)
    return elm
}

const isGameFolderSet = () => localStorage.getItem('game_folder') != null

// Game folder
const getGameFolder = (...props) => join(localStorage.getItem('game_folder'), ...props.map(e => e.toString()))

// Game archives original folder
const getArchiveFolder = (...props) => getGameFolder('archives', ...props.map(e => e.toString()))

// Game archives backup
const getBackupFolder = (...props) => {
    const folder = getGameFolder('custom_data', 'originals')
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
    return join(folder, ...props.map(e => e.toString()))
}

// Uncompressed files cache
const getCacheFolder = (...props) => {
    const folder = getGameFolder('custom_data', 'cache')
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
    else {
        // Clear cache if version changed
        const current_cache_version = '1'
        if (localStorage.getItem('cache-version') !== current_cache_version) {
            localStorage.setItem('cache-version', current_cache_version)
            rmdirSync(folder, { recursive: true})
            mkdirSync(folder, { recursive: true })
            console.log('Cache cleared')
        }
    }
    return join(folder, ...props.map(e => e.toString()))
}

// Temp files folder
const getTempFolder = (...props) => {
    const folder = getGameFolder('custom_data', 'tmp')
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
    return join(folder, ...props.map(e => e.toString()))
}

export { 
    elm,
    createElm,
    isGameFolderSet,
    getGameFolder,
    getArchiveFolder,
    getBackupFolder,
    getCacheFolder,
    getTempFolder
}