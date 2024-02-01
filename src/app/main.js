const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron')
const path = require('path');
const fs = require('fs')
const ProgressBar = require('electron-progressbar')

let win, progressBar

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
    app.quit();
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

/**
 * Creates the data/ directory
 */
function initDirectory() {
    const dataPath = path.join('.', 'data')
    const tmpPath = path.join('.', 'data', 'tmp')

    // Create data/ folder if it doesn't exist
    if(!fs.existsSync(dataPath)) 
        fs.mkdirSync(dataPath)

    // Remove data/tmp/ folder if it exists
    else if (fs.existsSync(tmpPath)) {
        fs.rmSync(tmpPath, { recursive: true })
    }

    // Create data/tmp/ folder
    fs.mkdirSync(tmpPath)
}

/** 
 * Main entry point
 */
app.whenReady().then(() => {
    // Setup IPC events
    ipcMain.handle('open-file', showOpenDialog)
    ipcMain.handle('save-file', showSaveDialog)
    ipcMain.handle('eval-calculation', evalCalculation)
    ipcMain.handle('create-import-modal', createImportModal)
    ipcMain.on('set-progress-bar', setProgressBar)
    
    initDirectory()
    createMainWindow()
  
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow()
        }
    })
})

/**
 * Creates the main window
 */
function createMainWindow() {
    win = new BrowserWindow({
        width: 1400,
        height: 800,
        show: false,
        webPreferences: {
            // preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
            additionalArguments: [ "main_window" ],
            sandbox: false,
            devTools: true,

            nodeIntegration: true,
            contextIsolation: false
        }
    })

    // Build the menu
    const menu_template = [
        {
            label: 'File',
            submenu: [
                { 
                    label: 'Open',
                    accelerator: 'CmdOrCtrl+O',
                    click: () => win.webContents.send('menu-open'),
                }, { 
                    label: 'Import',
                    accelerator: 'CmdOrCtrl+I',
                    click: () => win.webContents.send('menu-import'),
                }, { 
                    label: 'Reload',
                    accelerator: 'CmdOrCtrl+R',
                    click: () => win.webContents.send('menu-reload'),
                }, {
                    type: 'separator',
                }, { 
                    label: 'Save',
                    accelerator: 'CmdOrCtrl+S',
                    click: () => win.webContents.send('menu-save'),
                }, { 
                    label: 'Save As',
                    accelerator: 'CmdOrCtrl+Shift+S',
                    click: () => win.webContents.send('menu-save-as'),
                }, { 
                    label: 'Revert to original',
                    accelerator: 'CmdOrCtrl+Shift+R',
                    click: () => win.webContents.send('menu-revert'),
                    
                }, {
                    type: 'separator',
                }, {
                    role: 'close'
                }, {
                    role: 'quit'
                }
            ]
        }]

        if (process.env.NODE_ENV === 'development') {  
            menu_template.push({ role: 'viewMenu' })
        }

        menu_template.push(
            {
                role: 'windowMenu'
            }, 
            {
                label: 'About',
                submenu: [
                    {
                        label: 'README.md',
                        click: () => shell.openExternal('https://github.com/kishimisu/Crash-NST-Modding-Tool/blob/main/README.md')
                    },
                    {
                        label: 'Contribute on Github!',
                        click: () => shell.openExternal('https://github.com/kishimisu/Crash-NST-Modding-Tool')
                    }
                ]
            })

    win.setMenu(Menu.buildFromTemplate(menu_template))
    win.loadURL(MAIN_WINDOW_WEBPACK_ENTRY)
    if (process.env.NODE_ENV === 'development') win.webContents.openDevTools()

    win.once('ready-to-show', () => {
        win.show()
    })
}

/**
 * Creates an import modal window
 */
function createImportModal(event, props) {
    const child = new BrowserWindow({
        parent: win,
        modal: true,
        show: false,
        webPreferences: {
            // preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
            devTools: true,
            sandbox: false,

            nodeIntegration: true,
            contextIsolation: false
        }
    })

    child.removeMenu()
    child.loadURL(MAIN_WINDOW_WEBPACK_ENTRY)
    // child.webContents.openDevTools()

    child.webContents.once('dom-ready', () => {
        child.webContents.send('init-import-modal', props)
    })

    child.once('ready-to-show', () => {
        child.setTitle('Import from ' + props.file_path)
        child.show()
    })

    return new Promise((resolve, reject) => {
        ipcMain.once('on-file-select', (event, fileIndex) => {
            child.destroy()
            resolve(fileIndex)
        })

        child.on('close', () => {
            resolve(null)
        })
    })
}

/**
 * Shows the OS file selection dialog
 * 
 * @param {String[]} extensions Array of enabled file extensions
 * @returns the path to the selected file
 */
function showOpenDialog(event, extensions = ['pak', 'igz']) {
    const filePath = dialog.showOpenDialogSync({
        properties: ['openFile'],
        filters: [
            { 
                name: extensions.map(e => '.' + e).join('/') + ' files', 
                extensions
            },
        ]
    })

    return filePath ? filePath[0] : null
}

/**
 * Shows the OS file save dialog
 * 
 * @param {String} extension Enabled file extension
 * @returns the path to the saved file
 */
function showSaveDialog(event, extension = 'pak') {
    const filePath = dialog.showSaveDialogSync({
        filters: [
            { 
                name: '.' + extension + ' files', 
                extensions: [ extension ]
            },
        ]
    })

    return filePath
}

/**
 * Updates the current progress bar window when saving a .pak file
 * Creates a new progress bar if it doesn't exist.
 * 
 * @param {String} file_path Path to the file being saved 
 * @param {*} current_file Number of files written so far
 * @param {*} file_count Total files to write
 */
function setProgressBar(event, file_path, current_file, file_count) {
    if (progressBar == null) {
        progressBar = new ProgressBar({
            title: 'Saving to ' + file_path + '...',
            detail: 'This will take some time on the first time saving a new archive.',
            maxValue: 1,
            indeterminate: false,
            browserWindow: {
                parent: win,
                // closable: true,
            }
        })
        // progressBar.on('aborted', function() {});
    }

    const progress = (current_file + 1) / file_count
    progressBar.value = progress
    progressBar.text = `${current_file} / ${file_count} files written. (${(progress * 100).toFixed(2)}%)`

    if (progress == 1) {
        progressBar.setCompleted()
        progressBar = null
    }

    win.setProgressBar(progress == 1 ? 0 : progress)
}

function evalCalculation(event, calculation) {
    return eval(calculation)
}