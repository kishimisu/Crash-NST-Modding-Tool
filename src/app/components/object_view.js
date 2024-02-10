import types_metadata from '../../../assets/crash/types.metadata'
import { BufferView, bitRead, bitReplace } from '../../utils'
import { elm } from "../utils"

// Process types metadata and hierarchy from file
const TYPES_HIERARCHY = {}
const TYPES_METADATA = read_all_types_metadata()

// Keep track of updated fields within objects
const updated_data = {}

// Save interesting fields on IGZ load (fields that have 
// different values between objects of the same type)
const interesting_fields = {
    igz: null,
    fields: {}
}

class ObjectView {
    constructor(object) {
        const fields = TYPES_METADATA[object.type].slice() // Retrieve type metadata

        this.container = elm('#object-view') // Field list container
        this.object = object                 // parent igObject reference

        this.fields = fields                 // Array of fields from the object's type
        this.hexCells = []                   // Array of cells from the hex data view

        this.selected = null                 // { field, cell }, Currently selected field and cell 

        // Update object display name
        elm('#object-name').innerText = object.getDisplayName()
                
        this.findInterestingFields()
        this.createFieldList()
        this.createHexDataCells()
    }

    // Create the table containing the object's data in hexadecimal format
    createHexDataCells() {
        const bytesPerRow = 4 * 6
        const table = elm('#data-table')
        table.onmouseleave = () => this.onMouseLeave()
        
        let row = document.createElement('tr')
        this.hexCells = []

        Main.showObjectDataView(true)

        // Iterate over every 4 bytes of the object's data
        for (let i = 0; i < this.object.data.length; i += 4) {
            const value = this.object.view.readInt(i)

            // Create offset column
            if (i % bytesPerRow == 0) {
                const offsetCell = document.createElement('td')
                offsetCell.innerText = '0x' + i.toString(16).toUpperCase().padStart(4, '0')
                offsetCell.classList.add('hex-offset')
                row.appendChild(offsetCell)
            }

            // Create hex cell DOM element
            const cell = document.createElement('td')
            cell.innerText = (value >>> 0).toString(16).toUpperCase().padStart(8, '0').replace(/(.{2})/g, '$1 ')

            if (value === 0 || i < 16) cell.classList.add('hex-zero')
            
            // Create hex cell object
            const hexCell = { element: cell, offset: i }
            this.hexCells.push(hexCell)

            // Add mouse events
            cell.onclick = () => {
                this.setSelected(hexCell.fields[0], hexCell)
                this.onCellHover(hexCell)
            }
            cell.onmouseover = () => {
                if (this.selected == null) 
                    this.onCellHover(hexCell)
            }

            // Add to row
            row.appendChild(cell)

            if (i % bytesPerRow == bytesPerRow - 4) {
                table.appendChild(row)
                row = document.createElement('tr')
            }
            if (i == this.object.data.length - 4) {
                table.appendChild(row)
            }
        }

        this.setupCellsAndFields()
        this.styleHexDataCells()
    }

    // Colorize data cells based on their type
    styleHexDataCells() {
        for (let i = 0; i < this.fields.length; i++) {
            const field = this.fields[i]
            if (field.bitfield != null) continue

            const colorType = field.bitfieldRoot ? 'hex-bool' : this.getFieldColor(field)
            const childrenUpdated = field.bitfieldRoot && field.children.some(e => this.isFieldUpdated(e))

            // Colorize corresponding data cells
            for (let j = 0; j < Math.ceil(field.size / 4); j++) {
                const cell = this.hexCells[Math.floor(field.offset / 4) + j].element
                const zero = cell.classList.contains('hex-zero')
                const updated = childrenUpdated || this.isFieldUpdated(field)
                
                if (updated) cell.classList.add('hex-updated')
                if (colorType && (!zero || updated)) cell.classList.add(colorType)
            }

            // Remove text from cells that are not associated with a field
            if (i > 0 && i < this.fields.length - 1 && !this.fields[i-1].bitfield) {
                const nextOffset = this.fields[i+1].offset
                const empty = nextOffset - (field.offset + field.size)
                
                for (let i = 0; i < Math.floor(empty/4); i++) {
                    const cell = this.hexCells[Math.floor(field.offset / 4) + Math.ceil(field.size / 4) + i].element
                    cell.innerText = ''
                }
            }
        }
    }

