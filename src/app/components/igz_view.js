import igObject from "../../pak/igObject"
import editSVG from '../../../assets/images/edit.svg'

function resetDataViewTable(display = 'none') {
    const table = document.getElementById('data-table')
    while (table.firstChild) table.removeChild(table.firstChild)
    document.getElementById('data-view').style.display = display
}

function resetDataTypeTable(display = 'none') {
    const table = document.getElementById('data-types-table')
    while (table.children.length > 1) table.removeChild(table.lastChild)
    document.getElementById('data-types').style.display = display
}

/**
 * Create a data view table from the igObject's data
 */
igObject.prototype.createDataViewTable = function(Main, index, cell) 
{
    const table = document.getElementById('data-table')
    const bytesPerRow = 16

    resetDataViewTable('flex')

    let row = document.createElement('tr')

    for (let i = 0; i < this.data.length; i += 4) {
        const value = this.view.readInt(i)
        const child = this.children.find(e => e.offset == i)

        if (i % bytesPerRow == 0) {
            const offsetCell = document.createElement('td')
            offsetCell.innerText = '0x' + i.toString(16).toUpperCase().padStart(4, '0')
            offsetCell.classList.add('hex-offset')
            row.appendChild(offsetCell)
        }

        const cell = document.createElement('td')
        cell.innerText = (value >>> 0).toString(16).toUpperCase().padStart(8, '0').replace(/(.{2})/g, '$1 ')
        
        cell.onclick = () => {
            this.createDataTypeTable(Main, i, cell)
        }
        
        if (i < 16) cell.classList.add('hex-header')
        else if (child != null) cell.classList.add('hex-child')
        else if (value == 0) cell.classList.add('hex-zero')

        if (Main.updatedBytes[this.index] != null && Main.updatedBytes[this.index][i] != null) 
            cell.classList.add('hex-updated')

        row.appendChild(cell)

        if (i % bytesPerRow == bytesPerRow - 4) {
            table.appendChild(row)
            row = document.createElement('tr')
        }
        if (i == this.data.length - 4) {
            table.appendChild(row)
        }
    }

    if (index != null) {
        this.createDataTypeTable(Main, index, cell)
    }
    else {
        resetDataTypeTable()
    }
}

/**  
 * Convert int32 at selected byte into a data type table
 * 
 * @param {number} index Byte offset in the object's data
 * @param {HTMLElement} cell HTML table cell element that was clicked
*/
igObject.prototype.createDataTypeTable = function(Main, index, cell) {
    const { tree, igz } = Main
    const int32   = this.view.readInt(index)
    const uint32  = this.view.readUInt(index)
    // remove trailing zeros except for the last one
    const float32 = this.view.readFloat(index).toFixed(3)
    const name   = igz.fixups.TSTR.data[uint32] ?? ''
    const type   = igz.fixups.TMET.data[uint32] ?? ''
    const child  = this.children.find(e => e.offset == index)?.object
    const object = child?.getDisplayName() ?? ''
    let select
    
    // Remove previous table
    const table = document.getElementById('data-types-table')
    resetDataTypeTable('block')

    // Update selected cell style
    // (TODO) : Doesnt work on data update
    document.getElementById('data-table').querySelectorAll('td').forEach(e => e.classList.remove('selected'))
    cell.classList.add('selected')

    // Update "apply all" visibility
    document.getElementById('apply-all').style.display = tree.matched().length > 0 ? 'block' : 'none'

    // Add a data type row to the table
    const addTypeRow = (type, value, className, onClick) => {
        // Handle switch to edit mode
        const onClickEdit = () => {
            if (select != null) return

            // "List" types (dropdowns)
            if (['Name', 'Type', 'Object'].includes(type)) {                
                let names = type == 'Name' ? igz.fixups.TSTR.data : 
                            type == 'Type' ? igz.fixups.TMET.data :
                            igz.objects.map(e => e.getDisplayName())

                names = names.map((e, i) => `${i}: ${e}`)

                // Create HTML dropdown
                select = document.createElement('select')
                select.className = 'data-type-select'

                // Add default option
                const option = document.createElement('option')
                const defaultText = '--- None ---'
                option.innerText = defaultText
                select.appendChild(option)

                // Add all options
                for (let i = 0; i < names.length; i++) {
                    const option = document.createElement('option')
                    option.innerText = names[i]
                    select.appendChild(option)
                }

                // Add dropdown to cell
                valueCell.innerText = ''
                valueCell.appendChild(select)

                // Current selected value
                select.selectedIndex = value == '' ? 0 : (names.map(e=>e.split(': ')[1]).indexOf(value) + 1)
                select.focus()

                // On new value selected
                select.onchange = async () => {
                    value = select.value === defaultText ? '' : select.value.split(': ')[1]

                    await updateDataFromTable(Main, this, value, index, type)
                    exitEditing(type == 'Object')
                }

                // Lost focus
                select.onblur = () => exitEditing()
            }
            // Int, UInt, Float types
            else {
                // Set cell to editable
                valueCell.contentEditable = true
                valueCell.focus()
                valueCell.style.cursor = 'text'

                // On press enter (new value)
                valueCell.onkeydown = async (event) => {
                    if (event.key == 'Enter') {
                        await updateDataFromTable(Main, this, valueCell.innerText, index, type)    
                        exitEditing()
                    }
                }
            }

            // Handle exit edit mode
            const exitEditing = (rebuildTree = false) => {
                // Prevent warnings when using table.removeChild()
                if (select) {
                    select.onblur = null
                    select = null
                }
                valueCell.onblur = null

                // TODO: Properly update children
                if (rebuildTree) {
                    // TODO: Save search state
                    igz.updateChildrenAndReferences()
                    Main.reloadTree(igz.toNodeTree())
                }

                // Rebuild data view
                this.createDataViewTable(Main, index, cell)
            }

            // Lost focus
            valueCell.onblur = () => exitEditing()

            // Press escape
            valueCell.onkeyup = (event) => {
                if (event.key == 'Escape') exitEditing()
            }
        }

        // Add one cell to a row
        const addCell = (value, onClick) => {
            const cell = document.createElement('td')
            cell.innerText = value
            cell.className = className

            if (onClick != null) {
                cell.onclick = () => onClick(false)
                cell.ondblclick = () => onClick(true)
            }

            row.appendChild(cell)
            return cell
        }

        const row = document.createElement('tr')
        let nameCell = addCell(type, onClick)
        let valueCell = addCell(value, type == 'Object' ? onClick : onClickEdit)
        
        const img = document.createElement('div')
        img.innerHTML = editSVG
        img.style.width = '16px'
        img.style.height = '16px'
        img.style.cursor = 'pointer'
        img.onclick = onClickEdit

        const imgCell = document.createElement('td')
        imgCell.appendChild(img)
        row.appendChild(imgCell)

        table.appendChild(row)
    }

    const onObjectClick = (doubleClick) => {
        if (child == null || select != null) return

        const index = child.index
        const node = tree.node(index)
        node.expandParents()
        node.focus()
        // node.show()
        if (doubleClick) {
            node.select()
            onNodeClick(null, node)
        }
    }

    addTypeRow('Int32', int32)
    addTypeRow('UInt32', uint32)
    addTypeRow('Float32', float32)
    addTypeRow('Name', name)
    addTypeRow('Type', type)

    const objectClass = child ? 'hex-child' : ''
    addTypeRow('Object', object, objectClass, onObjectClick)
}

