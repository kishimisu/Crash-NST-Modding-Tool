import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { exec } from 'child_process'
import { ipcRenderer } from 'electron'
import InspireTree from 'inspire-tree'
import InspireTreeDOM from 'inspire-tree-dom'
import hljs from 'highlight.js/lib/core'
import jsonLang from 'highlight.js/lib/languages/json'

import IGZ from '../igz/igz.js'
import Pak from '../pak/pak.js'
import FileInfos from '../pak/fileInfos.js'
import ObjectView from './components/object_view.js'
import LevelExplorer from './components/level_explorer.js'
import { clearUpdatedData } from './components/object_field.js'
import { init_file_import_modal } from './components/import_modal.js'
import { createElm, elm, getArchiveFolder, getBackupFolder, getGameFolder, getTempFolder, isGameFolderSet } from './components/utils/utils.js'
import { randomColor } from '../utils.js'
import './components/utils/igObjectExtension.js'

import levels from '../../assets/crash/levels.txt'
import '../../assets/styles/style.css'
import '../../assets/styles/inspire.css'
import '../../assets/styles/hljs.css'

hljs.registerLanguage('json', jsonLang)

/*
    App entry point
*/
window.onload = main

let pak  // Current Pak instance
let igz  // Current Igz instance 
let tree // Main tree for PAK/IGZ views (left)
let treePreview // IGZ preview within PAK (right)

// Ordered level name list
const level_names = levels
    .split('\n')
    .map(e => e.trim())
    .sort((a, b) => {
        if (a[7] == 'l' && b[7] == 'l') return a.localeCompare(b)
        if (a[7] == 'l') return -1
        if (b[7] == 'l') return 1
        return a.slice(6).localeCompare(b.slice(6))
    })

/**
 * Main manager for window content and app state
 */
class Main {
    static treeMode = 'pak' // Current main tree mode ('igz' or 'pak')

    static lastCollapsedState = { pak: null, igz: null }
    static lastFileIndex = { pak: null, igz: null }

    static pak = null
    static igz = null
    static tree = null

    static objectView = null  // IGZ Object edit view (right)

    static levelExplorer = new LevelExplorer()

    static setPak(_pak) { this.pak = pak = _pak }
    static setIGZ(_igz) { this.igz = igz = _igz }

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
        this.showObjectDataView(false)
        this.levelExplorer.deselectObject()

        if (igz != null) this.showFileButtons(true)

