import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { exec } from 'child_process'
import { ipcRenderer } from 'electron'
import InspireTree from 'inspire-tree'
import InspireTreeDOM from 'inspire-tree-dom'
import hljs from 'highlight.js/lib/core'
import jsonLang from 'highlight.js/lib/languages/json'

import IGZ from '../igz/igz.js'
import Pak from '../pak/pak.js'
import { resetDataViewTable, resetDataTypeTable } from './components/igz_view.js'
import { init_file_import_modal } from './components/import_modal.js'
import { elm } from './utils.js'

import levels from '../../assets/crash/levels.txt'
import '../../assets/styles/style.css'
import '../../assets/styles/inspire.css'
import '../../assets/styles/hljs.css'

hljs.registerLanguage('json', jsonLang)

const nstPath = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Crash Bandicoot - N Sane Trilogy\\'

let pak  // Current Pak instance
let igz  // Current Igz instance 
let tree // Main tree (left)
let treePreview // IGZ preview tree (right)

/**
 * Main manager for window content and app state
 */
class Main {
    static treeMode = 'pak' // Current main tree mode ('igz' or 'pak')

    static lastCollapsedState = null
    static lastFileIndex = null

    static pak = null
    static igz = null
    static tree = null

    static updatedBytes = {} // Updated bytes in IGZ file (for hex view coloring)

    static setPak(_pak) { this.pak = pak = _pak }

    static createMainTree(props) { 
        return this.tree = tree = this.createTree('.tree', props) 
    }

    static createTree(target = '.tree', props = {}) {
        const tree = new InspireTree(props)

        // Recursively expand nodes with only one child
        tree.on('node.expanded', (node) => {
            if (node.children.length === 1) {
                node.children[0].expand()
            }
        })
    
        new InspireTreeDOM(tree, { target })

        return tree
    }

    // Init main tree view for PAK file
    static showPAKTree() {
        this.treeMode = 'pak'
        
        tree.load([]) // Needed to prevent weird crash
        tree.load(pak.toNodeTree())
        tree.get(0).expand()

        this.colorizeMainTree()
        this.updateTitle()

        // Reset right panel
        resetDataViewTable()
        resetDataTypeTable()

        elm('#pak-import').style.display = 'block' // Show import button
        elm('#back-pak').style.display = 'none'    // Hide back button
        elm('#data-struct').style.display = 'none' // Hide data struct
        elm('#auto-refresh').checked = true
        elm('#use-current-pak').parentNode.style.display = 'flex'
    }

    // Init main tree view for IGZ file
    static showIGZTree() {
        if (igz == null) return

        this.treeMode = 'igz'
        tree.load(igz.toNodeTree())
        tree.each(e => e.expand())

        this.updatedBytes = {}

        this.colorizeMainTree()
        this.hideIGZPreview()
        this.setSyntaxHighlightedCode(igz)
        this.updateTitle()

        elm('#pak-import').style.display = 'none'
        elm('#back-pak').style.display = pak == null ? 'none' : 'block'
        elm('#auto-refresh').checked = igz.objects.length < 500
        elm('#use-current-pak').parentNode.style.display = 'none'
    }

    // Reload main tree view, keeping expanded state and selected node
    static reloadTree(data) {
        const expandedState = tree.available().map(e => e.expanded())
        const selectedNode = tree.lastSelectedNode()?.fileIndex

        tree.load([])
        tree.load(data)
        this.colorizeMainTree()
        this.updateTitle()

        tree.available().forEach((e, i) => {
            if (expandedState[i]) e.expand()                        
            if (e.fileIndex === selectedNode) e.select()
        })
    }

    // Apply colors to tree nodes depending on their updated status
    static colorizeMainTree() {
        tree.available().forEach(e => {
            // PAK file node
            if (e.type === 'file') {
                if (pak.files[e.fileIndex].updated)
                    e.itree.ref.style.color = '#ffaf36'
                else if (!pak.files[e.fileIndex].original)
                    e.itree.ref.style.color = '#21ff78'
                else
                    e.itree.ref.style.color = ''
            }
            // PAK folder node
            else if (e.type === 'folder') {
                e.itree.ref.childNodes[0].style.color = e.updated ? '#ffaf36' : ''
            }
            // IGZ object node
            else if (e.type === 'object') {
                if (igz.objects[e.objectIndex].updated)
                    e.itree.ref.style.color = '#ffaf36'
            }
        })
    }

