const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("linkedinBuilder", {
  selectHtmlTemplate: () =>
    ipcRenderer.invoke("dialog:selectFile", {
      filters: [{ name: "HTML", extensions: ["html", "htm"] }]
    }),
  selectCssFile: () =>
    ipcRenderer.invoke("dialog:selectFile", {
      filters: [{ name: "CSS", extensions: ["css"] }]
    }),
  selectImages: () => ipcRenderer.invoke("dialog:selectImages"),
  selectImageFolder: () => ipcRenderer.invoke("dialog:selectImageFolder"),
  getSamplePaths: () => ipcRenderer.invoke("app:getSamplePaths"),
  startExport: (payload) => ipcRenderer.invoke("export:start", payload),
  openFolder: (folderPath) => ipcRenderer.invoke("folder:open", folderPath)
});