        elm('#pak-import').style.display = 'block' // Show import button
        elm('#back-pak').style.display = 'none'    // Hide back button
        elm('#data-struct').style.display = 'none' // Hide data struct
        elm('#display-mode').style.display = 'none'
        elm('#auto-refresh').checked = true
        elm('#use-current-pak').parentNode.style.display = 'flex'
    }

    // Init main tree view for IGZ file
    static showIGZTree() {
        if (igz == null) return
        if (pak != null && this.treeMode == 'pak') this.saveTreeExpandedState('pak')

        this.treeMode = 'igz'
        tree.load([]) 
        tree.load(igz.toNodeTree(true, localStorage.getItem('display-mode')))
        if (tree.nodes().length == 3)
            tree.get(1).expand()

        clearUpdatedData()
        if (this.objectView) this.showObjectDataView(false)

        this.colorizeMainTree()
        this.hideIGZPreview()
        this.setSyntaxHighlightedCode(igz)
        this.updateTitle()

        elm('#pak-import').style.display = 'none'
        elm('#back-pak').style.display = pak == null ? 'none' : 'block'
        elm('#auto-refresh').checked = igz.objects.length < 500
        elm('#use-current-pak').parentNode.style.display = 'none'
        elm('#display-mode').style.display = 'block'
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
    static colorizeMainTree(tree_ = tree) {
        const defaultColor = '#fefefe'

        tree_.available().forEach(e => {
            // PAK file node
            if (e.type === 'file') {
                const file = pak.files[e.fileIndex]
                if (!file.include_in_pkg && !file.path.includes('_pkg'))
                    e.itree.ref.style.color = '#aaa'
                else if (file.updated)
                    e.itree.ref.style.color = '#ffaf36'
                else if (!file.original)
                    e.itree.ref.style.color = '#21ff78'
                else
                    e.itree.ref.style.color = defaultColor
            }
            // PAK folder node
            else if (e.type === 'folder') {
                e.itree.ref.childNodes[0].style.color = e.updated ? '#ffaf36' : defaultColor
            }
            // IGZ folder (grouped by type)
            else if (e.type == 'type-group') {
                const end = e.text.indexOf(' ')
                const type = end == -1 ? e.text : e.text.slice(0, end)
                e.itree.ref.querySelector('.title').style.color = randomColor(type)
            }
            // IGZ object node
            else if (e.type === 'object') {
                const object = igz.objects[e.objectIndex]
                const title = e.itree.ref.querySelector('.title')
                const typeColor = randomColor(object.type)

                if (title.children.length == 0) {
                    const div = createElm('div', 'object-node-name')
                    const typeElm = createElm('span')
                    const nameElm = createElm('span')
                    const sep = e.text.indexOf(':')
                    let type = e.text, name = ''

                    if (sep != -1) {
                        type = e.text.slice(0, sep+1)
                        name = e.text.slice(sep+1)
                    }

                    typeElm.innerText = type
                    nameElm.innerText = name

                    title.innerHTML = ''
                    title.appendChild(div)
                    div.appendChild(typeElm)
                    if (name != '') div.appendChild(nameElm)
                }

                const children = e.itree.ref.querySelector('.object-node-name').children
                if (object.updated) {
                    children[0].style.color = '#ffaf36'
                    if (children[1]) children[1].style.color = '#ffaf36'
                }
                else {
                    children[0].style.color = typeColor
                    if (children[1]) children[1].style.color = object.custom ? '#b1ffd0' : ''
                    else if (object.custom) children[0].style.color = '#b1ffd0'
                }
                if (object.invalid != null) {
                    children[0].style.color = 'red'
                    if (children[1]) children[1].style.color = 'red'
                }
            }
        })
    }
    
    // Update the size of the tree view elements
    static applyTreeStyle() {
        const stylesheet  = Array.from(document.styleSheets[1].cssRules)
        const getRule     = (selector) => stylesheet.find(e => e.selectorText == selector)
        const updateStyle = (selector, style) => Object.assign(getRule(selector).style, style)

        let height   = parseInt(localStorage.getItem('tree-size') ?? 18)
        let fontSize = height * 0.04
        
        height   += 'px'
        fontSize += 'rem'

        elm('.tree').style.fontSize = fontSize
        elm('.tree-preview').style.fontSize = fontSize
        updateStyle('.inspire-tree .btn-group', { height, lineHeight: height })
        updateStyle('.inspire-tree li > .title-wrap', { minHeight: height })
        updateStyle('.inspire-tree .toggle', { height })
        updateStyle('.inspire-tree .title', { height, lineHeight: height })
        updateStyle('.inspire-tree .editable form', { height, lineHeight: height })
        updateStyle('.inspire-tree .wholerow', { height, marginTop: '-'+height })
    }

    // Show IGZ content preview in PAK tree
    static showIGZPreview(fileIndex, forceReload = false) {        
        elm('#data-struct').style.overflow = 'visible'
        elm('#igz-open').style.display = 'block'
        let showProgress = false

        try {
            if (forceReload || igz == null || igz.updated || igz.path !== pak.files[fileIndex].path) {
                const filePath = pak.files[fileIndex].path

                if (pak.files[fileIndex].size > (filePath.startsWith('maps/') ? 1_000_000 : 2_400_000)) showProgress = true
                if (showProgress) ipcRenderer.send('set-progress-bar', 1, null, 'Loading', 'Loading...', 'Loading ' + filePath.split('/').pop())
                
                igz = IGZ.fromFileInfos(pak.files[fileIndex])
                igz.setupEXID(getArchiveFolder(), pak)
                igz.setupChildrenAndReferences(localStorage.getItem('display-mode'))

                if (showProgress) ipcRenderer.send('set-progress-bar', null)
            }
        }
        catch (e) {
            igz = null
            if (showProgress) ipcRenderer.send('set-progress-bar', null)
            treePreview.load([{ 
                text: 'There was an error loading this file.',
                children: [{ text: e.message }],
            }])
            treePreview.get(0).itree.ref.style.color = '#e3483a'
            console.error(e)
            return
        }

        this.igz = igz
        
        treePreview.load(igz.toNodeTree(false, localStorage.getItem('display-mode')))
        this.colorizeMainTree(treePreview)
        if (treePreview.nodes().length == 3) treePreview.get(1).expand()
    }

    // Hide IGZ content preview
    static hideIGZPreview() {
        elm('#igz-open').style.display = 'none'
        elm('#data-struct').style.overflow = 'auto'
        treePreview.removeAll()
        this.showFileButtons(false)
    }

    static initLevelExplorer() {
        if (Main.pak == null) return ipcRenderer.send('show-warning-message', 'This feature is only available in .pak files.')
        if (Main.pak.files.find(e => e.path.startsWith('maps/')) == null) return ipcRenderer.send('show-warning-message', 'Cannot open Level Explorer for non-level files.')
        
        try {
            if (pak == this.levelExplorer.pak && this.levelExplorer.mode == 'level' && !this.levelExplorer.visible)
                return this.levelExplorer.toggleVisibility(true)
            this.levelExplorer.init()
        } catch (e) {
            ipcRenderer.send('set-progress-bar', null)
            ipcRenderer.send('show-error-message', 'An error occurred while loading the level explorer', e.message)
            throw e
        }
    }
    
    // Focus an object in the main IGZ tree view
    static focusObject(objectIndex) {
        const node = tree.available().find(e => e.type == 'object' && e.objectIndex === objectIndex)
        this.hideStructView()
        if (node) {
            node.expandParents()
            node.focus()
            node.select()
            return node
        }
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

    // Show buttons related to file actions in PAK view (include in pak, rename, clone...)
    static showFileButtons(visible = true) {
        elm('#tree-preview-ctn').style.display = visible ? 'block' : 'none'
    }

    // Show or hide the object data view (data table + field table)
    static showObjectDataView(visible = false) {
        elm('#data-table-ctn').innerHTML = ''
        elm('#data-view').style.display = visible ? 'flex' : 'none'
        elm('#object-view-ctn').style.display = visible ? 'block' : 'none'
        elm('#objects-fields-title').style.display = visible ? 'flex' : 'none'
        if (!visible) this.objectView = null
    }

    // Update window title depending on current file and changes
    static updateTitle() {
        const pak_path = pak?.path + (pak?.updated ? '*' : '')
        const title = 'The Apprentice v1.21 - '

        if (this.treeMode === 'pak') {
            document.title = title + pak_path
        }
        else if (this.treeMode === 'igz') {
            const igz_path = igz.path + (igz.updated ? '*' : '')
            document.title = title + (pak == null ? igz_path : pak_path + ' -> ' + igz_path)
        }
    }

    // Remove or add trailing '*' to the node name in the IGZ tree
    static setNodeUpdatedStateIGZ(node, updated) {
        const children = node.itree.ref.querySelector('.object-node-name').children
        const nameElm = children[1] ?? children[0]

        if (!updated && node.text.endsWith('*')) {
            node.set('text', node.text.slice(0, -1))
            nameElm.innerText = nameElm.innerText.slice(0, -1)
        }
        else if (updated && !node.text.endsWith('*')) {
            node.set('text', node.text + '*')
            nameElm.innerText += '*'
        }
    }

    // Remove all trailing '*' from IGZ object node names
    static clearAllNodesUpdatedStateIGZ() {
        tree.available().each(e => {
            if (e.type == 'object')
                this.setNodeUpdatedStateIGZ(e, false)
        })
        this.colorizeMainTree()
    }

    // Set a node name to updated in the PAK tree
    static setNodeToUpdated(node, newName) {
        if (!node.text.endsWith('*')) {
            node.set('text', (newName ?? node.text) + '*')
        }
        this.updateTitle()
        this.colorizeMainTree()
    }

    static saveTreeExpandedState(mode) {
        const index = mode == 'pak' ? 'fileIndex' : 'objectIndex'
        const lastNode = tree.lastSelectedNode()

        if (lastNode)
            this.lastFileIndex[mode] = lastNode[index]

        this.lastCollapsedState[mode] = tree.available().map(e => e.expanded())
    }

    static restoreTreeExpandedState(mode) {
        if (this.lastCollapsedState[mode] == null) return
        tree.available().forEach((e, i) => {
            if (this.lastCollapsedState[mode][i]) e.expand()
            if (this.lastFileIndex[mode] == null) return
            if (e.fileIndex === this.lastFileIndex[mode] || e.objectIndex == this.lastFileIndex[mode]) {
                e.focus()
                e.select()
            }
        })
    }
}

/**
 * Handles a click on a tree node (in the main tree)
 */
function onNodeClick(event, node) 
{
    if (Main.levelExplorer.mode == 'model')
        Main.levelExplorer.toggleVisibility(false)

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
            const file = pak.files[node.fileIndex]

            if (file.path.endsWith('.igz')) 
                Main.showIGZPreview(node.fileIndex)                
            else 
                Main.hideIGZPreview()

            Main.showFileButtons(true)
            Main.setSyntaxHighlightedCode(file)

            if ((file.path.startsWith('actors/') || file.path.startsWith('models/')) && file.path.endsWith('.igz')) {
                const igz = IGZ.fromFileInfos(file)
                igz.setupChildrenAndReferences()
                Main.levelExplorer.showModel(igz)
            }

            elm('#include-in-pkg').checked = file.include_in_pkg
        }
    }
    // Clicked a file in IGZ
    else if (Main.treeMode === 'igz') {
        // Fixup node
        if (node.type === 'fixup') {
            const fixup = igz.fixups[node.fixup]
            Main.setSyntaxHighlightedCode(fixup)
            Main.showObjectDataView(false)
            return
        }
        // Fixup child node
        else if (node.type === 'offset') {
            const fixup = igz.fixups[node.fixup]
            if (fixup && fixup.isEncoded()) {
                const child = fixup.getCorrespondingObject(node.offset, igz.objects)?.object
                Main.hideStructView()
                Main.objectView = new ObjectView(child)
            }
            else {
                Main.hideStructView()
                Main.showObjectDataView(false)
            }
        }
        // Object node
        else if (node.type === 'object') {
            const object = igz.objects[node.objectIndex]
            Main.hideStructView()
            Main.objectView = new ObjectView(object)

            if (elm('#search').value == '') {
                elm('#search').value = object.getName()
            }
        }
    }
}