    // Create the table containing all fields
    createFieldList() {
        this.container.innerHTML = ''
        this.container.onmouseleave = () => this.onMouseLeave()

        // Create new rows for each field
        for (const field of this.fields) {
            this.createField(this.object, field)
        }

        // Add object's references to the bottom of the field list
        const refs = this.object.references.filter(e => e.index !== 0).map(e => '<p>&nbsp;&nbsp;' + e.getDisplayName())
        const div = document.createElement('div')
        div.className = 'ref-list'
        div.innerHTML = `References: (${refs.length}) ` + refs.join('</p>') + '</p>'
        this.container.appendChild(div)
    }

    // Create a row containing info about a field
    createField(object, field) {
        // Create new row
        const tr = document.createElement('tr')
        tr.className = 'field-view'

        const setupNameStyle = () => {
            const updated = this.isFieldUpdated(field)
            name.title = `${field.name} | Offset: 0x${field.offset.toString(16).toUpperCase()} | Size: ${field.bits ?? field.size} ${field.bitfield ? 'bit' : 'byte'}${(field.bits ?? field.size) > 1 ? 's' : ''}`
            name.style.fontWeight = updated ? 400 : 100
            name.style.color = updated ? 'orange' : field.interesting ? '#ff7271' : ''
            name.style.fontStyle = field.bitfieldRoot ? 'italic' : ''
            name.innerHTML = (field.bitfield != null ? '&nbsp;&nbsp;' : '') + field.name + (updated ? '*' : '')
        }

        // Field name
        const name = document.createElement('td')
        name.onclick = () => this.setSelected(field, field.hexCells[0])
        setupNameStyle()

        // Field type
        const type = document.createElement('td')
        type.title = `Type: ${field.type}${field.metaObject ? ' | ' + field.metaObject : ''} ` + (field.bitfield ? `| Bits: ${field.bits}, Shift: ${field.shift}` : '')
        type.style.fontStyle = field.bitfieldRoot ? 'italic' : ''
        type.innerText = this.prettifyType(field)
        type.classList.add(this.getFieldColor(field))
        type.onclick = () => this.setSelected(field, field.hexCells[0])

        // Field data (input field)
        const data = this.createInputFieldValue(object, field)

        // Add new row to table
        tr.addEventListener('mouseover', () => this.onFieldHover(field))
        tr.appendChild(name)
        tr.appendChild(type)
        tr.appendChild(data)
        this.container.appendChild(tr)

        field.element = tr // Save a reference to the DOM element
        field.refreshNameStyle = setupNameStyle // Save name update function
    }

