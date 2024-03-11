import ObjectField, { clearUpdatedData } from './object_field'
import { createElm, elm } from "./utils/utils"
import { bitRead, isVectorZero } from '../../utils'
import { ENUMS_METADATA, TYPES_METADATA, TYPES_SIZES } from './utils/metadata'
import { ipcRenderer } from 'electron'
import IGZ from '../../igz/igz'

// Save interesting fields on IGZ load (fields that have 
// different values between objects of the same type)
const interesting_fields = {
    igz: null,
    fields: {}
}

// Save memory fields on IGZ load to be able to link 
// their children if they are not in the same object
const memory_fields = {
    igz: null,
    fields: []
}

class ObjectView {
    hoverColor = '#4c4c4c'
    
    constructor(object, init_dom = true) {
        const fields = TYPES_METADATA[object.type] // Retrieve fields metadata from the object's type

        this.container = elm('#object-view')  // Field list DOM container
        this.object = object                  // parent igObject reference

        this.fields = this.initFields(fields) // Array of ObjectField instances
        this.hexCells = []                    // Array of cells from the hex data view

        this.selected = null                  // { field, cell }, Currently selected field and cell 

        if (init_dom) {
            elm('#object-name').innerText = object.getDisplayName()

            const isEntity = ['igEntity', 'CEntity', 'CPhysicalEntity', 'CGameEntity'].includes(object.type)
            const focusButtonVisible = isEntity && Main.pak != null && !isVectorZero(object.view.readVector(3, 0x20))
            elm('#focus-in-explorer').style.display = focusButtonVisible ? 'block' : 'none'

            this.findInterestingFields()
            this.createFieldList()
            this.createHexDataCells()
        }
    }
    
    /**
     * Converts fields infos to ObjectField instances
     * and sets their parent and children references.
     */ 
    initFields(fields) {
        if (this.object.type == 'CVscComponentData') {
            const vscFields = this.initCVscComponentDataFields()
            if (vscFields) fields = fields.concat(vscFields)
        }

        fields = fields.map(e => new ObjectField(e))
        fields.forEach(e => {
            e.object = this.object
            if (e.parent)   e.parent = fields.find(f => f.name === e.parent.name)
            if (e.children) e.children = e.children.map(c => fields.find(f => f.name === c.name))
        })
        return fields
    }

    /**
     * Scan the parent .pak archive for the corresponding VSC file,
     * and extract the fields from its igVscDataMetaObject
     * 
     * @returns {ObjectField[]} Additional fields
     */
    initCVscComponentDataFields() {
        const id     = this.object.view.readUInt(0x20)
        const metaObject = Main.igz.named_externals[id] [1]
        const vsc = Main.pak?.files.find(e => e.path.includes(metaObject))

        const inRNEX = Main.igz.fixups.RNEX?.data.includes(this.object.offset + 0x20)
        if (!inRNEX) console.warn('CVscComponentData not in RNEX')

        if (vsc) {
            const igz = IGZ.fromFileInfos(vsc)
            igz.setupChildrenAndReferences()
            const vscData = igz.objects.find(e => e.type == 'igVscDataMetaObject')
            
            if (vscData) {
                let currentOffset = 0x28

                const vscFields = vscData.children.slice(1).map((child, i) => {
                    const field     = child.object
                    const size      = TYPES_SIZES[field.type].size
                    const alignment = TYPES_SIZES[field.type].alignment
                    const offset    = ((currentOffset + (alignment - 1)) & -alignment)

                    const newField = new ObjectField({
                        name: field.name.replace('_metaField', ''),
                        type: field.type,
                        size,
                        offset,
                    })

                    // Extract enum option names and values from igVectors
                    if (field.type == 'igEnumMetaField') {
                        const ifVscEnum = field.tryGetChild('igVscEnum')
                        if (ifVscEnum != null) {
                            const names  = ifVscEnum.extractMemoryData(igz, 0x20+8, 8).data.map(e => igz.fixups.TSTR.data[e])
                            const values = ifVscEnum.extractMemoryData(igz, 0x38+8, 4).data
                            ENUMS_METADATA[newField.name] = new Array(names.length).fill(0).map((e, i) => ({ name: names[i], value: values[i] }))
                            newField.enumType = newField.name
                        }
                        else console.warn('igVscEnum not found')
                    }

                    currentOffset = offset + size

                    return newField
                })

                return vscFields
            }
            else console.warn('igVscDataMetaObject not found')
        }
        else console.warn('VSC not found')
    }