/**
 * Generates children for an asynchronous node when it is expanded
 */
function onNodeLoadChildren(node, resolve, _tree) {
    if (node == null) return

    let children = []

    if (node.type == 'object') {
        const object = igz.objects[node.objectIndex]
        children = object.children

        if (object.type == 'igVscMetaObject') // (vsc files) Always display igVscDataMetaObject as first child of igVscMetaObject
            children = children.sort((a, b) => a.object.type == 'igVscDataMetaObject' ? -1 : 1)

        children = children.map(e => e.object.toNodeTree(false, [], object.name))
    }
    else if (node.type == 'fixup') {
        const fixup = igz.fixups[node.fixup]
        children = fixup.toNodeTree(igz.objects, true)
    }

    requestAnimationFrame(() => Main.colorizeMainTree(_tree))
    resolve(children)
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
    if (filePath == null || !existsSync(filePath))
        filePath = await ipcRenderer.invoke('open-file', extensions)

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
    try {
        const newPAK = Pak.fromFile(filePath)

        // Update level selector
        const findLevelName = (pakName) => {
            if (pakName == null) return null
            pakName = pakName.toLowerCase().replace('.pak', '')
            return level_names.find(e => e.includes(pakName))
        }
        elm('#level-select').value = findLevelName(newPAK.getOriginalArchiveName()) ?? level_names[1]

        Main.levelExplorer.toggleVisibility(false)
        Main.igz = igz = null
        Main.setPak(newPAK)
        Main.showPAKTree()
        onNodeClick(null, tree.get(0))
        tree.available().find(e => e.type === 'folder' && e.text == 'maps/')?.expand()

        console.log('Load', filePath)
    }
    catch (e) {
        ipcRenderer.send('show-error-message', 'An error occurred while loading the file', e.message)
        throw e
    }
}