    // Create the input field corresponding to a specific type
    createInputFieldValue(object, field) {
        const val = document.createElement('td')
        val.style.textAlign = '-webkit-center'

        if (field.bitfieldRoot) return val

        const type = field.type
        let input = null

        const createNumberInput = (methodType, offset = 0, value) => {
            value ??= object.view[methodType](field.offset + offset)
            const float = methodType === 'readFloat'
            const input = document.createElement('input')
            input.value = float ? value.toFixed(3) : value
            return input
        }

        const createCheckboxInput = (value) => {
            const input = document.createElement('input')
            input.type = 'checkbox'
            input.checked = value == 1
            input.onchange = () => this.onFieldUpdate(input, field, input.checked)
            return input
        }

        if (['igIntMetaField', 'igEnumMetaField'].includes(type)) {
            input = createNumberInput('readInt')
        }
        else if (type == 'igUnsignedIntMetaField') {
            input = createNumberInput('readUInt')
        } 
        else if (type == 'igShortMetaField') {
            input = createNumberInput('readInt16')
        }
        else if (type == 'igUnsignedShortMetaField') {
            input = createNumberInput('readUInt16')
        }
        else if (type == 'igFloatMetaField') {
            input = createNumberInput('readFloat')
        }
        else if (type == 'igBoolMetaField') {
            const value = object.view.readByte(field.offset)
            input = createCheckboxInput(value)
        }
        else if (['igVec3fMetaField', 'igVec2fMetaField'].includes(type)) {
            const elements = type == 'igVec3fMetaField' ? 3 : 2
            const div = document.createElement('div')
            div.className = 'vec-input'

            for (let i = 0; i < elements; i++) {
                const input = createNumberInput('readFloat', i * 4)
                input.style.borderRight = i < elements - 1 ? '1px solid #5c5c5c' : ''
                input.onchange = () => this.onFieldUpdate(input, field, input.value, i)
                div.appendChild(input)
            }

            val.style.display = 'contents'
            val.appendChild(div)
            return val
        }
        else if (type == 'igStringMetaField') {
            const str_index = object.view.readUInt(field.offset)
            const name = str_index > 0 ? Main.igz.fixups.TSTR.data[str_index] : null
            input = createDropdownInput(Main.igz.fixups.TSTR.data, name)
        }
        else if (type == 'igObjectRefMetaField') {
            const offset = object.view.readUInt(field.offset)
            const refOjbect = offset > 0 ? Main.igz.objects.find(e => offset >= e.offset && offset < e.offset + e.size) : null
            const inheritedClasses = getAllInheritedChildren(field.metaObject)
            inheritedClasses.add(field.metaObject)
            const names = Main.igz.objects.filter(e => inheritedClasses.has(e.type)).map(e => e.getDisplayName())
            input = createDropdownInput(names, refOjbect?.getDisplayName())
        }
        else if (type == 'igBitFieldMetaField') {
            const bytes = object.view.readInt(field.offset)
            const value = bitRead(bytes, field.bits, field.shift)

            if (field.metaField == 'igBoolMetaField')
                input = createCheckboxInput(value)
            else
                input = createNumberInput('readInt', 0, value)
        }
        else if (type == 'igMemoryRefMetaField') {
            const elementSize = object.view.readUInt(field.offset)
            const offset = object.view.readUInt(field.offset + 8 )
            input = document.createElement('div')
            input.innerText = `Offset: ${offset} | Elm. Size: ${elementSize}`
        }
        else {
            input = createNumberInput('readInt')
        }

        if (input.onchange == null) input.onchange = () => this.onFieldUpdate(input, field, input.value)
        val.appendChild(input)

        return val
    }

    // Update an object's data when a field is modified
    // Apply changes to all objects if the "Apply to all" checkbox is checked
    onFieldUpdate(input, field, value, id) {
        const searchMatches = Main.tree.matched()

        if (elm('#apply-all-checkbox').checked && searchMatches.length > 0) {
            searchMatches.each(e => {
                const object = Main.igz.objects[e.objectIndex]
                this.updateObjectData(object, input, field, value, id)
            })
        }
        else {
            this.updateObjectData(this.object, input, field, value, id)
        }

        this.object.updated = Object.keys(updated_data[this.object.index] ?? {}).length > 0
        Main.igz.updated = true
        if (Main.pak) Main.pak.updated = true

        Main.updateTitle()
        Main.colorizeMainTree()
    }

