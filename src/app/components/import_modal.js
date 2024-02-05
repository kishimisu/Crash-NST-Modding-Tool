import { ipcRenderer } from "electron"
import Pak from "../../pak/pak.js"
import FileInfos from "../../pak/fileInfos.js"
import { elm } from "../utils.js"

/**
 * "Import file" sub-window entry point
 */
function init_file_import_modal(Main, onNodeClick, {file_path, files_data, current_file_index})
{    
    let pak
    if (file_path != null) pak = Pak.fromFile(file_path)
    else if (files_data != null) {
        pak = new Pak()
        pak.files = files_data.map(e => new FileInfos(e ?? {}))
    }
    else throw new Error('No file data provided')

    // Move import button to bottom
    const importButton = elm('#pak-import')
    const parent = elm('#left-area')
    parent.removeChild(importButton.parentNode)
    parent.appendChild(importButton.parentNode)

    importButton.disabled = true
    elm('#search-bar').style.display = 'none'
    elm('#level-selector').style.display = 'none'
    elm('#tree-preview-buttons').style.display = 'none'

    Main.setPak(pak)

    const multi_import = file_path != null

    const tree = Main.createMainTree({
        data: Main.pak.toNodeTree(),
        checkbox: {
            autoCheckChildren: true
        },
        selection: {
            mode: multi_import ? 'checkbox' : 'default'
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
        elm("#update-pkg").parentNode.style.display = 'flex'

        importButton.addEventListener('click', () => {
            const selected = tree.selected()
            const files = selected.map(e => e.fileIndex).filter(e => e != null)
            ipcRenderer.send('on-file-select', files, elm("#update-pkg").checked)
        })

        tree.get(0).expand()
    }
}

export {
    init_file_import_modal
}