// Load a .igz file
function loadIGZ(filePath) 
{
    try {
        Main.levelExplorer.toggleVisibility(false)
        Main.setPak(null)
        igz = IGZ.fromFile(filePath)
        igz.setupEXID(getArchiveFolder())
        igz.setupChildrenAndReferences(localStorage.getItem('display-mode'))
        Main.igz = igz
        Main.showIGZTree()

        console.log('Load', filePath)   
    }
    catch (e) {
        ipcRenderer.send('show-error-message', 'An error occurred while loading the file', e.message)
        throw e
    }
}

// Save a .pak or .igz file
// If filePath is null, open the save as dialog
async function saveFile(saveAs = false)
{
    // Save igz from pak
    if (Main.treeMode == 'igz' && pak != null && !saveAs) {
        updateIGZWithinPAK()
        savePAK(pak.path)
        return
    }

    let filePath = null

    if (saveAs) {
        filePath = await ipcRenderer.invoke('save-file', Main.treeMode)
        if (filePath == null) return
    }

    if (Main.treeMode === 'pak') savePAK(filePath ?? pak.path)
    else if (Main.treeMode === 'igz') saveIGZ(filePath ?? igz.path)
}

// Save current pak to a .pak file
function savePAK(filePath) 
{   
    try {
        const title = 'Saving ' + filePath
        const message = 'This will take some time on the first time saving a new archive.' 
        pak.save(filePath, (current_file, file_count) => ipcRenderer.send('set-progress-bar', current_file, file_count, title, message))
    }
    catch (e) {
        ipcRenderer.send('set-progress-bar', null)
        ipcRenderer.send('show-error-message', 'An error occurred while saving the file', e.message)
        throw e
    }

    pak.path = filePath
    localStorage.setItem('last_file', filePath)

    // Reload PAK tree
    if (Main.treeMode === 'pak') {
        Main.reloadTree(pak.toNodeTree())

        // Update current IGZ preview
        if (igz != null) {
            const lastNode = tree.available().find(e => e.type === 'file' && pak.files[e.fileIndex].path === igz.path)
            onNodeClick(null, lastNode)
        }
    }
    Main.updateTitle()

    console.log('Saved ' + filePath)
}

// Save current igz to a .igz file
function saveIGZ(filePath) 
{
    igz.save(filePath)
    localStorage.setItem('last_file', filePath)

    if (Main.objectView) Main.objectView.onSave()
    Main.clearAllNodesUpdatedStateIGZ()
    Main.updateTitle()

    console.log('Saved ' + filePath)
}

// Update pak with new igz data
function updateIGZWithinPAK() 
{
    const igzFile = pak.files.find(e => e.path === igz.path)

    igzFile.data = igz.save()
    igzFile.size = igzFile.data.length
    igzFile.compression = 0xFFFFFFFF
    igzFile.original = false
    igzFile.updated = true

    pak.updated = true
    if (Main.objectView) Main.objectView.onSave()
    Main.clearAllNodesUpdatedStateIGZ()
    Main.updateTitle()

    console.log('Saved IGZ within PAK', igzFile.path)
}