    /**
     * Creates hex data cells for each 4 bytes of the object's data
     */
    createHexDataCells() {
        const bytesPerRow = 4 * 6

        Main.showObjectDataView(true)

        const tableCtn = elm('#data-table-ctn')
        const table = createElm('table', 'data-table')
        tableCtn.onmouseleave = () => this.onMouseLeave()
        tableCtn.appendChild(table)

        this.hexCells = []

        const createRow = (table, rowID) => {
            const row = createElm('tr')
            table.appendChild(row)

            const offsetCell = createElm('td')
            offsetCell.innerText = '0x' + (rowID * bytesPerRow).toString(16).toUpperCase().padStart(4, '0')
            offsetCell.classList.add('hex-offset')
            row.appendChild(offsetCell)

            return row
        }

        const createCell = (row, value, offset) => {
            const cell = createElm('td', 'hex-zero')
            row.appendChild(cell)

            if (value == null) {
                cell.style.color = 'transparent'
                cell.innerText = '00 00 00 00'
                return
            }

            cell.innerText = (value >>> 0).toString(16).toUpperCase().padStart(8, '0').replace(/(.{2})/g, '$1 ')
            
            if ((localStorage.getItem('big-endian') ?? 'true') === 'false') 
                cell.innerText = cell.innerText.split(' ').reverse().join(' ')

            // Create hex cell object
            const hexCell = { element: cell, offset }
            this.hexCells.push(hexCell)

            // Add mouse events
            cell.onclick = () => this.setSelected(hexCell.fields[0], hexCell)
            cell.onmouseover = () => {
                if (this.selected == null) 
                    this.onCellHover(hexCell)
            }
        }

        // Create default fields
        let objectSize = Main.igz.fixups.MTSZ.data[this.object.typeID]

        if (this.object.type == 'CVscComponentData') {
            const lastField = this.fields.reduce((a, b) => b.offset > a.offset ? b : a)
            const lastOffset = lastField.offset + lastField.size
            objectSize = lastOffset + (lastOffset % 4 == 0 ? 0 : 4 - (lastOffset % 4))
        }

        const rowCount = Math.ceil(objectSize / bytesPerRow)

        for (let i = 0; i < rowCount; i++) {
            const row = createRow(table, i)

            for (let k = 0; k < bytesPerRow; k += 4) {
                const offset = i * bytesPerRow + k
                if (offset > objectSize - 4) break

                const value = this.object.view.readInt(offset)
                createCell(row, value, offset)
            }
        }

        let additionalOffset = objectSize + (objectSize % 4 == 0 ? 0 : 4 - (objectSize % 4))

        for (const field of this.fields.filter(e => e.isMemoryType())) {
            if (!field.children.length) continue

            const table = createElm('table', 'data-table')
            const title = createElm('div', null, { marginLeft: '4px', marginTop: '4px', marginBottom: '2px' })
            title.innerText = field.name
            tableCtn.appendChild(title)
            tableCtn.appendChild(table)

            let row

            for (let i = 0; i < field.children.length; i++) {
                const size = Math.min(4, field.element_size)
                field.children[i].offset = Math.floor(additionalOffset/4)*4

                for (let k = 0; k < field.element_size; k += 4) {
                    const hexOffset = i * field.element_size + k

                    if (hexOffset % bytesPerRow == 0)
                        row = createRow(table, hexOffset)

                    const offset = field.children[i].ref_data_offset + k
                    const value = field.ref_object.view.readInt(offset)

                    if (additionalOffset % 4 == 0)
                        createCell(row, value, additionalOffset)

                    additionalOffset += size
                }
            }

            additionalOffset += (additionalOffset % 4) == 0 ? 0 : 4 - (additionalOffset % 4)

            const missingRows = bytesPerRow/4 - row.children.length + 1
            for (let i = 0; i < missingRows; i++) {
                createCell(row, null, additionalOffset)
            }
        }

        this.setupCellsAndFields()
        this.styleHexDataCells()
    }

