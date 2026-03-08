// main.js

const { PluginSettingTab, Setting, Plugin, Notice, ItemView, TFolder, TFile } = require("obsidian");

const VIEW_TYPE_LINK_AUDIT = "link-audit-view";
const VIEW_TYPE_LINK_FOLDERS = "folders-audit-view";

module.exports = class LinkAuditPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    new Notice("Plugin LinkAudit activado");

    this.registerView(
      VIEW_TYPE_LINK_AUDIT,
      (leaf) => new LinkAuditView(leaf, this)
    );

    this.registerView(
      VIEW_TYPE_LINK_FOLDERS,
      (leaf) => new FoldersAuditView(leaf, this)
    );

    this.addCommand({
      id: "open-link-audit",
      name: "Auditar archivos sin referencias",
      callback: () => {
        const folder = this.settings.lastSelectedFolder;
        if (folder) {
          this.openAuditView(folder);
        } else {
          new Notice("Selecciona una carpeta primero en Settings → LinkAudit.");
        }
      }
    });

    this.addCommand({
      id: "open-folders-audit",
      name: "Auditar carpetas vacías",
      callback: () => this.openEmptyFolderAuditView()
    });

    this.addRibbonIcon("link", "LinkAudit – Archivos sin referencias", () => {
      const folder = this.settings.lastSelectedFolder;
      if (folder) {
        this.openAuditView(folder);
      } else {
        new Notice("Selecciona una carpeta primero en Settings → LinkAudit.");
      }
    });

    this.addSettingTab(new LinkAuditSettingTab(this.app, this));
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_LINK_AUDIT);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_LINK_FOLDERS);
    new Notice("Plugin LinkAudit desactivado");
  }

  async loadSettings() {
    this.settings = Object.assign(
      { showReferenced: false, lastSelectedFolder: "" },
      await this.loadData()
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async getFolderPaths() {
    const folderSet = new Set();
    const files = this.app.vault.getFiles();
    for (const file of files) {
      const parts = file.path.split("/");
      if (parts.length > 1) {
        folderSet.add(parts.slice(0, -1).join("/"));
      }
    }
    return Array.from(folderSet).sort();
  }

  async getOrphanFiles(targetFolder, onProgressUpdate) {
    const allFilesInFolder = this.app.vault.getFiles()
      .filter(f => f.path.startsWith(targetFolder + "/"))
      .filter(f => f.name !== "Tasks.md")
      .filter(f => !f.name.includes(".highlights"));

    const allMarkdownFiles = this.app.vault.getMarkdownFiles()
      .filter(f => f.name !== "Tasks.md")
      .filter(f => !f.name.includes(".highlights"));

    const allCached = allMarkdownFiles
      .map(f => this.app.metadataCache.getFileCache(f))
      .filter(Boolean);

    const allLinks = new Set();

    for (const cache of allCached) {
      if (cache.links) {
        for (const link of cache.links) {
          allLinks.add(link.link.trim());
        }
      }
      if (cache.embeds) {
        for (const embed of cache.embeds) {
          allLinks.add(embed.link.trim());
        }
      }
    }

    const orphanFiles = [];
    const referencedFiles = [];

    for (let i = 0; i < allFilesInFolder.length; i++) {
      const file = allFilesInFolder[i];
      if (onProgressUpdate) onProgressUpdate(i + 1, allFilesInFolder.length);

      const fileName = file.basename;
      const fullPath = file.path.replace(/\.md$/, "");

      const variants = new Set([
        fileName,
        file.name,
        fullPath,
        file.path,
        file.path.replace(/\\/g, "/"),
      ]);

      const referenced = [...variants].some(variant => allLinks.has(variant));

      if (!referenced) {
        orphanFiles.push(file);
      } else if (this.settings.showReferenced) {
        referencedFiles.push(file);
      }
    }

    return {
      orphanFiles,
      referencedFiles,
      totalAnalyzed: allFilesInFolder.length,
    };
  }

  async getEmptyFolders() {
    const emptyFolders = [];

    const isFolderEmpty = (folder) => {
      const children = folder.children;
      const hasFiles = children.some(child => child instanceof TFile);
      if (hasFiles) return false;
      const subfolders = children.filter(child => child instanceof TFolder);
      return subfolders.every(sub => isFolderEmpty(sub));
    };

    const visitFolder = (folder) => {
      if (isFolderEmpty(folder)) {
        emptyFolders.push(folder.path);
      } else {
        for (const child of folder.children) {
          if (child instanceof TFolder) {
            visitFolder(child);
          }
        }
      }
    };

    const root = this.app.vault.getRoot();
    for (const child of root.children) {
      if (child instanceof TFolder) {
        visitFolder(child);
      }
    }

    return emptyFolders.sort();
  }

  async openAuditView(folderPath) {
    if (!folderPath) {
      new Notice("No se ha seleccionado ninguna carpeta.");
      return;
    }

    this.lastSelectedFolder = folderPath;

    this.settings.lastSelectedFolder = folderPath;
    await this.saveSettings();

    this.app.workspace.detachLeavesOfType(VIEW_TYPE_LINK_AUDIT);

    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_LINK_AUDIT,
      active: true,
      state: {},
    });

    this.app.workspace.revealLeaf(leaf);
  }

  async openEmptyFolderAuditView() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_LINK_FOLDERS);

    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_LINK_FOLDERS,
      active: true,
      state: {},
    });

    this.app.workspace.revealLeaf(leaf);
  }
};