// Import files to the current pak
async function importToPAK() {
    if (Main.treeMode == 'igz') return ipcRenderer.send('show-warning-message', 'You can only import files in .pak view')
    if (pak == null) return

    // Select a file
    const file_path = await ipcRenderer.invoke('open-file')
    if (file_path == null) return

    if (file_path.endsWith('.igz')) {
        // On .igz import, add the file to the current pak under the current selected folder
        const root = 'temporary/mack/data/win64/output/'
        const lastNode = tree.lastSelectedNode()
        const folderPath = lastNode?.type === 'folder' ? lastNode.path.replace(root, '') + '/' : ''

        const data = readFileSync(file_path)
        const name = file_path.split('\\').pop()
        const path = folderPath + name

        const file = new FileInfos({
            pak: pak,
            path, full_path: root + path,
            data, size: data.length,
            updated: true,
            original: false,
            compression: 0xFFFFFFFF
        })

        pak.files.push(file)
        pak.updated = true
    }
    else {
        // On .pak import, open file selection modal
        const res = await ipcRenderer.invoke('create-import-modal', { file_path })
        if (res == null) return

        const [selection, importDeps] = res

        if (selection == null || selection.length == 0) return
        
        // Import files to the current pak
        const import_pak = Pak.fromFile(file_path)

        const title = 'Importing from ' + file_path
        const progress_callback = (path, current, total) => ipcRenderer.send('set-progress-bar', current, total, title, 'Importing ' + path, 'files imported')

        try {
            const import_count = pak.importFromPak(import_pak, selection, importDeps, progress_callback)
            ipcRenderer.send('set-progress-bar', null)
            if (importDeps) ipcRenderer.send('show-info-message', `Successfully imported ${import_count} file${import_count > 1 ? 's' : ''}.`)
        }
        catch (e) {
            ipcRenderer.send('set-progress-bar', null)
            ipcRenderer.send('show-error-message', 'An error occurred while importing the file', e.message)
            throw e
        }
    }

    // Rebuild PAK tree
    Main.reloadTree(pak.toNodeTree())

    // Set focus on the first imported file in the tree view
    const firstImport = tree.available().find(e => e.fileIndex === pak.files.length - 1)
    firstImport.expandParents()
    firstImport.select()
    firstImport.focus()
}

// Clone the currently focused object in the IGZ tree
function cloneObject() {
    if (Main.igz == null || Main.objectView == null) return

    const firstID = Main.igz.objects.length - 1

    Main.saveTreeExpandedState('igz')
    Main.igz.cloneObject(Main.objectView.object)
    tree.load([]) 
    tree.load(igz.toNodeTree(true, localStorage.getItem('display-mode')))
    Main.colorizeMainTree()
    Main.restoreTreeExpandedState('igz')

    Main.tree.available().forEach(e => {
        if (e.type == 'object' && e.objectIndex >= firstID && e.objectIndex < Main.igz.objects.length - 1) {
            Main.setNodeUpdatedStateIGZ(e, true)
        }
    })

    const object = Main.igz.objects[firstID]
    Main.objectView = new ObjectView(object)
    Main.focusObject(firstID)

    if (Main.levelExplorer.initialized) {
        Main.levelExplorer.addObject(object)
        if (Main.levelExplorer.visible)
            Main.levelExplorer.focusObject(object, false)
    }
    Main.pak.updated = true
    Main.updateTitle()
}

// Rename the currently focused object in the IGZ tree
function renameObject() {
    const objName = elm('#object-name')
    objName.contentEditable = true
    objName.focus()

    const object = Main.objectView.object

    const onRename = (name) => {
        name = name.split(':').pop().trim()
        
        Main.igz.renameObject(object, name)
        Main.pak.updated = true

        Main.tree.available().each(node => {
            if (node.type == 'object' && node.objectIndex == object.index) {
                node.set('text', object.getName())
                const children = node.itree.ref.querySelector('.object-node-name').children
                const nameElm = children[1] ?? children[0]
                nameElm.innerText = ' ' + name
                Main.setNodeUpdatedStateIGZ(node, true)
            }
        })
        Main.colorizeMainTree()
        Main.updateTitle()
    }

    const onBlur = () => {
        objName.contentEditable = false
        objName.innerText = object.getName()
        objName.removeEventListener('blur', onBlur)
        objName.removeEventListener('keydown', onKeyDown)
    }
    const onKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            onRename(objName.innerText)
            objName.contentEditable = false
        }
        else if (e.key === 'Escape') {
            e.preventDefault()
            objName.blur()
        }
    }

    objName.addEventListener('keydown', onKeyDown)
    objName.addEventListener('blur', onBlur)
}