    /**
     * Colorize hex cells based on the fields' type, colorization state and value
     */
    styleHexDataCells() {
        if (this.fields.length == 0) return

        // Loop through all fields and colorize corresponding hex cells
        for (let i = 0; i < this.fields.length; i++) {
            const field = this.fields[i]

            // If bitfield, colorize root cell with the first children only
            if (field.bitfield && field.offset - field.parent.offset > 0) continue

            const colorType = field.getColorClass()
            
            // Colorize corresponding data cells
            for (let j = 0; j < Math.ceil(field.size / 4); j++) {
                const cell = this.hexCells[Math.floor(field.offset / 4) + j]?.element
                if (cell == null) continue
                const isLong = field.isLongType()
                const method = 'read' + (isLong ? 'Int' : field.getIntegerMethod() ?? 'Int')
                const isMemoryChild = field.parent?.isMemoryType()
                const object = isMemoryChild ? field.ref_object : this.object
                const offset = isMemoryChild ? field.ref_data_offset : field.offset
                const value  = object.view[method](offset + j * 4)  >>> 0
                const isValid = value != 0 && value != 0xFFFFFFFF
                
                if ((field.colorized == null && isValid) || (field.colorized === true && (j == 0 || isValid))) {
                    cell.style.filter = 'brightness(1.1)'
                    cell.classList.remove('hex-zero')
                    cell.classList.add(colorType)
                }
                else if (value != 0) cell.style.filter = 'brightness(1.6)' 

                if (field.isUpdated(j) || isLong && field.isUpdated()) {
                    cell.classList.remove('hex-zero')
                    cell.classList.add('hex-updated')
                    cell.classList.add(colorType)
                }
            }
        }
    }

    /**
     * Create DOM elements for each field and add them to the container
     */
    createFieldList() {
        this.container.innerHTML = ''
        this.container.onmouseleave = () => this.onMouseLeave()
        Main.showObjectDataView(true)

        // Setup MemoryRef fields
        for (const field of this.fields) {
            if (field.type == 'igMemoryRefMetaField') {
                this.setupMemoryRefField(field)
            }
            else if (field.type == 'igVectorMetaField') {
                this.setupMemoryRefField(field, 8) // igVectors contains a igMemoryRef
            }
        }

        // Create all fields
        for (const [index, field] of Object.entries(this.fields)) {
            field.index = parseInt(index)

            const row = field.createField({
                onChange: this.onFieldUpdate.bind(this, field),
                onHover:  () => this.onFieldHover(field),
                onSelect: () => this.setSelected(field, field.hexCells[0]),
            })
            this.container.appendChild(row)
        }

        // Create list of object's references
        this.createReferenceList()
    }

    /**
     * Add object's references to the bottom of the field list
     */
    createReferenceList() {
        const div = createElm('div', 'ref-list')
        div.innerText = `References: (${this.object.references.length}) `
        this.container.appendChild(div)

        this.object.references.forEach(object => {
            const p = createElm('p', 'object-references')
            p.innerHTML = '&nbsp;&nbsp;⇒ ' + object.getDisplayName()
            p.onclick = () => {
                Main.objectView = new ObjectView(object)
                Main.focusObject(object.index)
            }
            div.appendChild(p)
        })
    }