class LinkAuditView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_LINK_AUDIT;
  }

  getDisplayText() {
    return "Archivos sin referencias";
  }

  getIcon() {
    return "link";
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("link-audit-container");

    const folderPath = this.plugin.lastSelectedFolder;

    if (!folderPath) {
      container.createEl("p", { text: "No se ha seleccionado carpeta para revisar." });
      return;
    }

    const statusEl = container.createEl("p", { text: "Iniciando revisión..." });

    const { orphanFiles, referencedFiles, totalAnalyzed } = await this.plugin.getOrphanFiles(folderPath, (current, total) => {
      statusEl.textContent = `Revisando archivo ${current} de ${total}...`;
    });

    container.empty();
    container.createEl("h2", { text: `Archivos sin referencias en: ${folderPath}` });
    container.createEl("p", { text: `Total de archivos analizados: ${totalAnalyzed}` });

    if (orphanFiles.length === 0) {
      container.createEl("p", { text: "Todos los archivos están referenciados." });
    } else {
      container.createEl("p", {
        text: `${orphanFiles.length} archivo(s) sin referencias encontradas:`
      });

      const list = container.createEl("ul");
      orphanFiles.forEach(file => {
        const item = list.createEl("li");
        const link = item.createEl("a", { text: file.path, href: "#" });
        link.addEventListener("click", (e) => {
          e.preventDefault();
          this.app.workspace.openLinkText(file.path, "", false);
        });
      });
    }

    if (this.plugin.settings.showReferenced && referencedFiles.length > 0) {
      container.createEl("p", { text: `${referencedFiles.length} archivo(s) con referencias encontradas:` });

      const refList = container.createEl("ul");
      referencedFiles.forEach(file => {
        const item = refList.createEl("li");
        const link = item.createEl("a", { text: file.path, href: "#" });
        link.addEventListener("click", (e) => {
          e.preventDefault();
          this.app.workspace.openLinkText(file.path, "", false);
        });
      });
    }
  }

  onClose() {
    this.containerEl.children[1].empty();
  }
}

class FoldersAuditView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_LINK_FOLDERS;
  }

  getDisplayText() {
    return "Carpetas vacías";
  }

  getIcon() {
    return "folder";
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("folders-audit-container");

    container.createEl("h2", { text: "Carpetas vacías sin archivos Markdown" });

    const folders = await this.plugin.getEmptyFolders();

    if (folders.length === 0) {
      container.createEl("p", { text: "No se encontraron carpetas vacías." });
    } else {
      container.createEl("p", { text: `Total: ${folders.length} carpeta(s) vacía(s).` });

      const list = container.createEl("ul");
      folders.forEach(folder => {
        list.createEl("li", { text: folder });
      });
    }

    container.createEl("h2", { text: "Todas las carpetas encontradas en el vault" });

    const files = this.app.vault.getFiles();
    const allFolders = new Set();

    for (const file of files) {
      const parts = file.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        allFolders.add(parts.slice(0, i).join("/"));
      }
    }

    const sortedFolders = Array.from(allFolders).sort();
    container.createEl("p", { text: `Total de carpetas: ${sortedFolders.length}` });

    const fullList = container.createEl("ul");
    sortedFolders.forEach(folder => {
      fullList.createEl("li", { text: folder });
    });
  }

  onClose() {
    this.containerEl.children[1].empty();
  }
}

class LinkAuditSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "LinkAudit – Opciones de Auditoría" });

    const folders = await this.plugin.getFolderPaths();

    let selectedFolder = this.plugin.settings.lastSelectedFolder || folders[0] || "";

    new Setting(containerEl)
      .setName("Carpeta a revisar")
      .setDesc("Selecciona la carpeta cuyos archivos serán verificados.")
      .addDropdown(dropdown => {
        folders.forEach(folder => {
          dropdown.addOption(folder, folder);
        });
        dropdown.setValue(selectedFolder);
        dropdown.onChange(value => selectedFolder = value);
      })
      .addButton(btn => {
        btn.setButtonText("Buscar")
          .setCta()
          .onClick(() => {
            if (selectedFolder) {
              this.plugin.openAuditView(selectedFolder);
            } else {
              new Notice("Selecciona una carpeta primero.");
            }
          });
      });

    new Setting(containerEl)
      .setName("Mostrar archivos con referencias")
      .setDesc("Si se activa, también se mostrarán los archivos referenciados.")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.showReferenced)
          .onChange(async (value) => {
            this.plugin.settings.showReferenced = value;
            await this.plugin.saveSettings();

            const leaves = this.app.workspace.getLeavesOfType("link-audit-view");
            if (leaves.length > 0) {
              await leaves[0].view.onOpen();
            }
          })
      );

    new Setting(containerEl)
      .setName("Revisar carpetas")
      .setDesc("Buscar carpetas que no contienen archivos Markdown.")
      .addButton(btn =>
        btn
          .setButtonText("Verificar carpetas vacías")
          .setCta()
          .onClick(() => {
            this.plugin.openEmptyFolderAuditView();
          })
      );
  }
}