    /** 
     * Update an object's data when a field is modified
     * 
     * @param {igObject} object - The object to be updated
     * @param {HTMLInputElement} input - The input field that was modified
     * @param {Object} field - The corresponding field
     * @param {string} value - The new value of the field
     * @param {number} id - Element offset (for Vec2f and Vec3f fields)
    */
    updateObjectData(object, input, field, value, id = 0) {
        let previousValue = null

        const relativeCalculation = (type) => {
            const readMethod = 'read' + type
            const writeMethod = 'set' + type
            previousValue = object.view[readMethod](field.offset + id * 4)

            let num = Number(value.replace(/\D/g, '')) // Extract number from string

            // Perform relative calculation
            if (value.startsWith('+')) num = previousValue + num
            else if (value.startsWith('-=')) num = previousValue - num
            else if (value.startsWith('*')) num = previousValue * num
            else if (value.startsWith('/')) num = previousValue / num
            
            if (type === 'Float') num = parseFloat(num.toFixed(3))

            // Update input value
            input.value = num
            // Update object data
            object.view[writeMethod](num, field.offset + id * 4)

            return num
        }

        if (['igIntMetaField', 'igEnumMetaField'].includes(field.type)) {
            relativeCalculation('Int')
        }
        else if (field.type == 'igUnsignedIntMetaField') {
            relativeCalculation('UInt')
        }
        else if (field.type == 'igShortMetaField') {
            relativeCalculation('Int16')
        }
        else if (field.type == 'igUnsignedShortMetaField') {
            relativeCalculation('UInt16')
        }
        else if (['igFloatMetaField', 'igVec3fMetaField', 'igVec2fMetaField'].includes(field.type)) {
            relativeCalculation('Float')
        }
        else if (field.type == 'igBoolMetaField') {
            previousValue = object.view.readByte(field.offset) === 1
            value = value ? 1 : 0
            object.view.setByte(value, field.offset)
        }
        else if (field.type == 'igStringMetaField') {
            previousValue = object.view.readUInt(field.offset)
            value = Math.max(0, Main.igz.fixups.TSTR.data.indexOf(value))
            object.view.setUInt(value, field.offset)
        }
        else if (field.type == 'igObjectRefMetaField') {
            previousValue = object.view.readUInt(field.offset)
            value = Main.igz.objects.find(e => e.getDisplayName() == value)?.offset ?? 0
            object.view.setUInt(value, field.offset)
        }
        else if (field.type == 'igBitFieldMetaField') {
            if (value === true) value = 1
            else if (value === false) value = 0
            else value = parseInt(value)
            const currentInt = object.view.readInt(field.offset)
            value = bitReplace(currentInt, value, field.bits, field.shift)
            object.view.setUInt(value, field.offset)

            previousValue = bitRead(currentInt, field.bits, field.shift)
            value = bitRead(value, field.bits, field.shift)
        }
        else {
            console.warn('Unhandled field type', field.type)
            previousValue = object.view.readInt(field.offset)
            object.view.setInt(parseInt(value), field.offset)
        }

        // Keep track of updated fields
        addUpdatedData(object, this.fields.indexOf(field), value, previousValue, id)

        // Update object's node name in tree view
        const node = Main.tree.available().find(e => e.objectIndex == object.index)
        const updated = this.isFieldUpdated(field)
        if (!updated && node.text.endsWith('*')) node.set('text', node.text.slice(0, -1))
        else if (updated && !node.text.endsWith('*')) node.set('text', node.text + '*')

        const saveCellIDs = field.hexCells.map(e => this.hexCells.indexOf(e))

        field.refreshNameStyle()
        this.createHexDataCells()
        this.onFieldHover(field)
        this.lastEditTime = Date.now()

        saveCellIDs.forEach(e => this.hexCells[e].element.classList.add('hex-flash')) // Flashing animation
    }
    
    // Check if a field data differs from the original data
    isFieldUpdated = (field) => {
        return updated_data[this.object.index] != null && 
               updated_data[this.object.index][this.fields.indexOf(field)] != null
    }

    // Sets the hex cells and fields references
    setupCellsAndFields() {
        for (const field of this.fields) {
            const cellStart = Math.floor(field.offset / 4)
            const cellEnd   = Math.ceil((field.offset + field.size) / 4)
            field.hexCells = this.hexCells.slice(cellStart, cellEnd)
        }

        for (const cell of this.hexCells) {
            cell.fields = this.fields.filter(e => cell.offset >= e.offset && cell.offset < e.offset + e.size)
        }
    }

    // Sets the currently selected field and cell
    setSelected = (field, cell) => {
        // Reset selection if clicked on the same field/cell
        this.selected = this.selected?.field === field || this.selected?.cell === cell ? null : { field, cell }

        // Update hex cells
        this.hexCells.forEach(e => {
            if (e === this.selected?.cell) e.element.classList.add('selected')
            else e.element.classList.remove('selected')
        })
    }

    onFieldHover(field) {
        if (Date.now() - this.lastEditTime < 100) return // Prevent focusing another field just after closing a dropdown

        // Update field list
        this.fields.forEach(e => {
            e.element.style.backgroundColor = e === this.selected?.field || e === field ? '#5c5c5c' : ''
        })

        // Update hex cells
        this.hexCells.forEach(e => {
            e.element.style.backgroundColor = field.hexCells.includes(e) ? '#5c5c5c' : ''
        })
        field.hexCells[0].element.parentNode.scrollIntoViewIfNeeded()
    }