    // Show IGZ content preview in PAK tree
    static async showIGZPreview(fileIndex) {
        const file = pak.files[fileIndex]

        igz = null
        
        elm('#data-struct').style.overflow = 'visible'
        elm('#tree-preview-ctn').style.display = 'block'

        const buffer = await pak.files[fileIndex].getUncompressedData()

        try {
            igz = new IGZ(buffer, pak.files[fileIndex].path)
        }
        catch (e) {
            treePreview.load([{ 
                text: 'There was an error loading this file.',
                children: [{ text: e.message }],
            }])
            treePreview.get(0).itree.ref.style.color = '#e3483a'
            return
        }

        this.igz = igz

        treePreview.load(igz.toNodeTree())
        treePreview.get(2).expand()
    }

    // Hide IGZ content preview
    static hideIGZPreview() {
        elm('#tree-preview-ctn').style.display = 'none'
        elm('#data-struct').style.overflow = 'auto'
        treePreview.removeAll()
    }

    // Set syntax highlighted code in JSON view
    static setSyntaxHighlightedCode(object) {
        if (object.toString() !== '[object Object]') object = object.toString()
        const value = hljs.highlight(JSON.stringify(object, null, 4), { language: 'json' }).value
        elm('#data').innerHTML = value
        elm('#data-struct').style.display = 'block'
    }

    // Hide JSON view
    static hideStructView() {
        elm('#data-struct').style.display = 'none'
    }

    // Update window title depending on current file and changes
    static updateTitle() {
        if (this.treeMode === 'pak') {
            document.title = 'The apprentice - ' + pak.path + (pak.updated ? '*' : '')
        }
        else if (this.treeMode === 'igz') {
            let title = igz.path + (igz.updated ? '*' : '')
            document.title = 'The apprentice - ' + (pak == null ? title : pak.path + ' -> ' + title)
        }
    }

    // Remove all trailing '*' from tree node names
    static setAllNodesToUpdated() {
        tree.available().each(e => {
            if (e.text.endsWith('*')) {
                e.set('text', e.text.slice(0, -1))
            }
        })
        Main.colorizeMainTree()
    }

    static saveTreeExpandedState() {
        this.lastCollapsedState = tree.available().map(e => e.expanded())
        this.lastFileIndex = tree.lastSelectedNode().fileIndex
    }

    static restoreTreeExpandedState() {
        if (this.lastCollapsedState == null) return
        tree.available().forEach((e, i) => {
            if (this.lastCollapsedState[i]) e.expand()
            if (e.fileIndex === this.lastFileIndex) e.select()                       
        })
    }
}

/**
 * Handles a click on a tree node (in the main tree)
 */
async function onNodeClick(event, node) 
{
    // Clicked a file in PAK
    if (Main.treeMode === 'pak') {
        if (node.type === 'folder') {
            Main.hideIGZPreview()
            Main.setSyntaxHighlightedCode({
                path: node.path,
                file_count: node.file_count,
                size: node.size,
                children: node.children.map(e => e.text),
            })
        }
        else if (node.type === 'file') {
            if (node.text.replaceAll('*', '').endsWith('.igz')) 
                Main.showIGZPreview(node.fileIndex)                
            else 
                Main.hideIGZPreview()

            Main.setSyntaxHighlightedCode(pak.files[node.fileIndex])
        }
    }
    // Clicked a file in IGZ
    else if (Main.treeMode === 'igz') {
        // Fixup node
        if (node.type === 'fixup') {
            const fixup = igz.fixups[node.fixup]
            Main.setSyntaxHighlightedCode(fixup)
            resetDataViewTable()
            resetDataTypeTable()
            return
        }
        // Fixup child node
        else if (node.type === 'offset') {
            const fixup = igz.fixups[node.fixup]
            if (fixup && fixup.isEncoded()) {
                const child = fixup.getCorrespondingObject(node.offset, igz.objects)?.object// igz.objects.find(e => node.offset >= e.offset && node.offset < e.offset + e.size)
                Main.setSyntaxHighlightedCode(child)
                child.createDataViewTable(Main)
            }
            else {
                Main.hideStructView()
                resetDataViewTable()
                resetDataTypeTable()
            }
        }
        // Object node
        else if (node.type === 'object') {
            const object = igz.objects[node.objectIndex]
            Main.setSyntaxHighlightedCode(object)
            object.createDataViewTable(Main)

            if (elm('#search').value == '') {
                elm('#search').value = object.getName()
            }
        }
    }
}