    /**
     * Setup additional fields for MemoryRef children fields
     */
    setupMemoryRefField(field, igMemoryRefOffset = 0) {
        if (field.children) return

        const getMemoryInfos = (field) => {
            const memSize  = this.object.view.readUInt(field.offset + igMemoryRefOffset)
            const bitfield = this.object.view.readUInt(field.offset + igMemoryRefOffset + 4)

            const mem = {
                field,
                memSize,
                active: ((bitfield >> 0x18) & 0x1) != 0x0 && memSize > 0,
                dataOffset: this.object.view.readUInt(field.offset + igMemoryRefOffset + 8),
                elementSize: field.getTypeSize(field.memType),
            }
            mem.elementCount = mem.memSize / mem.elementSize
            mem.field.children = []
            mem.field.collapsable = true

            if (mem.active) {
                mem.object      = Main.igz.findObject(mem.dataOffset)
                mem.startOffset = Main.igz.getGlobalOffset(mem.dataOffset) - mem.object.global_offset
            }

            return mem
        }

        const addMemoryElement = (mem, index, offset) => {
            const field = new ObjectField({
                name:   `${mem.field.name} #${index}`,
                type:    mem.field.memType,
                refType: mem.field.elmType,
                size:    mem.elementSize,
                parent:  mem.field,
                object:  mem.object,
                offset:  offset,
                ref_object: mem.object,
                ref_data_offset: offset,
            })
            mem.field.children.push(field)
        }

        const updateField = (mem) => {
            if (mem == null) return
            mem.field.element_size    = mem.elementSize
            mem.field.memory_size     = mem.memSize
            mem.field.capacity        = mem.elementCount
            mem.field.element_count   = mem.field.children.length
            mem.field.ref_object      = mem.object
            mem.field.ref_data_offset = mem.startOffset
            mem.field.collapsable     = mem.field.element_count > 0
            mem.field.memory_active   = mem.active

            const fieldID = this.fields.indexOf(mem.field)
            this.fields = this.fields.slice(0, fieldID + 1).concat(mem.field.children).concat(this.fields.slice(fieldID + 1))
        }

        // Create values and keys(optional) MemoryRef fields
        const values   = getMemoryInfos(field)
        const keyField = this.fields.find(e => e.name === '_keys')
        const keys     = field.name === '_values' && keyField ? getMemoryInfos(keyField) : null

        if (keys && keys.elementCount != values.elementCount) console.warn('Value and keys count mismatch:', values.elementCount, keys.elementCount)

        // Hex view was originally made for displaying 4 continuous bytes at a time, but dictionaries keys and values 
        // are not always continuous, which is problematic when the element size is less than 4 bytes
        if (keys && Math.min(keys.elementSize, values.elementSize) < 4) 
            console.warn('Dictionary values element size < 4, data may be wrong in hex view', keys.field.memType, values.field.memType)

        // Add elements to the list(s)
        if (field.memType != 'void' && values.active)
            for (let k = 0, index = 0; k < values.elementCount; k++) {
                if (keys) {
                    const keyOffset = keys.startOffset + k * keys.elementSize
                    const method = keyField.getIntegerMethod(keys.field.memType)?.replace('Long', 'Int') ?? 'Int'
                    const key = keys.object.view['read' + method](keyOffset)

                    // Skip invalid keys
                    // TODO: Include missing types fixup lookup
                    if (keys.field.isStringType(keys.field.memType)) {
                        if (!Main.igz.fixups.RSTT?.data.includes(keys.object.offset + keyOffset)) continue
                    }
                    else if (keys.field.isIntegerType(keys.field.memType) && key >>> 0 == 0xFAFAFAFA) continue
                    else if (key == 0) continue

                    addMemoryElement(keys, index, keyOffset) // Add key
                }

                const valueOffset = values.startOffset + k * values.elementSize
                addMemoryElement(values, index++, valueOffset) // Add value
            }

        updateField(values)
        updateField(keys)
    }