    onCellHover(cell) {
        // Update field list
        this.fields.forEach(e => {
            e.element.style.backgroundColor = e.hexCells.includes(cell) ? '#5c5c5c' : ''
        })

        // Update hex cells
        let cellsToHighlight = []

        if (cell.fields.length > 0) {
            cell.fields[0].element.scrollIntoViewIfNeeded()
            cellsToHighlight = cell.fields[0].hexCells
        }
        this.hexCells.forEach(e => {
            e.element.style.backgroundColor = cellsToHighlight.includes(e) ? '#5c5c5c' : ''
        })
    }

    onMouseLeave() {
        // Focus currently selected field
        if (this.selected?.field) 
            this.onFieldHover(this.selected.field)
        // Otherwise reset all styles
        else {
            this.hexCells.forEach(e => e.element.style.backgroundColor = '')
            this.fields.forEach(e => e.element.style.backgroundColor = '')
        }
    }

    // Find fields that have different values between objects
    findInterestingFields() {
        // Reset interesting fields on igz change
        if (interesting_fields.igz !== Main.igz) {
            interesting_fields.igz = Main.igz
            interesting_fields.fields = {}
        }
        // Load saved interesting fields
        else if (interesting_fields.fields[this.object.type] != null) {
            this.fields.forEach((e, i) => e.interesting = interesting_fields.fields[this.object.type].includes(i))
            return
        }

        // Calculate interesting fields
        const allObjects = Main.igz.objects.filter(e => e.type == this.object.type)
        let interestingFields = []

        for (let i = 0; i < this.fields.length; i++) {
            const field = this.fields[i]
            if (field.bitfieldRoot) continue

            let firstValue = null

            if (field.type === 'igBitFieldMetaField') {
                const bytes = allObjects[0].view.readInt(field.offset)
                firstValue = bitRead(bytes, field.bits, field.shift)
            }
            else {
                firstValue = allObjects[0].view.readBytes(field.size, field.offset)
            }

            for (let j = 1; j < allObjects.length; j++) {
                let interesting = false

                if (field.type === 'igBitFieldMetaField') {
                    const bytes = allObjects[j].view.readInt(field.offset)
                    const value = bitRead(bytes, field.bits, field.shift)
                    if (value !== firstValue) interesting = true
                }
                else {
                    const value = allObjects[j].view.readBytes(field.size, field.offset)
                    if (value.some((e, k) => e != firstValue[k])) interesting = true
                }

                if (interesting) {
                    field.interesting = true
                    interestingFields.push(i)
                    break
                }
            }
        }

        interesting_fields.fields[this.object.type] = interestingFields
    }

    // Get the color class corresponding to a field type
    getFieldColor(field) {
        if (field.bitfieldRoot) return null

        const type = field.metaField ?? field.type
        if (type == 'igBoolMetaField')      return 'hex-bool'
        if (type == 'igEnumMetaField')      return 'hex-enum'
        if (type == 'igFloatMetaField')     return 'hex-float'
        if (type == 'igStringMetaField')    return 'hex-string'
        if (type == 'igObjectRefMetaField') return 'hex-child'
        if (['igVec3fMetaField', 'igVec2fMetaField'].includes(type))
            return 'hex-vec'
        if (['igUnsignedIntMetaField', 'igIntMetaField', 'igShortMetaField', 'igUnsignedShort'].includes(type)) 
            return 'hex-int'
    }

    prettifyType(field) {
        let type = field.metaObject ?? field.metaField ?? field.type

        if (type.startsWith('ig')) type = type.slice(2)
        if (type.endsWith('MetaField')) type = type.slice(0, -9)

        if (field.bitfield && field.metaField !== 'igBoolMetaField') type += ` (${field.bits})`

        if (!field.metaObject)
            type = type.replace(/(?<=[a-z])(?=[A-Z][a-z])/g, ' ')

        return type
    }
}