/**
 * Run a search inside the main tree
 */
function searchTree(str, caseSensitive = false) {
    if (str == '') {
        tree.clearSearch()
        tree.each(e => e.expand())
        return
    }

    if (!caseSensitive) str = str.toLowerCase()

    tree.search((e) => {
        // Search in .pak file
        if (Main.treeMode === 'pak') {
            if (e.type !== 'file') return false

            const fileName = pak.files[e.fileIndex].full_path.split('/').pop()
            return caseSensitive ? fileName.includes(str) : fileName.toLowerCase().includes(str)
        }
        // Search in .igz file
        else if (Main.treeMode === 'igz') {
            if (e.type !== 'object') return false

            const object = igz.objects[e.objectIndex]
            const name = object.getName()
            return caseSensitive ? name.includes(str) : name.toLowerCase().includes(str)
        }
    })
}

// Load a .pak or .igz file
async function loadFile(filePath, extensions = ['igz', 'pak']) 
{
    filePath ??= await ipcRenderer.invoke('open-file', extensions)

    if (filePath == null) {
        console.warn('No file selected')
        return
    }

    localStorage.setItem('last_file', filePath)

    if (filePath.endsWith('.pak')) loadPAK(filePath)
    else if (filePath.endsWith('.igz')) loadIGZ(filePath)
    else console.warn('Unknown file type:', filePath)
}

// Load a .pak file
function loadPAK(filePath) 
{
    const newPAK = Pak.fromFile(filePath)
    Main.setPak(newPAK)
    Main.showPAKTree()

    // Save a copy of the original file if opening a PAK from the game folder
    if (filePath.startsWith(nstPath + 'archives\\')) {
        const name = filePath.split('\\').pop().split('\\')[0]
        const copyPath = './data/originals/' + name
        if (!existsSync('./data/originals')) mkdirSync('./data/originals')
        if (!existsSync(copyPath)) {
            copyFileSync(filePath, copyPath)
            console.log('Copied original PAK file to ' + copyPath)
        }
    }
    
    console.log('Load', filePath)   
}

// Load a .igz file
async function loadIGZ(filePath) 
{
    Main.setPak(null)
    igz = IGZ.fromFile(filePath)
    Main.igz = igz
    Main.showIGZTree()

    console.log('Load', filePath)   
}

// Save a .pak or .igz file
async function saveFile()
{
    // Save igz from pak
    if (Main.treeMode == 'igz' && pak != null) {
        updateIGZWithinPAK()
        return
    }

    const filePath = await ipcRenderer.invoke('save-file', Main.treeMode)

    if (filePath == null) {
        console.warn('No file selected')
        return
    }

    if (Main.treeMode === 'pak') savePAK(filePath)
    else if (Main.treeMode === 'igz') saveIGZ(filePath)
}

// Save current pak to a .pak file
async function savePAK(filePath) 
{   
    pak.path = filePath

    try {
        await pak.save(filePath, (current_file, file_count) => ipcRenderer.send('set-progress-bar', filePath, current_file, file_count))
    }
    catch (e) {
        ipcRenderer.send('set-progress-bar', filePath, 0, 1)
        throw e
    }
    
    localStorage.setItem('last_file', filePath)
    Main.reloadTree(pak.toNodeTree())

    console.log('Saved ' + filePath)
}

// Save current igz to a .igz file
function saveIGZ(filePath) 
{
    igz.save(filePath)
    localStorage.setItem('last_file', filePath)

    // Main.reloadTree(igz.toNodeTree())
    Main.setAllNodesToUpdated()
    Main.updatedBytes = {}

    // TODO: refresh data view

    console.log('Saved ' + filePath)
}

// Update pak with new igz data
function updateIGZWithinPAK() 
{
    const igzFile = pak.files[Main.lastFileIndex]

    igzFile.data = igz.save()
    igzFile.original = false
    igzFile.updated = true

    Main.updatedBytes = {}
    Main.setAllNodesToUpdated()
    Main.updateTitle()

    console.log('Saved IGZ within PAK', igzFile.path)
}