// Delete the currently focused object in the IGZ tree
function deleteObject() {
    const object = Main.objectView.object

    if (object.references.length > 1 || object.references.length == 1 && object.references[0] != Main.igz.objectList) {
        ipcRenderer.send('show-warning-message', 'This object is referenced by other objects. Please delete parent objects first.')
        return
    }

    if (Main.levelExplorer.initialized) {
        Main.levelExplorer.deleteObject(object)
    }

    Main.saveTreeExpandedState('igz')
    Main.igz.deleteObject(object)
    tree.load([]) 
    tree.load(igz.toNodeTree(true, localStorage.getItem('display-mode')))
    Main.colorizeMainTree()
    Main.lastFileIndex.igz = null
    Main.restoreTreeExpandedState('igz')
    Main.showObjectDataView(false)
}

// Revert a .pak file to its original content
async function revertPakToOriginal() {
    if (!isGameFolderSet()) return ipcRenderer.send('show-warning-message', 'Game folder not set. You can set it in the Settings menu.')
    if (pak == null) return ipcRenderer.send('show-warning-message', 'No .pak file loaded')

    let name = pak.getOriginalArchiveName()
    if (name == null && pak.path.includes('LooseFiles')) name = 'LooseFiles.pak'
    const savedPath = getBackupFolder(name)
    const originalPath = getArchiveFolder(name)

    if (!existsSync(savedPath)) {
        return ipcRenderer.send('show-warning-message', 'No backup found for this file.')
    }

    const accept = await ipcRenderer.invoke('show-confirm-message', `Are you sure you want to revert the following file to its original content?\n\n${originalPath}`)
        
    if (accept) {
        copyFileSync(savedPath, originalPath)
        ipcRenderer.send('show-info-message', `The following file has been reverted to its original content:\n\n${originalPath}`)
    }
}

/**
 * Launch the game executable with the selected level
 */
function launchGame(pak) {
    if (!isGameFolderSet()) return ipcRenderer.send('show-warning-message', 'Game folder not set. You can set it in the Settings menu.')

    const exePath = getGameFolder('CrashBandicootNSaneTrilogy.exe')
    const level = elm('#level-select').value
    
    localStorage.setItem('last_level', level)

    // Disable button for 4 seconds
    elm("#launch-game").disabled = true
    setTimeout(() => elm("#launch-game").disabled = false, 4000)

    if (elm('#use-current-pak').checked && pak?.package_igz != null) {
        // Replace pak in game folder with current pak
        const originalName = pak.getOriginalArchiveName()
        const originalPath = getArchiveFolder(originalName)
        console.log(`Replaced ${originalName} with ${pak.path}`)
        copyFileSync(pak.path, originalPath)
    }

    const cmd = `"${exePath}" -om ${level}/${level.split('/').pop()}`
    exec(cmd)
}

/**
 * Saves the current archive then launch the game
 */
function saveAndLaunch() {
    if (pak == null) return // Can only save and launch from a .pak file

    if (Main.treeMode == 'igz') updateIGZWithinPAK()

    if (pak.updated) savePAK(pak.path)
    launchGame(pak)
}

/**
 * Saves a backup of every .pak file in the game archives/ folder, or restore it
 */
async function backupGameFolder(restore = false) {
    const messages = {
        confirm: {
            true: 'Do you want to restore the game folder to its original state? This will revert all levels to their original content.',
            false: 'Do you want to backup the game folder? It will allow you to revert any level to its original state.\n\nThis will create a 30GB copy of the game folder next to the game executable'
        },
        title: {
            true: 'Restoring game folder...',
            false: 'Backing up game folder...'
        },
        success: {
            true: 'Game folder restored successfully.',
            false: 'Game folder backed up successfully. You can revert levels with File -> Revert'
        }
    }

    if (!isGameFolderSet()) return ipcRenderer.send('show-warning-message', 'Game folder not set. You can set it in the Settings menu.')

    const backupFolderPath = getBackupFolder()

    if (restore && readdirSync(backupFolderPath).length == 0) {
        return ipcRenderer.send('show-warning-message', 'No backup found for the game folder.')
    }

    const ok = await ipcRenderer.invoke('show-confirm-message', messages.confirm[restore])
    if (!ok) return

    const files = readdirSync(restore ? getBackupFolder() : getArchiveFolder())

    try {
        for (let i = 0; i < files.length; i++) {
            const file = files[i]
            const originalPath = getArchiveFolder(file)
            const backupPath = getBackupFolder(file)

            ipcRenderer.send('set-progress-bar', i, files.length, messages.title[restore], restore ? 'Restoring ' + file : 'Backing up ' + file)

            if (restore) copyFileSync(backupPath, originalPath)
            else copyFileSync(originalPath, backupPath)
        }
        ipcRenderer.send('show-info-message', messages.success[restore])
    }
    catch (e) {
        ipcRenderer.send('set-progress-bar', null)
        ipcRenderer.send('show-error-message', 'An error occurred', e.message)
        throw e
    }
}

/**
 *  Updates the saved game folder path
 */