// Extract types metadata from the binary file
function read_all_types_metadata() {
    const names = []
    const objects = {}
    const view = new BufferView(new Uint8Array(types_metadata))

    const namesCount = view.readUInt16()

    // Read names
    for (let i = 0; i < namesCount; i++) {
        const name = view.readStr()
        names.push(name)
    }

    // Read types metadata
    while (view.offset < view.buffer.length) {
        const typeName = names[view.readUInt16()]
        const parent = names[view.readUInt16()]
        const size = view.readUInt16()
        const fieldCount = view.readUInt16()
        const fields = []

        // Add type to hierarchy data
        function addToHierarchy(type, children = null) {
            if (!TYPES_HIERARCHY[type]) TYPES_HIERARCHY[type] = { children: new Set() }
            if (children) children.forEach(e => TYPES_HIERARCHY[type].children.add(e))
        }
        addToHierarchy(typeName)
        addToHierarchy(parent, [typeName])

        // Read fields
        for (let i = 0; i < fieldCount; i++) {
            // Read name and type
            const field = {
                name: names[view.readUInt16()],
                type: names[view.readUInt16()],
                offset: view.readUInt16(),
                size: view.readUInt16(),
                typeSize: view.readUInt16(),
                static: view.readByte() === 1
            }
            
            // Read MetaObject (object reference type)
            if (field.type === 'igObjectRefMetaField' || field.type === 'igObjectRefArrayMetaField') {
                field.metaObject = names[view.readUInt16()]
            }
            // Read MemType (memory data type)
            else if (field.type === 'igMemoryRefMetaField') {
                field.memType = names[view.readUInt16()]
            }
            // Read bitfield data
            else if (field.type === 'igBitFieldMetaField') {
                field.rootIndex = view.readUInt16()
                field.metaField = names[view.readUInt16()]
                field.shift = view.readByte()
                field.bits = view.readByte()
            }
            
            fields.push(field)
        }

        // Update bitfield data
        fields.forEach(field => {
            if (field.type === 'igBitFieldMetaField') {
                field.root = fields[field.rootIndex]
                field.root.children ??= []
                field.root.children.push(field)
                field.root.bitfieldRoot = true
                field.size = field.root.size
                field.typeSize = field.root.typeSize
                field.bitfield = true
            }
        })

        // Remove 0-sized fields, sort by offset and save type metadata
        objects[typeName] = fields.filter(e => e.type !== 'igStaticMetaField' && e.type !== 'igPropertyFieldMetaField')
                                  .sort((a, b) => a.offset - b.offset)
    }

    return objects
}

/**
 * Returns all types that inherit from the provided type.
 */
function getAllInheritedChildren(type, all_children = new Set()) {
    const children = TYPES_HIERARCHY[type].children
    all_children.add(type)

    for (const child of children) {        
        if (!all_children.has(child))
            getAllInheritedChildren(child, all_children)
    }

    return children
}

/**
 * Creates a dropdown input element with options based on the provided names array.
 * 
 * @param {string[]} names - An array of names to be used as options in the dropdown.
 * @param {string} selected - The name of the option to be selected by default.
 * @returns {HTMLSelectElement} - The created dropdown input element.
 */
function createDropdownInput(names, selected) {
    // Create HTML dropdown
    const select = document.createElement('select')
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

    select.selectedIndex = selected == null ? 0 : (names.indexOf(selected)+1)

    return select
}

function addUpdatedData(object, fieldIndex, value, originalValue, id = 0) {
    if (updated_data[object.index] == null)
        updated_data[object.index] = {}

    if (updated_data[object.index][fieldIndex] == null) {
        updated_data[object.index][fieldIndex] = []
        updated_data[object.index][fieldIndex][id] = originalValue
    }

    if (updated_data[object.index][fieldIndex][id] == value) {
        delete updated_data[object.index][fieldIndex][id]
        
        if (updated_data[object.index][fieldIndex].every(e => e == null))
            delete updated_data[object.index][fieldIndex]
    }
}

function clearUpdatedData() {
    for (const index in updated_data) {
        delete updated_data[index]
    }
}

export default ObjectView
export {
    clearUpdatedData
}