    // Update an object's data when a field is modified
    // Apply changes to all objects if the "Apply to all" checkbox is checked
    onFieldUpdate(field, value, id) {
        const searchMatches = Main.tree.matched()

        if (elm('#apply-all-checkbox').checked && searchMatches.length > 0) {
            
            if (field.ref_object)
                return ipcRenderer.send('show-warning-message', 'Multi-object editing not supported for memory fields.')

            searchMatches.each((e, i) => {
                const object = Main.igz.objects[e.objectIndex]
                field.updateObject(object, value, i == 0, id)
            })
        }
        else {
            field.updateObject(this.object, value, true, id)
        }

        const saveCellIDs = field.hexCells.map(e => this.hexCells.indexOf(e))

        field.refreshNameStyle()
        this.createHexDataCells()
        this.onFieldHover(field)
        this.lastEditTime = Date.now()

        saveCellIDs.forEach(e => this.hexCells[e].element.classList.add('hex-flash')) // Flashing animation

        Main.igz.updated = true
        if (Main.pak) Main.pak.updated = true

        Main.updateTitle()
        Main.colorizeMainTree()
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
            let firstValue = null

            if (field.children) continue
            if (this.object.type == 'CVscComponentData' && i > 4) continue

            if (field.bitfield) {
                const bytes = allObjects[0].view.readInt(field.offset)
                firstValue = bitRead(bytes, field.bits, field.shift)
            }
            else {
                firstValue = allObjects[0].view.readBytes(field.size, field.offset)
            }

            for (let j = 1; j < allObjects.length; j++) {
                let interesting = false

                if (field.bitfield) {
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

    // Sets the currently selected field and cell
    setSelected(field, cell, forceSelect = false) {
        // Reset selection if clicked on the same field/cell
        this.selected = this.selected != null && (this.selected.field === field || this.selected.cell === cell) ? null : { field, cell }

        // Select parent field if current field is collapsed
        if (this.selected?.field?.collapsed && this.selected?.field.parent) this.selected.field = this.selected.field.parent

        // Update css
        this.fields.forEach(e => {
            if (e === this.selected?.field) e.element.classList.add('selected')
            else e.element.classList.remove('selected')
        })
        this.hexCells.forEach(e => {
            if (e === this.selected?.cell) e.element.classList.add('selected')
            else e.element.classList.remove('selected')
        })

        this.onCellHover(cell, forceSelect)
    }

    onFieldHover(field) {
        if (Date.now() - this.lastEditTime < 100) return // Prevent focusing another field just after closing a dropdown

        // Update field list
        this.fields.forEach(e => {
            e.element.style.filter = e === this.selected?.field || e === field ? 'brightness(1.7)' : ''
        })

        // Update hex cells
        this.hexCells.forEach(e => {
            e.element.style.backgroundColor = field.hexCells.includes(e) ? this.hoverColor : ''
        })

        field.hexCells[0]?.element.parentNode.scrollIntoViewIfNeeded()
    }

    onCellHover(cell, forceSelect = false) {
        // Update field list
        this.fields.forEach(e => {
            e.element.style.filter = e.hexCells.includes(cell) ? 'brightness(1.7)' : ''
        })

        // Update hex cells
        let cellsToHighlight = []

        if (cell?.fields.length > 0) {
            cell.fields[0].element.scrollIntoViewIfNeeded()
            cellsToHighlight = cell.fields[0].hexCells
        }
        if (cellsToHighlight.length === 0 && forceSelect && cell) cellsToHighlight = [cell]

        this.hexCells.forEach(e => {
            e.element.style.backgroundColor = cellsToHighlight.includes(e) ? this.hoverColor : ''
        })
    }

    onMouseLeave() {
        // Focus currently selected field
        if (this.selected?.field) 
            this.onFieldHover(this.selected.field)
        // Otherwise reset all styles
        else {
            this.hexCells.forEach(e => e.element.style.backgroundColor = '')
            this.fields.forEach(e => e.element.style.filter = '')
        }
    }

    // On parent igz save
    onSave() {
        document.activeElement?.blur()
        clearUpdatedData()
        this.createHexDataCells()
        this.fields.forEach(e => e.refreshNameStyle())
    }
}

export default ObjectView