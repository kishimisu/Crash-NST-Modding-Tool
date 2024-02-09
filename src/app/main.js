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
 * Main entry point
 */
app.whenReady().then(() => {
    // Setup IPC events
    ipcMain.handle('open-file', showOpenFileDialog)
    ipcMain.handle('save-file', showSaveFileDialog)
    ipcMain.handle('open-folder', showOpenFolderDialog)
    ipcMain.handle('eval-calculation', evalCalculation)
    ipcMain.handle('create-import-modal', createImportModal)
    ipcMain.on('set-progress-bar', setProgressBar)
    
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
                    label: 'Save And Launch',
                    accelerator: 'CmdOrCtrl+L',
                    click: () => win.webContents.send('menu-save-launch'),
                },
                { 
                    label: 'Revert Level',
                    accelerator: 'CmdOrCtrl+Shift+R',
                    click: () => win.webContents.send('menu-revert'),
                    
                }, {
                    type: 'separator',
                }, {
                    role: 'quit'
                }
            ]
        },
        {
            label: 'Settings',
            submenu: [
                {
                    label: 'Change game folder path',
                    click: () => win.webContents.send('menu-change-game-folder')
                },
                {
                    label: 'Backup game folder',
                    click: () => win.webContents.send('menu-backup-game-folder')
                },
                {
                    label: 'Restore game folder',
                    click: () => win.webContents.send('menu-restore-game-folder')
                },
                {
                    type: 'separator'
                },
                {
                    label: 'Open dev tools',
                    click: () => win.webContents.openDevTools()
                }
            ]
        },
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
        }
    ]

    win.setMenu(Menu.buildFromTemplate(menu_template))
    win.loadURL(MAIN_WINDOW_WEBPACK_ENTRY)
    if (process.env.NODE_ENV === 'development') win.webContents.openDevTools()

    win.once('ready-to-show', () => {
        win.webContents.once("did-finish-load", () => {
            win.show()
        })
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
        child.webContents.once("did-finish-load", () => {
            child.show()
        })
    })

    return new Promise((resolve, reject) => {
        ipcMain.once('on-file-select', (event, fileIndex, importDeps) => {
            child.destroy()
            resolve([fileIndex, importDeps])
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
function showOpenFileDialog(event, extensions = ['pak', 'igz']) {
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
 * Shows the OS folder selection dialog
 * 
 * @returns the path to the selected folder
 */
function showOpenFolderDialog() {
    const filePath = dialog.showOpenDialogSync({ properties: ['openDirectory'] })
    return filePath ? filePath[0] : null
}

/**
 * Shows the OS file save dialog
 * 
 * @param {String} extension Enabled file extension
 * @returns the path to the saved file
 */
function showSaveFileDialog(event, extension = 'pak') {
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
function setProgressBar(event, file_path, current_file, file_count, message) {
    if (progressBar == null) {
        progressBar = new ProgressBar({
            title: 'Saving to ' + file_path + '...',
            detail: message,
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