// Import files to the current pak
async function importToPAK() {
    // Select a file
    const path = await ipcRenderer.invoke('open-file')
    if (path == null) return

    // On .igz import, add it to the current pak
    if (path.endsWith('.igz')) {
        throw new Error('Not implemented')
    }

    // On .pak import, open file selection modal
    const [selection, updatePKG] = await ipcRenderer.invoke('create-import-modal', { file_path: path })

    if (selection == null || selection.length == 0) {
        console.warn('Nothing imported')
        return
    }
    
    // Import files to the current pak
    const import_pak = Pak.fromFile(path)
    await pak.importFromPak(import_pak, selection, updatePKG)

    // Rebuild PAK tree
    Main.reloadTree(pak.toNodeTree())

    // Set focus on the first imported file in the tree view
    const firstImport = tree.available().find(e => e.fileIndex === pak.files.length - selection.length)
    firstImport.expandParents()
    firstImport.select()
    firstImport.focus()
}

/**
 * Try to detect the original name of the archive from its package file
 * @returns the name of the original .pak file 
 */
function getOriginalPAKName() {
    let node = tree.get(0).children.find(e => e.text === 'packages/')
    
    // Find last node under the packages/ folder
    while (node?.children?.length > 0) node = node.children[0]
    
    const name = node.text.replaceAll('.igz', '').replaceAll('_pkg', '') + '.pak'
    
    return name
}

// Revert a .pak file to its original content (saved when loading a PAK from the game folder)
function revertPakToOriginal() {
    const name = getOriginalPAKName()
    const savedPath = './data/originals/' + name
    const originalPath = nstPath + 'archives\\' + name

    if (!existsSync(savedPath)) {
        alert('No original file found')
        return
    }

    const accept = confirm(`Are you sure you want to revert the following file to its original content?\n\n${originalPath}`)
    
    if (accept) {
        copyFileSync(savedPath, originalPath)
        alert(`The following file has been reverted to its original content:\n\n${originalPath}`)
    }
}

/**
 * Launch the game executable with the selected level
 */
function launchGame() {
    const exePath = nstPath + 'CrashBandicootNSaneTrilogy.exe'    
    const level = elm('#level-select').value
    
    localStorage.setItem('last_level', level)

    // Disable button for 4 seconds
    elm("#launch-game").disabled = true
    setTimeout(() => elm("#launch-game").disabled = false, 4000)

    if (elm('#use-current-pak').checked) {
        // Replace pak in game folder with current pak
        const originalName = getOriginalPAKName()
        console.log(`Replaced ${originalName} with ${pak.path}`)
        copyFileSync(pak.path, nstPath + 'archives\\' + originalName)
    }

    const cmd = `"${exePath}" -om ${level}/${level.split('/')[1]}`
    exec(cmd)
}

/**
 * Main app window entry point
 */