async function updateDataFromTable(Main, object, value, index, type) 
{
    const { tree, igz } = Main
    const isNumberType = ['Int32', 'UInt32', 'Float32'].includes(type)
    const isCalculation = isNumberType && value.slice(1).split('').some(e => ['+', '-', '*', '/'].includes(e.slice(1)))
    const isRelativeCalculation = isNumberType && (['+', '*', '/'].includes(value[0]) || value.startsWith('-='))

    if (isCalculation) {
        value = await ipcRenderer.invoke('eval-calculation', value)
    }

    if (document.querySelector('#apply-all-checkbox').checked) {
        const searchMatches = tree.matched()

        if (searchMatches.length > 0) {
            searchMatches.each(e => {
                const object = igz.objects[e.objectIndex]
                object.updateDataFromTable(Main, value, index, type, isRelativeCalculation)
            })

            return
        }
    }
    
    object.updateDataFromTable(Main, value, index, type, isRelativeCalculation)
}

igObject.prototype.updateDataFromTable = function(Main, value, index, type, isRelativeCalculation = false) 
{
    const { tree, igz, updatedBytes } = Main

    let val = value.slice()
    if (val[0] == '*' || val[0] == '/') value = value.slice(1)
    value = value.replace('=', '')

    if (type == 'Int32' || type == 'UInt32') {
        value = parseInt(value)

        if (isRelativeCalculation) {
            const current = this.view.readInt(index)
            if (val[0] == '+' || val.startsWith('-=')) value += current
            else if (val[0] == '*') value *= current
            else if (val[0] == '/') value = current / value
            else throw new Error('Not implemented: ' + val[0])
        }

        this.view.setInt(value, index)
    }
    else if (type == 'Float32') {
        value = parseFloat(value)

        if (isRelativeCalculation) {
            const current = this.view.readFloat(index)
            if (val[0] == '+' || val.startsWith('-=')) value += current
            else if (val[0] == '*') value *= current
            else if (val[0] == '/') value = current / value
            else throw new Error('Not implemented: ' + val[0])
        }

        this.view.setFloat(value, index)
    }
    else if (type == 'Name') {
        this.view.setUInt(igz.fixups.TSTR.data.indexOf(value), index)
    }
    else if (type == 'Type') {
        this.view.setUInt(igz.fixups.TMET.data.indexOf(value), index)
    }
    else if (type == 'Object') {
        const child = igz.objects.find(e => e.getDisplayName() == value)
        this.view.setUInt(child?.offset ?? 0, index)
    }
    else throw new Error('Not implemented: ' + type)

    igz.updated = true
    this.updated = true
    Main.updateTitle()

    if (updatedBytes[this.index] == null) updatedBytes[this.index] = {}
    if (updatedBytes[this.index][index] == null) updatedBytes[this.index][index] = true

    tree.available().each(e => {
        if (e.objectIndex == this.index && !e.text.endsWith('*')) {
            e.set('text', e.text + '*')
        }
    })

    return value
}

export { 
    resetDataTypeTable,
    resetDataViewTable,
}