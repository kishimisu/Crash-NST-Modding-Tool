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
    return join(folder, ...props.map(e => e.toString()))
}

// Uncompressed textures cache
const getTextureFolder = (...props) => {
    const folder = getGameFolder('custom_data', 'textures')
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
    return join(folder, ...props.map(e => e.toString()))
}

// Model drawcalls cache
const getModelFolder = (...props) => {
    const folder = getGameFolder('custom_data', 'models')
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
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
    getTextureFolder,
    getModelFolder,
    getTempFolder,
}