window.onload = async () => 
{
    treePreview = Main.createTree('.tree-preview')

    // Stop now if not main window
    if (!window.process.argv.includes('main_window')) return

    // Create main tree
    Main.createMainTree({ editable: true, editing: { add: false, edit: true, remove: false }})
    tree.on('node.click', onNodeClick)

    /// Search bar
    const caseSensitiveElm = elm('#case-sensitive')
    const autoRefreshElm   = elm('#auto-refresh')

    // Search on type if auto-refresh is enabled
    elm('#search-bar').addEventListener('input', (event) => {
        if (autoRefreshElm.checked) {
            searchTree(event.target.value, caseSensitiveElm.checked)
        }
    })

    // Search on press Enter if auto-refresh is disabled
    elm('#search-bar').addEventListener('keydown', (event) => {
        if (event.key == 'Enter' && !autoRefreshElm.checked) {
            searchTree(event.target.value, caseSensitiveElm.checked)
        }
    })

    /// Create level selector
    const level_names = levels
            .split('\n')
            .map(e => e.trim())
            .sort((a, b) => {
                if (a[7] == 'l' && b[7] == 'l') return a.localeCompare(b)
                if (a[7] == 'l') return -1
                if (b[7] == 'l') return 1
                return a.slice(6).localeCompare(b.slice(6))
            })
            
    level_names.forEach(e => {
        const option = document.createElement('option')
        option.value = e
        option.innerText = e
        elm('#level-select').appendChild(option)
    })

    elm('#level-select').value = localStorage.getItem('last_level') ?? level_names[1]
    
    /// Buttons

    // "Launch game" button
    elm("#launch-game").addEventListener('click', launchGame)

    // "Open IGZ" button
    elm('#igz-open').addEventListener('click', () => {
        Main.saveTreeExpandedState()
        Main.showIGZTree()
    })

    // "Import" button
    elm('#pak-import').addEventListener('click', importToPAK)

    // "Rename IGZ" button
    elm('#igz-rename').addEventListener('click', () => {
        const node = tree.lastSelectedNode()

        if (node.type == 'file') {
            if (!node.editing()) node.toggleEditing()
        }
    })
    // On IGZ file rename
    tree.on('node.edited', (node, oldValue, newValue) => {
        if (node.type === 'file') {
            const file = pak.files[node.fileIndex]
            file.rename(newValue)
            pak.updated = true
            Main.updateTitle()
            Main.colorizeMainTree()
        }
    })

    // "Clone IGZ" button
    elm('#igz-clone').addEventListener('click', async () => {
        const fileIndex = tree.lastSelectedNode().fileIndex

        if (fileIndex != null) {
            await pak.cloneFile(fileIndex)
            Main.reloadTree(pak.toNodeTree())
            const node = tree.available().find(e => e.fileIndex === pak.files.length - 1)
            node.select()
        }
    })

    // "Replace IGZ within PAK" button
    elm('#igz-replace').addEventListener('click', async () => {
        const fileIndex = tree.lastSelectedNode().fileIndex

        for (const file of pak.files.filter(e => !e.original)) {
            writeFileSync(`./data/tmp/${file.id}`, new Uint8Array(file.data))
        }
        const [newFileIndex] = await ipcRenderer.invoke('create-import-modal', {
            files_data: pak.files.map(e => e.toJSON()),
            current_file_index: fileIndex
        })

        if (fileIndex != null && newFileIndex != null) {
            pak.replaceFileWithinPak(fileIndex, newFileIndex)

            const node = tree.lastSelectedNode()
            node.set('text', node.text + '*')
            node.select()

            Main.setSyntaxHighlightedCode(pak.files[fileIndex])
            Main.showIGZPreview(fileIndex)
            Main.updateTitle()
            Main.colorizeMainTree()

            console.log('Replaced', pak.files[fileIndex], pak.files[newFileIndex])
        }
    })

    // "Delete IGZ" button
    elm('#igz-delete').addEventListener('click', () => {
        const fileIndex = tree.lastSelectedNode().fileIndex

        if (fileIndex != null) {
            pak.deleteFile(fileIndex)

            Main.reloadTree(pak.toNodeTree())
            Main.hideIGZPreview()
            Main.hideStructView()
        }
    })

    // "Extract IGZ" button
    elm('#igz-extract').addEventListener('click', async () => {
        const fileIndex = tree.lastSelectedNode().fileIndex

        if (fileIndex != null) {
            const data = await pak.files[fileIndex].getUncompressedData()
            const filePath = await ipcRenderer.invoke('save-file', 'igz')
            if (filePath == null) return
            writeFileSync(filePath, new Uint8Array(data))
            console.log('Extracted', pak.files[fileIndex].path)
        }
    })

    /// Back to .pak button
    elm('#back-pak').addEventListener('click', () => {
        const confirm = !igz.updated || window.confirm('Warning: you have unsaved changes. Are you sure you want to go back to the PAK file?')
        if (!confirm) return
        const lastIndex = Main.lastFileIndex
        Main.showPAKTree()
        Main.restoreTreeExpandedState()
        Main.showIGZPreview(lastIndex)    
        Main.setSyntaxHighlightedCode(pak.files[lastIndex])
    })
    
    await loadFile(localStorage.getItem('last_file'))

    onNodeClick(null, tree.get(0))
}

/**
 * Sub-window entry point
 */
ipcRenderer.on('init-import-modal', (event, props) => init_file_import_modal(Main, onNodeClick, props))

/**
 * Menu callbacks
 */
ipcRenderer.on('menu-open'   , (_, props) => loadFile(props))
ipcRenderer.on('menu-reload' , () => window.location.reload())
ipcRenderer.on('menu-import' , (_, props) => importToPAK(props))
ipcRenderer.on('menu-save'   , (_, props) => saveFile(props))
ipcRenderer.on('menu-save-as', (_, props) => saveFile(props))
ipcRenderer.on('menu-revert' , (_, props) => revertPakToOriginal(props))

if (process.env.NODE_ENV === 'development') window.Main = Main