async function changeGameFolderPath() {
    const folder = await ipcRenderer.invoke('open-folder')
    if (folder == null) return
    localStorage.setItem('game_folder', folder)
    await backupGameFolder()
}

/**
 *  Updates the igz model extractor path
 */
async function changeModelExtractorPath() {
    const path = await ipcRenderer.invoke('open-file', ['exe'])
    if (path == null) return
    localStorage.setItem('model-extractor-path', path)
    const ok = await ipcRenderer.invoke('show-confirm-message', 'The model extractor path has been updated. Would you like to reload the app to apply the changes?')
    if (ok) document.location.reload()
}

/**
 * Toggles the endianness in the object hex view
 */
function toggleEndian(bigEndian) {
    localStorage.setItem('big-endian', bigEndian)
    if (Main.objectView) Main.objectView = new ObjectView(Main.objectView.object)
}

/**
 * Toggle whether to save the referenceCount on igz save
 */
function toggleSaveReferenceCount(saveReferenceCount) {
    localStorage.setItem('toggle-refcount', saveReferenceCount)
}

/**
 * Main app window entry point
 */
async function main() 
{
    // Create preview tree (right)
    treePreview = Main.createTree('.tree-preview', { 
        data: (node, resolve) => onNodeLoadChildren(node, resolve, treePreview)
    })
    Main.applyTreeStyle()

    // Stop now if not main window
    if (!window.process.argv.includes('main_window')) return

    // Create main tree (left)
    Main.createMainTree({
        data: (node, resolve) => onNodeLoadChildren(node, resolve, tree),
        editable: true, 
        editing: {
             add: false, 
             edit: true, 
             remove: false 
        }
    })

    // Main tree nodes click event
    tree.on('node.click', onNodeClick)
    tree.on('node.dblclick', (event, node) => {
        if (node.type === 'file' && node.text.endsWith('.igz')) {
            Main.lastFileIndex.pak = node.fileIndex
            Main.showIGZTree() // Open IGZ from PAK on double click
        }
    })

    // Resize tree buttons
    const sizeIncrease = 1
    elm('#size-minus').addEventListener('click', () => {
        const currentSize = parseInt(localStorage.getItem('tree-size') ?? 18)
        localStorage.setItem('tree-size', Math.max(14, currentSize - sizeIncrease))
        Main.applyTreeStyle()
    })
    elm('#size-plus').addEventListener('click', () => {
        const currentSize = parseInt(localStorage.getItem('tree-size') ?? 18)
        localStorage.setItem('tree-size', Math.min(22, currentSize + sizeIncrease))
        Main.applyTreeStyle()
    })

    /// Search bar
    const autoRefreshElm   = elm('#auto-refresh')

    // Search on type if auto-refresh is enabled
    elm('#search-bar').addEventListener('input', (event) => {
        if (autoRefreshElm.checked) {
            searchTree(event.target.value)
        }
    })

    // Search on press Enter if auto-refresh is disabled
    elm('#search-bar').addEventListener('keydown', (event) => {
        if (event.key == 'Enter' && !autoRefreshElm.checked) {
            searchTree(event.target.value)
        }
    })

    /// Create level selector
    level_names.forEach(e => {
        const option = document.createElement('option')
        option.value = e
        option.innerText = e
        elm('#level-select').appendChild(option)
    })
    elm('#level-select').value = localStorage.getItem('last_level') ?? level_names[1]
    elm('#level-select').onchange = () => launchGame(pak)
    
    /// Buttons

    // "Launch game" button
    elm("#launch-game").addEventListener('click', () => launchGame(pak))
    
    // "Import into PAK" button
    elm('#pak-import').addEventListener('click', () => importToPAK())

    // "Open IGZ" button
    elm('#igz-open').addEventListener('click', () => Main.showIGZTree())

    // "Include in package" checkbox
    elm('#include-in-pkg').addEventListener('click', (event) => {
        const lastNode = tree.lastSelectedNode()

        if (lastNode != null) {
            const file = pak.files[lastNode.fileIndex]
            file.include_in_pkg = event.target.checked
            file.updated = true
            pak.updated = true

            Main.setNodeToUpdated(lastNode)
        }
    })

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
    elm('#igz-clone').addEventListener('click', () => {
        const fileIndex = tree.lastSelectedNode().fileIndex

        if (fileIndex != null) {
            pak.cloneFile(fileIndex)
            Main.reloadTree(pak.toNodeTree())
            const node = tree.available().find(e => e.fileIndex === pak.files.length - 1)
            node.select()
        }
    })

    // "Replace IGZ within PAK" button
    elm('#igz-replace').addEventListener('click', async () => {
        const fileIndex = tree.lastSelectedNode().fileIndex

        for (const file of pak.files.filter(e => !e.original)) {
            writeFileSync(getTempFolder(file.id), file.data)
        }
        const [newFileIndex] = await ipcRenderer.invoke('create-import-modal', {
            file_path: pak.path,
            files_data: pak.files.map(e => e.toJSON()),
            current_file_index: fileIndex
        }) ?? [null]

        if (newFileIndex == null) return

        if (fileIndex != null && newFileIndex != null) {
            pak.replaceFileWithinPak(fileIndex, newFileIndex)

            Main.setSyntaxHighlightedCode(pak.files[fileIndex])
            Main.showIGZPreview(fileIndex, true)

            const node = tree.lastSelectedNode()
            Main.setNodeToUpdated(node)
            node.select()

            if (Main.levelExplorer.mode == 'model' && Main.levelExplorer.visible) {
                const modelIGZ = IGZ.fromFileInfos(pak.files[fileIndex])
                modelIGZ.setupChildrenAndReferences()
                Main.levelExplorer.showModel(modelIGZ)
            }

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
            if (Main.levelExplorer.mode == 'model') Main.levelExplorer.toggleVisibility(false)
        }
    })

    // "Extract IGZ" button
    elm('#igz-extract').addEventListener('click', async () => {
        const fileIndex = tree.lastSelectedNode().fileIndex

        if (fileIndex != null) {
            const data = pak.files[fileIndex].getUncompressedData()
            const filePath = await ipcRenderer.invoke('save-file', 'igz')
            if (filePath == null) return
            writeFileSync(filePath, new Uint8Array(data))
            console.log('Extracted', pak.files[fileIndex].path)
        }
    })

    // (IGZ view) Back to .pak button
    elm('#back-pak').addEventListener('click', async () => {
        const confirm = !igz.updated || await ipcRenderer.invoke('show-confirm-message', 'You have unsaved changes. Are you sure you want to go back to the PAK file?')
        if (!confirm) return
        const lastIndex = Main.lastFileIndex.pak
        pak.updated = false
        Main.showPAKTree()
        Main.restoreTreeExpandedState('pak')
        if (lastIndex != null) {
            Main.showIGZPreview(lastIndex)    
            Main.setSyntaxHighlightedCode(pak.files[lastIndex])
        }
    })

    // (IGZ view) Select object display mode
    elm('#display-mode').addEventListener('change', () => {
        const value = elm('#select-display-mode').value
        localStorage.setItem('display-mode', value)
        igz.setupChildrenAndReferences(value)
        tree.load([]) 
        tree.load(igz.toNodeTree(true, value))
        Main.colorizeMainTree()
    })
    elm('#select-display-mode').value = localStorage.getItem('display-mode') ?? 'root'

    // (IGZ view) Clone object
    elm('#object-clone').addEventListener('click', () => cloneObject())
    elm('#object-rename').addEventListener('click', () => renameObject())
    elm('#object-delete').addEventListener('click', () => deleteObject())

    if (localStorage.getItem('first_launch') == null) {
        localStorage.setItem('first_launch', false)

        const defaultGameFolder = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Crash Bandicoot - N Sane Trilogy\\'
        if (existsSync(defaultGameFolder)) {
            localStorage.setItem('game_folder', defaultGameFolder)
            if (!existsSync(getBackupFolder())) await backupGameFolder()
        }
    }
    
    const gameFolder = localStorage.getItem('game_folder')
    if (gameFolder == null || !existsSync(gameFolder)) {
        localStorage.setItem('game_folder', '')
    }
    
    loadFile(localStorage.getItem('last_file'))
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
ipcRenderer.on('menu-import' , () => importToPAK())
ipcRenderer.on('menu-save'   , () => saveFile(false))
ipcRenderer.on('menu-save-as', () => saveFile(true))
ipcRenderer.on('menu-save-launch', () => saveAndLaunch())
ipcRenderer.on('menu-revert' , () => revertPakToOriginal())
ipcRenderer.on('menu-backup-game-folder', () => backupGameFolder())
ipcRenderer.on('menu-restore-game-folder', () => backupGameFolder(true))
ipcRenderer.on('menu-change-game-folder', () => changeGameFolderPath())
ipcRenderer.on('menu-toggle-endian', (_, checked) => toggleEndian(checked))
ipcRenderer.on('menu-toggle-refcount', (_, checked) => toggleSaveReferenceCount(checked))

ipcRenderer.on('menu-open-explorer', () => Main.initLevelExplorer())
ipcRenderer.on('menu-set-model-extractor-path', () => changeModelExtractorPath())
ipcRenderer.on('menu-toggle-show-splines', (_, checked) => Main.levelExplorer.toggleShowSplines(checked))
ipcRenderer.on('menu-toggle-show-entity-links', (_, checked) => Main.levelExplorer.toggleShowEntityLinks(checked))
ipcRenderer.on('menu-toggle-show-grass', (_, checked) => Main.levelExplorer.toggleShowGrass(checked))
ipcRenderer.on('menu-toggle-show-all-objects', (_, checked) => Main.levelExplorer.toggleShowAllObjects(checked))
ipcRenderer.on('menu-toggle-full-resolution', (_, checked) => Main.levelExplorer.toggleFullResolution(checked))

window.Main = Main