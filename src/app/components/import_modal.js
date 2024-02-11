import { ipcRenderer } from "electron"
import Pak from "../../pak/pak.js"
import FileInfos from "../../pak/fileInfos.js"
import { elm } from "./utils/utils.js"

/**
 * "Import file" sub-window entry point
 */
function init_file_import_modal(Main, onNodeClick, {file_path, files_data, current_file_index})
{    
    const pak = Pak.fromFile(file_path)

    if (files_data != null) {
        files_data.forEach((e, i) => {
            const file = pak.files.find(f => f.path === e.path)
            if (file == null) {
                pak.files.push(new FileInfos(e))
            }
            else if (e.updated) {
                // Remove data for files that have been updated but not saved yet
                // to indicate that they need to be loaded from the temp folder instead.
                file.data = null
            }
        })
    }

    // Move import button to bottom
    const importButton = elm('#pak-import')
    const parent = elm('#left-area')
    parent.removeChild(importButton.parentNode)
    parent.appendChild(importButton.parentNode)

    importButton.disabled = true
    importButton.style.display = 'block'
    elm('#search-bar').style.display = 'none'
    elm('#level-selector').style.display = 'none'
    elm('#tree-preview-buttons').style.display = 'none'

    Main.setPak(pak)

    const tree = Main.createMainTree({
        data: Main.pak.toNodeTree(),
        checkbox: {
            autoCheckChildren: true
        },
        selection: {
            mode: files_data == null ? 'checkbox' : 'default'
        }
    })

    // Update import button text (selected files count)
    const updateImportButton = () => {
        const selected_count = tree.selected().filter(e => e.type === 'file').length
        importButton.innerText = 'Import ' + (selected_count > 0 ? `${selected_count} file${selected_count > 1 ? 's' : ''}` : '')
        importButton.disabled = selected_count == 0
    }
    
    tree.on('node.selected', updateImportButton)
    tree.on('node.deselected', updateImportButton)
    tree.on('node.click', onNodeClick)

    // Replace file within pak
    if (files_data != null) {
        importButton.addEventListener('click', () => {
            const selected = tree.lastSelectedNode()
            ipcRenderer.send('on-file-select', selected.fileIndex)
        })

        const node = tree.find(e => e.fileIndex === current_file_index)
        node.expandParents()
        node.select()
    }
    // Import files from external pak
    else {
        elm("#import-deps").parentNode.style.display = 'flex'

        importButton.addEventListener('click', () => {
            const selected = tree.selected()
            const files = selected.map(e => e.fileIndex).filter(e => e != null)
            ipcRenderer.send('on-file-select', files, elm("#import-deps").checked)
        })

        tree.get(0).expand()
    }
}

export {
    init_file_import_modal
}